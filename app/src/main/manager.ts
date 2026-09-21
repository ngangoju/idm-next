/**
 * The download manager: owns every live Download, the queues, and the record
 * list the UI renders. Deliberately free of Electron imports so it can be
 * tested under plain Node.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { exec } from 'node:child_process';
import {
  Download,
  TokenBucket,
  hashFile,
  probe,
  makeDispatcher,
  fileSize,
  uniquePath,
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
    const filename = req.filename ?? guessName(req.url);
    const category = categoryFor(filename);
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
      useYtdlp: req.useYtdlp ?? looksLikePage(req.url),
    };

    this.store.update((s) => {
      s.downloads.unshift(record);
      if (record.queueId) {
        s.queues.find((q) => q.id === record.queueId)?.items.push(record.id);
      }
    });

    this.emit('added', record);
    if (!req.startPaused) this.resume(record.id, req.headers);
    return record;
  }

  resume(id: string, headers?: Record<string, string>): void {
    const record = this.records.find((d) => d.id === id);
    if (!record || this.live.has(id)) return;
    if (record.status === 'completed') return;

    if (this.activeCount >= this.store.settings.maxConcurrentDownloads) {
      // Over the concurrency budget: leave it queued and let a completion
      // pull it in.
      this.setStatus(id, 'paused');
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
   * Download via yt-dlp. Used for pages and adaptive streams, where there is no
   * single ranged URL for our engine to work with.
   */
  private async runExternal(record: DownloadRecord, headers?: Record<string, string>): Promise<void> {
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

      const { filePath: staged } = await this.ytdlp.download({
        url: record.url,
        destDir: staging,
        ...(record.formatId ? { formatId: record.formatId } : {}),
        signal: controller.signal,
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

      // --print after_move can stay silent (a skipped or already-present file),
      // so fall back to whatever actually landed in staging rather than
      // reporting a completed download with no file and no size.
      let produced = staged;
      if (!produced) {
        const entries = await readdir(staging).catch(() => [] as string[]);
        const first = entries.find((e) => !e.startsWith('.'));
        if (first) produced = join(staging, first);
      }

      if (!produced) throw new Error('yt-dlp produced no file');

      await remuxIfMislabelled(
        produced,
        this.store.settings.ffmpegPath,
        this.store.settings.ffmpegPath.replace(/ffmpeg$/, 'ffprobe'),
      ).catch(() => undefined);

      const finalPath = await uniquePath(join(record.destDir, basename(produced)));
      await rename(produced, finalPath);
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);

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
      await rm(join(record.destDir, `.idm-staging-${record.id}`), {
        recursive: true,
        force: true,
      }).catch(() => undefined);

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
      d.filePath = p.filePath || d.filePath;
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
      d.filePath = dl.path;
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
      (q) => q.enabled && q.items.length > 0 &&
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
export function looksLikePage(url: string): boolean {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop() ?? '';
    const ext = last.includes('.') ? last.split('.').pop()!.toLowerCase() : '';

    if (ext === 'm3u8' || ext === 'mpd') return true;        // adaptive stream
    if (ext === '' ) return true;                             // /watch, /video/123
    if (['html', 'htm', 'php', 'aspx', 'jsp'].includes(ext)) return true;
    return false;
  } catch {
    return false;
  }
}

function guessName(url: string): string {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return base || 'download';
  } catch {
    return 'download';
  }
}
