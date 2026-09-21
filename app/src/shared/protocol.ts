/**
 * The wire contract shared by the main process, the renderer, and the
 * extension. Keeping it in one file is what lets the extension's transport be
 * swapped (localhost fetch today, native messaging later) without touching
 * anything else.
 */
import type { DownloadStatus, SegmentState } from '@idm-next/core';

export const DEFAULT_PORT = 47591;

/** File categories, in the order they appear in the sidebar. */
export const CATEGORIES = ['video', 'audio', 'documents', 'compressed', 'programs', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_EXTENSIONS: Record<Exclude<Category, 'other'>, readonly string[]> = {
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'ts', 'm3u8'],
  audio: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'aiff'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub', 'mobi', 'csv'],
  compressed: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg'],
  programs: ['exe', 'msi', 'pkg', 'deb', 'rpm', 'appimage', 'apk', 'bin'],
};

export interface DownloadRecord {
  id: string;
  url: string;
  filename: string;
  filePath: string;
  destDir: string;
  category: Category;
  status: DownloadStatus;
  totalSize: number | null;
  downloaded: number;
  rateBps: number;
  etaSeconds: number | null;
  segments: SegmentState[];
  connections: number;
  queueId: string | null;
  /** Page the download was started from, for the UI and for referer. */
  sourcePage?: string;
  /**
   * Route through yt-dlp instead of the segmented engine. Set for pages and
   * adaptive streams, which have no single ranged URL to split.
   */
  useYtdlp?: boolean;
  /** yt-dlp format id, when the user picked one. */
  formatId?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
  /** Expected hash, if the user supplied one. */
  checksum?: { algorithm: 'md5' | 'sha1' | 'sha256'; value: string; verified?: boolean };
}

export interface Queue {
  id: string;
  name: string;
  maxConcurrent: number;
  /** Ordered download ids. */
  items: string[];
  startAt?: string;
  stopAt?: string;
  enabled: boolean;
}

export interface Settings {
  /** Root for category subfolders. */
  downloadDir: string;
  categoryDirs: Partial<Record<Category, string>>;
  defaultConnections: number;
  /** Global cap in bytes/sec; 0 is unlimited. */
  globalRateBps: number;
  maxConcurrentDownloads: number;
  clipboardMonitor: boolean;
  /** Extensions the clipboard monitor and takeover react to. */
  watchedExtensions: string[];
  /** Take over downloads the browser starts. */
  browserTakeover: boolean;
  /** Shell command run after a download completes; {file} is substituted. */
  postDownloadCommand: string | null;
  shutdownWhenQueueDone: boolean;
  ytdlpPath: string;
  ffmpegPath: string;
  proxy: string | null;
}

/** A piece of media the extension noticed on a page. */
export interface DetectedMedia {
  url: string;
  /** Best-effort: 'video' | 'audio' | 'stream' | 'file'. */
  kind: 'video' | 'audio' | 'stream' | 'file';
  contentType: string | null;
  size: number | null;
  title: string | null;
  pageUrl: string;
  /** Set for HLS/DASH manifests, which need the yt-dlp path. */
  isManifest: boolean;
  detectedAt: number;
}

/* ------------------------------ requests ------------------------------ */

export interface AddDownloadRequest {
  url: string;
  filename?: string;
  destDir?: string;
  connections?: number;
  headers?: Record<string, string>;
  queueId?: string;
  sourcePage?: string;
  checksum?: { algorithm: 'md5' | 'sha1' | 'sha256'; value: string };
  /** Start paused, so the user can adjust options first. */
  startPaused?: boolean;
  /** Force the yt-dlp path; omitted means decide automatically. */
  useYtdlp?: boolean;
  formatId?: string;
}

/**
 * Asks the app to check a URL is fetchable *before* the extension cancels the
 * browser's own download. See the takeover note in the extension.
 */
export interface ProbeRequest {
  url: string;
  headers?: Record<string, string>;
}

export interface ProbeResponse {
  ok: boolean;
  /** True only when we could take over without losing the download. */
  canTakeOver: boolean;
  totalSize: number | null;
  filename: string | null;
  contentType: string | null;
  reason?: string;
}

/* ------------------------------- events ------------------------------- */

export type ServerEvent =
  | { type: 'hello'; version: string }
  | { type: 'downloads'; downloads: DownloadRecord[] }
  | { type: 'progress'; downloads: Pick<DownloadRecord,
      'id' | 'status' | 'downloaded' | 'totalSize' | 'rateBps' | 'etaSeconds' | 'segments'>[] }
  | { type: 'download-added'; download: DownloadRecord }
  | { type: 'download-done'; download: DownloadRecord }
  | { type: 'download-error'; id: string; error: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'queues'; queues: Queue[] };

export function categoryFor(filename: string): Category {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  for (const [cat, exts] of Object.entries(CATEGORY_EXTENSIONS)) {
    if (exts.includes(ext)) return cat as Category;
  }
  return 'other';
}
