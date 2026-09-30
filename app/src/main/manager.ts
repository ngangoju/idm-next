/**
 * The download manager: owns every live Download, the queues, and the record
 * list the UI renders. Deliberately free of Electron imports so it can be
 * tested under plain Node.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { exec } from 'node:child_process';
import {
  Download,
  TokenBucket,
  journalPath,
  partPath,
  hashFile,
  probe,
  makeDispatcher,
  fileSize,
  moveNoClobber,
  removeWorkingFile,
} from '@idm-next/core';
import type { ProgressSnapshot } from '@idm-next/core';
import { Store } from './store.ts';
import { YtDlp, remuxIfMislabelled, type Extraction } from './ytdlp.ts';
import {
  categoryFor,
  type AddDownloadRequest,
  type Category,
  type DownloadRecord,
  type ProbeResponse,
  type Queue,
  type Settings,
} from '../shared/protocol.ts';

export interface ManagerEvents {
  added: [DownloadRecord];
  progress: [DownloadRecord[]];
  done: [DownloadRecord];
  failed: [{ id: string; error: string }];
  removed: [{ id: string }];
  restarted: [DownloadRecord];
  'queue-drained': [Queue];
  settings: [Settings];
}

export class DownloadManager extends EventEmitter<ManagerEvents> {
  private readonly store: Store;
  private readonly live = new Map<string, Download>();
  private readonly globalBucket: TokenBucket;
  private progressTimer: NodeJS.Timeout | null = null;
  private dirtyProgress = new Set<string>();
  /** Live yt-dlp children, so they can be stopped on pause/cancel. */
  private readonly external = new Map<string, AbortController>();

  constructor(store: Store) {
    super();
    this.store = store;
    this.globalBucket = new TokenBucket(store.settings.globalRateBps);
  }

  private get ytdlp(): YtDlp {
    return new YtDlp(this.store.settings.ytdlpPath, this.store.settings.ffmpegPath);
  }

  /** List what is downloadable at a page URL. */
  async extract(url: string): Promise<Extraction> {
    return this.ytdlp.extract(url);
  }

  async ytdlpStatus(): Promise<{ ok: boolean; version?: string; error?: string }> {
    return this.ytdlp.available();
  }

  get records(): DownloadRecord[] {
    return this.store.data.downloads;
  }

  get queues(): Queue[] {
    return this.store.data.queues;
  }

  get settings(): Settings {
    return this.store.settings;
  }

  /**
   * On launch, anything that was mid-flight is marked paused rather than
   * resumed automatically — the user may have quit deliberately, and silently
   * saturating their connection at startup is hostile. The journals are intact,
   * so resume is one click.
   */
  async init(): Promise<void> {
    this.store.update((s) => {
      for (const d of s.downloads) {
        if (d.status === 'downloading' || d.status === 'probing') {
          d.status = 'paused';
          d.rateBps = 0;
        }
      }
    });
    this.startProgressPump();
  }

  destDirFor(category: Category): string {
    const { downloadDir, categoryDirs } = this.store.settings;
    return categoryDirs[category] ?? join(downloadDir, category);
  }

  /** Check a URL is fetchable. The extension calls this before it cancels. */
  async probeUrl(url: string, headers?: Record<string, string>): Promise<ProbeResponse> {
    try {
      const dispatcher = makeDispatcher({ proxy: this.store.settings.proxy ?? undefined });
      const info = await probe({ url, headers, dispatcher });
      return {
        ok: true,
        // Only claim takeover when the server proved it supports ranges. A
        // one-time or POST-gated URL that 403s on refetch must not reach the
        // point where the browser's own download gets cancelled.
        canTakeOver: info.resumable && info.totalSize !== null,
        totalSize: info.totalSize,
        filename: info.suggestedName,
        contentType: info.contentType,
        ...(info.resumable ? {} : { reason: 'server did not honour a ranged request' }),
      };
    } catch (err) {
      return {
        ok: false,
        canTakeOver: false,
        totalSize: null,
        filename: null,
        contentType: null,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  add(req: AddDownloadRequest): DownloadRecord {
    const viaYtdlp = req.useYtdlp ?? looksLikePage(req.url);
    // The last path segment of a page URL is not a filename — every YouTube
    // download would be called "watch". Say so until yt-dlp reports the title.
    const filename = req.filename ?? (viaYtdlp ? pageLabel(req.url) : guessName(req.url));
    const category = viaYtdlp && !req.filename ? 'video' : categoryFor(filename);
    const destDir = req.destDir ?? this.destDirFor(category);

    const record: DownloadRecord = {
      id: randomUUID(),
      url: req.url,
      filename,
      filePath: join(destDir, filename),
      destDir,
      category,
      status: 'paused',
      totalSize: null,
      downloaded: 0,
      rateBps: 0,
      etaSeconds: null,
      segments: [],
      connections: req.connections ?? this.store.settings.defaultConnections,
      queueId: req.queueId ?? null,
      createdAt: new Date().toISOString(),
      ...(req.sourcePage ? { sourcePage: req.sourcePage } : {}),
      ...(req.checksum ? { checksum: req.checksum } : {}),
      ...(req.formatId ? { formatId: req.formatId } : {}),
      // An explicit flag wins; otherwise guess from the URL now and correct it
      // from the probe's content type once the download actually starts.
      useYtdlp: viaYtdlp,
      ...(req.useYtdlp === undefined && viaYtdlp && !isStreamManifest(req.url)
        ? { routeUnverified: true }
        : {}),
    };

    this.store.update((s) => {
      s.downloads.unshift(record);
      if (record.queueId) {
        s.queues.find((q) => q.id === record.queueId)?.items.push(record.id);
      }
    });

    // Start first, announce second. The record is built `paused` because that
    // is its state until something starts it, and announcing at that point told
    // every listener "this one is queued" even for a download already running —
    // which is why nothing could tell a starting transfer from a parked one.
    // resume() only emits through the batched progress tick, so an 'added'
    // emitted synchronously after it still reaches clients first.
    if (!req.startPaused) this.resume(record.id, req.headers);
    this.emit('added', record);
    return record;
  }

  resume(id: string, headers?: Record<string, string>): void {
    const record = this.records.find((d) => d.id === id);
    // Either kind of transfer already running: a second one would race it for
    // the same file.
    if (!record || this.live.has(id) || this.external.has(id)) return;
    if (record.status === 'completed') return;

    if (this.activeCount >= this.store.settings.maxConcurrentDownloads) {
      // Over the concurrency budget: leave it queued and let a completion
      // pull it in.
      this.setStatus(id, 'paused');
      return;
    }

    // "Looks like a page" was only a guess from the URL, and an extensionless
    // path is as often a file as a page — X serves every image from
    // /media/<id>. Ask the server first; yt-dlp turned those into
    // "<id>.unknown_video".
    if (record.useYtdlp && record.routeUnverified) {
      void this.verifyRoute(record, headers);
      return;
    }

    // A page (or an adaptive stream) has to go through yt-dlp; only a direct
    // file can use our segmented engine.
    if (record.useYtdlp) {
      void this.runExternal(record, headers);
      return;
    }

    const dl = new Download(
      {
        url: record.url,
        destDir: record.destDir,
        filename: record.filename,
        owner: record.id,
        connections: record.connections,
        ...(headers ? { headers } : {}),
        ...(this.store.settings.proxy ? { proxy: this.store.settings.proxy } : {}),
      },
      this.globalBucket,
    );

    this.live.set(id, dl);
    this.setStatus(id, 'downloading');

    dl.on('progress', (p: ProgressSnapshot) => this.onProgress(id, p));
    dl.on('done', () => void this.onDone(id, dl));
    dl.on('error', (err: Error) => this.onError(id, err));
    dl.on('stale', ({ reason }) => this.onError(id, new Error(`Remote file changed: ${reason}`)));

    void dl.start();
  }

  /**
   * Settle a guessed route by asking the server what the URL actually is.
   *
   * Held in `external` while it runs, so it counts against the concurrency
   * budget and a pause or cancel in the meantime stops it like any transfer.
   */
  private async verifyRoute(
    record: DownloadRecord,
    headers?: Record<string, string>,
  ): Promise<void> {
    const controller = new AbortController();
    this.external.set(record.id, controller);
    this.setStatus(record.id, 'probing');

    let route: 'engine' | 'ytdlp' = 'ytdlp';
    try {
      const dispatcher = makeDispatcher({ proxy: this.store.settings.proxy ?? undefined });
      const info = await probe({ url: record.url, headers, dispatcher, signal: controller.signal });
      route = routeFor(info.contentType);
    } catch {
      // Pages often refuse a ranged probe. Keep the guess: yt-dlp will say
      // plainly if it cannot handle the URL either.
    }

    if (controller.signal.aborted) return;
    this.external.delete(record.id);

    this.store.update((s) => {
      const d = s.downloads.find((x) => x.id === record.id);
      if (!d) return;
      delete d.routeUnverified;
      if (route === 'engine') {
        d.useYtdlp = false;
        // "Video from x.com" was a placeholder for a page; this is a file. The
        // folder was chosen for that guess too — only move it if it is still
        // the guess's default, never one the user picked.
        if (d.filename === pageLabel(d.url)) {
          const guessedDir = d.destDir === this.destDirFor('video');
          d.filename = guessName(d.url);
          d.category = categoryFor(d.filename);
          if (guessedDir) d.destDir = this.destDirFor(d.category);
          d.filePath = join(d.destDir, d.filename);
        }
      }
    });

    this.resume(record.id, headers);
  }

  /**
   * Download via yt-dlp. Used for pages and adaptive streams, where there is no
   * single ranged URL for our engine to work with.
   */
  private async runExternal(
    record: DownloadRecord,
    // The page's cookies and referer, from the extension. Not yet passed on,
    // so yt-dlp runs logged out — why private and logged-in media fails.
    // yt-dlp needs cookies as a Netscape file, not a header (a Cookie header
    // would be replayed to every host a redirect reaches); see plan Phase 2.4.
    _headers?: Record<string, string>,
  ): Promise<void> {
    const controller = new AbortController();
    this.external.set(record.id, controller);
    this.setStatus(record.id, 'downloading');

    try {
      // Download into a private staging directory, then move the result into
      // place under a collision-free name. yt-dlp picks the filename itself
      // (it only learns the extension mid-download), so without this a second
      // download of the same stream silently overwrites the first.
      const staging = join(record.destDir, `.idm-staging-${record.id}`);
      await mkdir(staging, { recursive: true });

      await this.ytdlp.download({
        url: record.url,
        destDir: staging,
        ...(record.formatId ? { formatId: record.formatId } : {}),
        signal: controller.signal,
        onTitle: (title) => {
          this.store.update((st) => {
            const d = st.downloads.find((x) => x.id === record.id);
            if (!d || !title) return;
            d.filename = title;
            // "watch" told the user nothing and put every video in Other.
            if (d.category === 'other') d.category = 'video';
          });
          this.dirtyProgress.add(record.id);
        },
        onProgress: (p) => {
          this.store.update((s) => {
            const d = s.downloads.find((x) => x.id === record.id);
            if (!d) return;
            d.downloaded = p.downloaded;
            d.totalSize = p.total;
            d.rateBps = p.speed ?? 0;
            d.etaSeconds = p.eta;
            d.status = 'downloading';
          });
          this.dirtyProgress.add(record.id);
        },
      });

      this.external.delete(record.id);

      // Trust the staging directory, not the printed path.
      //
      // --print after_move can stay silent (a skipped file), and it can also
      // name a path that no longer exists — a merge renames its inputs, and
      // any stdout line beginning with a slash looks like a path. Renaming a
      // file we never confirmed produced "ENOENT: no such file or directory"
      // at the very end of an otherwise successful download.
      const produced = await resolveProduced(staging);
      if (!produced) throw new Error('yt-dlp finished but produced no file');

      await remuxIfMislabelled(
        produced,
        this.store.settings.ffmpegPath,
        this.store.settings.ffmpegPath.replace(/ffmpeg$/, 'ffprobe'),
      ).catch(() => undefined);

      // Claim the name and place the file in one step: checking for a free
      // name first and renaming after left a window in which a file of the
      // same name could appear — and rename would have replaced it.
      const finalPath = await moveNoClobber(
        produced,
        join(record.destDir, basename(produced)),
        record.id,
      );
      await removeWorkingFile(staging, record.id).catch(() => undefined);

      // A short download can finish before yt-dlp emits a single progress tick,
      // which would leave the record claiming 0 bytes. Take the truth from the
      // file that actually landed.
      const finalSize = await fileSize(finalPath).catch(() => null);

      this.store.update((s) => {
        const d = s.downloads.find((x) => x.id === record.id);
        if (!d) return;
        d.status = 'completed';
        d.filePath = finalPath;
        d.filename = basename(finalPath);
        if (finalSize !== null) {
          d.downloaded = finalSize;
          d.totalSize = finalSize;
        }
        d.rateBps = 0;
        d.etaSeconds = null;
        d.completedAt = new Date().toISOString();
      });
      await this.store.flush();

      const done = this.records.find((d) => d.id === record.id);
      if (done) {
        this.emit('done', done);
        this.runPostDownloadHook(done);
      }
      this.pumpQueue();
    } catch (err) {
      this.external.delete(record.id);
      await removeWorkingFile(join(record.destDir, `.idm-staging-${record.id}`), record.id).catch(
        () => undefined,
      );

      if (controller.signal.aborted) {
        this.setStatus(record.id, 'paused');
        return;
      }
      this.onError(record.id, err instanceof Error ? err : new Error(String(err)));
    }
  }

  async pause(id: string): Promise<void> {
    const ext = this.external.get(id);
    if (ext) {
      ext.abort();
      this.external.delete(id);
      this.setStatus(id, 'paused');
      this.pumpQueue();
      return;
    }
    const dl = this.live.get(id);
    if (!dl) return;
    await dl.pause();
    this.live.delete(id);
    this.setStatus(id, 'paused');
    this.pumpQueue();
  }

  async cancel(id: string): Promise<void> {
    this.external.get(id)?.abort();
    this.external.delete(id);
    const dl = this.live.get(id);
    if (dl) {
      await dl.cancel();
      this.live.delete(id);
    }
    this.store.update((s) => {
      s.downloads = s.downloads.filter((d) => d.id !== id);
      for (const q of s.queues) q.items = q.items.filter((i) => i !== id);
    });
    // Without this every other client keeps showing the row forever.
    this.emit('removed', { id });
    this.pumpQueue();
  }

  /**
   * Download again, from nothing.
   *
   * Not the same as resume. Resume continues from the journal, which is right
   * after a dropped connection and exactly wrong when the journal is the
   * problem: once the file changes on the server every resume fails the same
   * way, forever. So this throws the partial data away.
   *
   * It never touches a finished file. If the old one is still there the new
   * copy lands beside it as "name (1).ext" — the engine's collision handling
   * does that already — because someone who deleted it wants it back and
   * someone who didn't has not asked to lose it.
   */
  async restart(id: string): Promise<DownloadRecord | null> {
    const record = this.records.find((d) => d.id === id);
    if (!record) return null;

    // Stop whatever is running, without the queue pulling something else into
    // the slot this is about to take back.
    this.external.get(id)?.abort();
    this.external.delete(id);
    const dl = this.live.get(id);
    if (dl) {
      await dl.cancel();
      this.live.delete(id);
    }

    if (record.status !== 'completed') {
      await Promise.all(
        [partPath(record.filePath), journalPath(record.filePath)].map((p) =>
          removeWorkingFile(p, id).catch(() => undefined),
        ),
      );
    }

    this.store.update((s) => {
      const d = s.downloads.find((x) => x.id === id);
      if (!d) return;
      d.status = 'paused';
      d.downloaded = 0;
      d.totalSize = null;
      d.rateBps = 0;
      d.etaSeconds = null;
      d.segments = [];
      delete d.error;
      delete d.completedAt;
      if (d.checksum) delete d.checksum.verified;
    });

    this.resume(id);
    const fresh = this.records.find((d) => d.id === id) ?? null;
    if (fresh) this.emit('restarted', fresh);
    return fresh;
  }

  /**
   * The list as clients should see it: each finished download says whether
   * its file is still on disk.
   *
   * Worked out when asked rather than stored, because the answer changes
   * whenever someone empties a folder, and nothing tells us when they do.
   */
  snapshot(): DownloadRecord[] {
    return this.records.map((d) =>
      d.status === 'completed' && !existsSync(d.filePath) ? { ...d, fileMissing: true } : d,
    );
  }

  async pauseAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.pause(id)));
  }

  setGlobalRate(bps: number): void {
    this.globalBucket.setRate(bps);
    this.store.update((s) => {
      s.settings.globalRateBps = bps;
    });
    this.emit('settings', this.store.settings);
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.store.update((s) => {
      Object.assign(s.settings, patch);
    });
    if (patch.globalRateBps !== undefined) this.globalBucket.setRate(patch.globalRateBps);
    this.emit('settings', this.store.settings);
    return this.store.settings;
  }

  private get activeCount(): number {
    return this.live.size + this.external.size;
  }

  private setStatus(id: string, status: DownloadRecord['status']): void {
    this.store.update((s) => {
      const d = s.downloads.find((x) => x.id === id);
      if (d) {
        d.status = status;
        if (status !== 'downloading') d.rateBps = 0;
      }
    });
    this.dirtyProgress.add(id);
  }

  private onProgress(id: string, p: ProgressSnapshot): void {
    this.store.update((s) => {
      const d = s.downloads.find((x) => x.id === id);
      if (!d) return;
      d.downloaded = p.downloaded;
      d.totalSize = p.totalSize;
      d.rateBps = p.rateBps;
      d.etaSeconds = p.etaSeconds;
      d.segments = [...p.segments];
      if (p.filePath && p.filePath !== d.filePath) adoptPath(d, p.filePath);
      if (p.status === 'downloading') d.status = 'downloading';
    });
    this.dirtyProgress.add(id);
  }

  private async onDone(id: string, dl: Download): Promise<void> {
    this.live.delete(id);
    const record = this.records.find((d) => d.id === id);

    let verified: boolean | undefined;
    if (record?.checksum) {
      const actual = await hashFile(dl.path, record.checksum.algorithm).catch(() => null);
      verified = actual !== null && actual.toLowerCase() === record.checksum.value.toLowerCase();
    }

    this.store.update((s) => {
      const d = s.downloads.find((x) => x.id === id);
      if (!d) return;
      d.status = 'completed';
      adoptPath(d, dl.path);
      d.rateBps = 0;
      d.downloaded = d.totalSize ?? d.downloaded;
      d.completedAt = new Date().toISOString();
      if (d.checksum) d.checksum.verified = verified;
    });
    await this.store.flush();

    const done = this.records.find((d) => d.id === id);
    if (done) {
      this.emit('done', done);
      this.runPostDownloadHook(done);
    }
    this.pumpQueue();
  }

  private onError(id: string, err: Error): void {
    this.live.delete(id);
    this.store.update((s) => {
      const d = s.downloads.find((x) => x.id === id);
      if (!d) return;
      d.status = 'failed';
      d.error = err.message;
      d.rateBps = 0;
    });
    this.emit('failed', { id, error: err.message });
    this.pumpQueue();
  }

  /**
   * Post-download hook, typically a virus scanner. Fire-and-forget: a slow or
   * broken scanner must not wedge the queue.
   */
  private runPostDownloadHook(record: DownloadRecord): void {
    const cmd = this.store.settings.postDownloadCommand;
    if (!cmd) return;
    // The path is substituted as a single quoted argument rather than
    // interpolated into the middle of a command line.
    const quoted = `'${record.filePath.replace(/'/g, `'\\''`)}'`;
    exec(cmd.replace(/\{file\}/g, quoted), { timeout: 5 * 60_000 }, (error) => {
      if (error) {
        this.store.update((s) => {
          const d = s.downloads.find((x) => x.id === record.id);
          if (d) d.error = `post-download command failed: ${error.message}`;
        });
      }
    });
  }

  /** Pull the next waiting download in when a slot frees up. */
  private pumpQueue(): void {
    const budget = this.store.settings.maxConcurrentDownloads - this.activeCount;
    if (budget <= 0) return;

    for (const q of this.queues) {
      if (!q.enabled) continue;
      for (const id of q.items) {
        if (this.activeCount >= this.store.settings.maxConcurrentDownloads) return;
        const d = this.records.find((x) => x.id === id);
        if (d && d.status === 'paused' && !this.live.has(id)) this.resume(id);
      }
    }

    const drained = this.queues.find(
      (q) =>
        q.enabled &&
        q.items.length > 0 &&
        q.items.every((id) => this.records.find((d) => d.id === id)?.status === 'completed'),
    );
    if (drained) this.emit('queue-drained', drained);
  }

  /** Batch progress at 4 Hz. Per-chunk events are what make these UIs stutter. */
  private startProgressPump(): void {
    this.progressTimer ??= setInterval(() => {
      if (this.dirtyProgress.size === 0) return;
      const ids = [...this.dirtyProgress];
      this.dirtyProgress.clear();
      const batch = this.records.filter((d) => ids.includes(d.id));
      if (batch.length > 0) this.emit('progress', batch);
    }, 250);
  }

  async shutdown(): Promise<void> {
    if (this.progressTimer) clearInterval(this.progressTimer);
    this.progressTimer = null;
    await this.pauseAll();
    await this.store.flush();
  }
}

/**
 * Does this URL look like a page rather than a file?
 *
 * Only a first guess — resume() re-checks against the probe's content type, so
 * a URL with no extension that turns out to serve a real file still takes the
 * fast path.
 */
/**
 * Where a URL should go, judged by what it serves. Only a page or a stream
 * manifest needs yt-dlp; anything else is a file, and the segmented engine is
 * both faster and names it properly.
 */
export function routeFor(contentType: string | null): 'engine' | 'ytdlp' {
  if (!contentType) return 'ytdlp';
  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'ytdlp';
  if (mime.includes('mpegurl') || mime === 'application/dash+xml') return 'ytdlp';
  return 'engine';
}

function isStreamManifest(url: string): boolean {
  try {
    return /\.(m3u8|mpd)$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function looksLikePage(url: string): boolean {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop() ?? '';
    const ext = last.includes('.') ? last.split('.').pop()!.toLowerCase() : '';

    if (ext === 'm3u8' || ext === 'mpd') return true; // adaptive stream
    if (ext === '') return true; // /watch, /video/123
    if (['html', 'htm', 'php', 'aspx', 'jsp'].includes(ext)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * yt-dlp names each downloaded stream `NAME.f<id>.ext` and the merged result
 * `NAME.ext`. Telling them apart is what stops us from keeping the audio track
 * and deleting the finished video.
 */
export function isIntermediate(filename: string): boolean {
  return /\.f\d+\.[^.]+$/i.test(filename);
}

/**
 * The file yt-dlp actually left behind.
 *
 * The path printed by --print after_move cannot be trusted for a merge: it is
 * printed once per downloaded stream, so the last one is an intermediate.
 * Renaming that out of staging and deleting the rest threw away the merged
 * video and kept the audio track — a "completed" download that was a .m4a.
 *
 * So the merged output wins whenever one exists, and intermediates are only
 * considered when the merge did not happen at all.
 */
async function resolveProduced(staging: string): Promise<string | null> {
  const found: { path: string; size: number }[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      // yt-dlp's in-progress scratch files.
      if (/\.(part|ytdl|temp)$/i.test(entry.name)) continue;
      const size = await stat(full)
        .then((st) => st.size)
        .catch(() => 0);
      found.push({ path: full, size });
    }
  };
  await walk(staging);
  if (found.length === 0) return null;

  const merged = found.filter((f) => !isIntermediate(basename(f.path)));
  const pool = merged.length > 0 ? merged : found;
  return pool.sort((a, b) => b.size - a.size)[0]!.path;
}

/** A readable stand-in for a page whose title is not known yet. */
function pageLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return `Video from ${host}`;
  } catch {
    return 'Video';
  }
}

/**
 * Take the name the engine actually wrote to.
 *
 * It can differ from the one guessed at add time: a collision adds " (1)",
 * and a URL with no extension gets one from the Content-Type. The list shows
 * `filename`, so updating only the path left X's images listed as
 * "GiQ4vJ2XIAAxm6v" while a .jpg sat on disk.
 */
function adoptPath(d: DownloadRecord, filePath: string): void {
  d.filePath = filePath;
  d.filename = basename(filePath);
  // Filed under Other while the name had no extension to go on.
  if (d.category === 'other') d.category = categoryFor(d.filename);
}

function guessName(url: string): string {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return base || 'download';
  } catch {
    return 'download';
  }
}
