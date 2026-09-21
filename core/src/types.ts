/** Shared types for the download engine. */

export interface ProbeResult {
  /** Final URL after redirects. */
  url: string;
  /** Total size in bytes, or null when the server would not tell us. */
  totalSize: number | null;
  /** True only when the server answered a ranged request with a parseable 206. */
  resumable: boolean;
  contentType: string | null;
  /** Filename suggested by Content-Disposition, already sanitized. */
  suggestedName: string | null;
  etag: string | null;
  lastModified: string | null;
  statusCode: number;
}

export interface SegmentState {
  /** First byte of this segment, inclusive. */
  start: number;
  /** Last byte of this segment, inclusive. */
  end: number;
  /** Next byte to be written; cursor > end means the segment is done. */
  cursor: number;
}

export interface Journal {
  version: 1;
  url: string;
  totalSize: number;
  etag: string | null;
  lastModified: string | null;
  segments: SegmentState[];
  createdAt: string;
}

export interface DownloadOptions {
  url: string;
  /** Directory the file lands in. */
  destDir: string;
  /** Overrides any server-suggested name. */
  filename?: string;
  /** Number of parallel connections. Clamped to 1..32. */
  connections?: number;
  /** Extra request headers (cookies, referer, user-agent, auth). */
  headers?: Record<string, string>;
  /** Bytes per second for this download. 0 or undefined means unlimited. */
  maxRateBps?: number;
  /** Max attempts per segment before the download fails. */
  maxRetries?: number;
  proxy?: string;
  signal?: AbortSignal;
}

export type DownloadStatus =
  | 'probing'
  | 'downloading'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ProgressSnapshot {
  status: DownloadStatus;
  /** Bytes written so far across all segments. */
  downloaded: number;
  totalSize: number | null;
  /** Aggregate bytes/sec, smoothed. */
  rateBps: number;
  /** Seconds remaining, or null when not computable. */
  etaSeconds: number | null;
  /** Per-connection state, for the segment strip in the UI. */
  segments: readonly SegmentState[];
  filePath: string;
  error?: string;
}

/** Raised when a resumed download no longer matches the server's copy. */
export class StaleResumeError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Remote file changed since this download started (${reason})`);
    this.name = 'StaleResumeError';
    this.reason = reason;
  }
}

export class InsufficientSpaceError extends Error {
  readonly needed: number;
  readonly available: number;
  constructor(needed: number, available: number) {
    super(`Need ${needed} bytes but only ${available} are free`);
    this.name = 'InsufficientSpaceError';
    this.needed = needed;
    this.available = available;
  }
}
