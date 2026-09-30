/**
 * The download orchestrator: probe, plan, run N workers, steal, journal, finish.
 */
import { EventEmitter } from 'node:events';
import { request, type Dispatcher } from 'undici';
import { probe, makeDispatcher, validateResume } from './probe.ts';
import {
  SegmentScheduler,
  planSegments,
  isComplete,
  remainingOf,
  type WorkerSegment,
} from './segments.ts';
import { PartFileWriter, ensureSpace } from './writer.ts';
import { JournalWriter, readJournal, journalPath, partPath, reserveTarget } from './journal.ts';
import { resolveFilename, safeJoin } from './filename.ts';
import { removeWorkingFile } from './fileops.ts';
import { TokenBucket, RateLimiter } from './throttle.ts';
import {
  DEFAULT_RETRY,
  backoffMs,
  isRetryableError,
  isRetryableStatus,
  parseRetryAfter,
  sleep,
  type RetryPolicy,
} from './retry.ts';
import {
  StaleResumeError,
  type DownloadOptions,
  type DownloadStatus,
  type Journal,
  type ProgressSnapshot,
} from './types.ts';

/** How long to stop adding connections after the server pushes back. */
const THROTTLE_COOLDOWN_MS = 10_000;

export interface DownloadEvents {
  progress: [ProgressSnapshot];
  done: [{ filePath: string }];
  error: [Error];
  /** Emitted instead of resuming when the remote file changed under us. */
  stale: [{ reason: string }];
}

export class Download extends EventEmitter<DownloadEvents> {
  private scheduler: SegmentScheduler | null = null;
  private writer: PartFileWriter | null = null;
  private journal: JournalWriter | null = null;
  private dispatcher: Dispatcher | null = null;
  private limiter: RateLimiter;
  private localBucket: TokenBucket;
  private controller = new AbortController();
  private status: DownloadStatus = 'probing';
  private filePath = '';
  private totalSize: number | null = null;
  private lastError: string | undefined;
  private progressTimer: NodeJS.Timeout | null = null;
  private pausePromise: Promise<void> | null = null;
  /**
   * Until this timestamp, finished workers exit instead of stealing more work.
   *
   * A 429 means the server is objecting to how hard we are pushing it, and
   * backing off a single segment does not reduce the pressure — the other
   * connections are still open. Letting workers retire shrinks concurrency
   * without restructuring the download, and it recovers on its own.
   */
  private throttledUntil = 0;
  private readonly retryPolicy: RetryPolicy;

  private readonly opts: DownloadOptions;
  /** Shared across every download so a global cap actually caps the total. */
  private readonly globalBucket: TokenBucket;

  constructor(opts: DownloadOptions, globalBucket: TokenBucket = new TokenBucket(0)) {
    super();
    this.opts = opts;
    this.globalBucket = globalBucket;
    this.localBucket = new TokenBucket(opts.maxRateBps ?? 0);
    this.limiter = new RateLimiter(this.globalBucket, this.localBucket);
    this.retryPolicy = opts.maxRetries
      ? { ...DEFAULT_RETRY, maxAttempts: opts.maxRetries }
      : DEFAULT_RETRY;

    opts.signal?.addEventListener('abort', () => this.cancel(), { once: true });
  }

  get currentStatus(): DownloadStatus {
    return this.status;
  }

  get path(): string {
    return this.filePath;
  }

  async start(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      if (this.status === 'paused' || this.status === 'cancelled') return;
      this.status = 'failed';
      this.lastError = err instanceof Error ? err.message : String(err);
      this.emitProgress();
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.stopProgressTimer();
      if (this.status !== 'completed' && this.status !== 'cancelled') {
        await this.checkpoint();
      }
    }
  }

  private async run(): Promise<void> {
    const connections = Math.max(1, Math.min(this.opts.connections ?? 8, 32));
    this.dispatcher = makeDispatcher({
      proxy: this.opts.proxy,
      connections: connections + 2,
    });

    this.status = 'probing';
    const info = await probe({
      url: this.opts.url,
      headers: this.opts.headers,
      dispatcher: this.dispatcher,
      signal: this.controller.signal,
    });

    const name = resolveFilename({
      override: this.opts.filename,
      suggested: info.suggestedName,
      url: info.url,
      contentType: info.contentType,
    });
    const target = safeJoin(this.opts.destDir, name);
    this.totalSize = info.totalSize;

    const jPath = journalPath(target);
    const existing = await readJournal(jPath);

    // Resume only when we have a journal, a matching URL, and the server still
    // supports ranges. Anything less starts clean.
    let resuming = false;
    if (existing && info.resumable && existing.url === this.opts.url) {
      const verdict = validateResume(existing, info);
      if (!verdict.ok) {
        this.emit('stale', { reason: verdict.reason });
        throw new StaleResumeError(verdict.reason);
      }
      resuming = true;
    }

    // Resuming continues our own part file. Anything else claims a name no
    // other download — finished or still running — is using.
    this.filePath = resuming ? target : await reserveTarget(target, this.opts.owner);

    if (!info.resumable || info.totalSize === null || info.totalSize === 0) {
      await this.runSingleStream(info.totalSize);
      return;
    }

    await ensureSpace(this.opts.destDir, info.totalSize);

    const segments: WorkerSegment[] = resuming
      ? existing!.segments.map((s) => ({ ...s, rate: 0, active: false }))
      : planSegments(info.totalSize, connections);

    this.scheduler = new SegmentScheduler(segments);
    this.writer = await PartFileWriter.create(partPath(this.filePath), info.totalSize);

    const journalState: Journal = {
      version: 1,
      url: this.opts.url,
      totalSize: info.totalSize,
      etag: info.etag,
      lastModified: info.lastModified,
      segments: this.scheduler.snapshot(),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    // The journal belongs beside the part file actually being written. `jPath`
    // is the wanted name's; when that name was taken and this download moved to
    // "name (1)", a journal left at the wanted name sits beside someone else's
    // finished file — and the next download of this URL "resumes" from it, into
    // an empty part, and renames the result over that file.
    this.journal = new JournalWriter(journalPath(this.filePath), journalState, this.opts.owner);

    this.status = 'downloading';
    this.startProgressTimer();

    // One worker per incomplete segment, capped at the connection limit.
    const initial = this.scheduler.segments
      .map((_, i) => i)
      .filter((i) => !isComplete(this.scheduler!.segments[i]!))
      .slice(0, connections);

    await Promise.all(initial.map((i) => this.worker(i)));

    if (this.status !== 'downloading') return;

    if (!this.scheduler.done) {
      throw new Error('Download ended with segments incomplete');
    }

    this.filePath = await this.writer.finalize(this.filePath, this.opts.owner);
    await this.journal.remove();
    this.status = 'completed';
    this.stopProgressTimer();
    this.emitProgress();
    this.emit('done', { filePath: this.filePath });
  }

  /**
   * A worker owns one segment at a time. When it finishes, it asks the
   * scheduler to carve a tail off the worst-ETA segment and takes that instead,
   * so connections stay busy until the whole file is done.
   */
  private async worker(index: number): Promise<void> {
    const sched = this.scheduler!;
    let current: number | null = index;

    while (current !== null && this.status === 'downloading') {
      const seg = sched.segments[current]!;
      seg.active = true;
      try {
        await this.pullSegment(current);
      } finally {
        seg.active = false;
      }

      if (this.status !== 'downloading') return;

      // While the server is pushing back, retire rather than opening another
      // connection. Segments still in flight continue; we just stop adding.
      if (Date.now() < this.throttledUntil) return;

      const stolen = sched.steal();
      current = stolen ? sched.segments.indexOf(stolen) : null;
      if (current !== null) sched.segments[current]!.active = true;
    }
  }

  /** Fetch one segment's byte range, retrying from the cursor on failure. */
  private async pullSegment(index: number): Promise<void> {
    const sched = this.scheduler!;
    let attempt = 0;

    while (this.status === 'downloading') {
      const seg = sched.segments[index]!;
      if (isComplete(seg)) return;

      try {
        await this.streamRange(index);
        return;
      } catch (err) {
        if (this.status !== 'downloading') return;
        attempt++;
        if (attempt >= this.retryPolicy.maxAttempts || !isRetryableError(err)) throw err;

        const hinted = (err as { retryAfterMs?: number }).retryAfterMs;
        await sleep(hinted ?? backoffMs(attempt, this.retryPolicy), this.controller.signal);
      }
    }
  }

  private async streamRange(index: number): Promise<void> {
    const sched = this.scheduler!;
    const seg = sched.segments[index]!;

    const res = await request(this.opts.url, {
      method: 'GET',
      headers: { ...this.opts.headers, range: `bytes=${seg.cursor}-${seg.end}` },
      dispatcher: this.dispatcher!,
      signal: this.controller.signal,
    });

    if (res.statusCode !== 206) {
      await res.body.dump();
      if (isRetryableStatus(res.statusCode)) {
        const err = new Error(`HTTP ${res.statusCode}`) as Error & { retryAfterMs?: number };
        const ra = parseRetryAfter((res.headers['retry-after'] as string | undefined) ?? undefined);
        if (ra !== null) err.retryAfterMs = ra;

        if (res.statusCode === 429 || res.statusCode === 503) {
          this.throttledUntil = Date.now() + Math.max(ra ?? 0, THROTTLE_COOLDOWN_MS);
        }
        throw err;
      }
      throw new Error(`Unexpected status ${res.statusCode} for ranged request`);
    }

    let sampleBytes = 0;
    let sampleStart = Date.now();

    for await (const chunk of res.body) {
      if (this.status !== 'downloading') {
        res.body.destroy();
        return;
      }

      let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);

      // The scheduler may have shrunk this segment's end underneath us because
      // another worker stole the tail. Drop anything past the new boundary.
      const allowed = seg.end - seg.cursor + 1;
      if (allowed <= 0) {
        res.body.destroy();
        return;
      }
      if (buf.length > allowed) buf = buf.subarray(0, allowed);

      let offset = 0;
      while (offset < buf.length) {
        const grant = await this.limiter.take(buf.length - offset);
        const slice = buf.subarray(offset, offset + grant);
        await this.writer!.writeAt(slice, seg.cursor);
        seg.cursor += slice.length;
        offset += slice.length;
        sampleBytes += slice.length;
      }

      const elapsed = Date.now() - sampleStart;
      if (elapsed >= 250) {
        sched.recordProgress(index, sampleBytes, elapsed);
        sampleBytes = 0;
        sampleStart = Date.now();
        this.journal!.update(sched.snapshot());
      }

      if (isComplete(seg)) {
        res.body.destroy();
        break;
      }
    }

    this.journal!.update(sched.snapshot());

    if (!isComplete(seg) && remainingOf(seg) > 0) {
      throw new Error(`Connection closed with ${remainingOf(seg)} bytes left in segment`);
    }
  }

  /** No range support: one connection, straight through, no resume. */
  private async runSingleStream(totalSize: number | null): Promise<void> {
    // The name was reserved in start(); its empty part file is ours.
    this.writer = await PartFileWriter.create(partPath(this.filePath), 0);
    this.status = 'downloading';
    this.startProgressTimer();

    const res = await request(this.opts.url, {
      method: 'GET',
      headers: this.opts.headers,
      dispatcher: this.dispatcher!,
      signal: this.controller.signal,
    });

    if (res.statusCode >= 400) {
      await res.body.dump();
      throw new Error(`HTTP ${res.statusCode}`);
    }

    let written = 0;
    this.scheduler = new SegmentScheduler([
      { start: 0, end: (totalSize ?? 1) - 1, cursor: 0, rate: 0, active: true },
    ]);

    for await (const chunk of res.body) {
      if (this.status !== 'downloading') {
        res.body.destroy();
        return;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      let offset = 0;
      while (offset < buf.length) {
        const grant = await this.limiter.take(buf.length - offset);
        const slice = buf.subarray(offset, offset + grant);
        await this.writer.writeAt(slice, written);
        written += slice.length;
        offset += slice.length;
      }
      const seg = this.scheduler.segments[0]!;
      seg.cursor = written;
      seg.end = Math.max(seg.end, written - 1);
    }

    this.filePath = await this.writer.finalize(this.filePath, this.opts.owner);
    this.totalSize = written;
    this.status = 'completed';
    this.stopProgressTimer();
    this.emitProgress();
    this.emit('done', { filePath: this.filePath });
  }

  /**
   * Stop cleanly, keeping the .part file and journal for a later resume.
   *
   * Idempotent, and the returned promise resolves only once the pause is
   * durable on disk. `status` flips to 'paused' immediately (it has to, to stop
   * the workers), so callers that need durability — the app on quit, say —
   * must await this rather than watch the status.
   */
  pause(): Promise<void> {
    if (this.pausePromise) return this.pausePromise;
    if (this.status !== 'downloading') return Promise.resolve();

    this.status = 'paused';
    this.controller.abort(new Error('paused'));
    this.stopProgressTimer();

    this.pausePromise = (async () => {
      await this.checkpoint();
      await this.writer?.close().catch(() => {});
      this.emitProgress();
    })();
    return this.pausePromise;
  }

  /**
   * Make the on-disk state durable and truthful.
   *
   * Order is load-bearing: fsync the data first, then write the journal. The
   * other way round leaves a window where the journal claims bytes that are not
   * on disk yet, and a crash there resumes past a hole.
   *
   * We also snapshot the cursors here rather than relying on the periodic
   * sample — a download paused inside the first sample window would otherwise
   * journal nothing at all and resume from zero. Cursors only advance after
   * their write resolves, so this snapshot can lag the real position but can
   * never run ahead of it; the worst case is re-fetching a few KiB.
   */
  private async checkpoint(): Promise<void> {
    await this.writer?.sync().catch(() => {});
    if (this.scheduler && this.journal) {
      this.journal.update(this.scheduler.snapshot());
    }
    await this.journal?.flush().catch(() => {});
  }

  /** Stop and discard partial state. */
  async cancel(): Promise<void> {
    if (this.status === 'completed') return;
    this.status = 'cancelled';
    this.controller.abort(new Error('cancelled'));
    this.stopProgressTimer();
    await this.writer?.close().catch(() => {});
    await this.journal?.remove().catch(() => {});
    // Cancelled means discarded: the partial data goes too, or every
    // cancelled download leaves a file-sized .part behind for good.
    if (this.filePath) {
      await removeWorkingFile(partPath(this.filePath), this.opts.owner).catch(() => {});
    }
    this.emitProgress();
  }

  private startProgressTimer(): void {
    // 4 Hz. Emitting per chunk is what makes these UIs stutter.
    this.progressTimer ??= setInterval(() => this.emitProgress(), 250);
  }

  private stopProgressTimer(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private emitProgress(): void {
    const downloaded = this.scheduler?.downloaded ?? 0;
    const rate = this.scheduler?.aggregateRate ?? 0;
    const remaining = this.totalSize !== null ? this.totalSize - downloaded : null;

    this.emit('progress', {
      status: this.status,
      downloaded,
      totalSize: this.totalSize,
      rateBps: rate,
      etaSeconds: remaining !== null && rate > 0 ? remaining / rate : null,
      segments: this.scheduler?.snapshot() ?? [],
      filePath: this.filePath,
      error: this.lastError,
    });
  }
}
