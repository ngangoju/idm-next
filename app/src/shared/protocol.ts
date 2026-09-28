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
  /**
   * `useYtdlp` was guessed from the URL's shape, not asked for. Checked
   * against what the URL actually serves before anything is downloaded.
   */
  routeUnverified?: boolean;
  /** yt-dlp format id, when the user picked one. */
  formatId?: string;
  error?: string;
  createdAt: string;
  completedAt?: string;
  /**
   * Finished, but the file is no longer where it was saved. Computed when the
   * list is sent, never stored.
   */
  fileMissing?: boolean;
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

/** 'system' follows the OS. Light is the default. */
export type Theme = 'light' | 'dark' | 'system';

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
  /** Open the progress window when a download starts, the way IDM does. */
  autoOpenDetails: boolean;
  /** Close it again once the download has finished. */
  autoCloseDetails: boolean;
  theme: Theme;
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
  /**
   * `filename` and `category` belong here, not just in the initial list: a
   * page download is named for its host until yt-dlp reports the real title,
   * and without them that title reached the store but never the screen.
   */
  | { type: 'progress'; downloads: Pick<DownloadRecord,
      'id' | 'status' | 'downloaded' | 'totalSize' | 'rateBps' | 'etaSeconds' | 'segments'
      | 'filename' | 'category' | 'filePath' | 'error'>[] }
  | { type: 'download-added'; download: DownloadRecord }
  | { type: 'download-restarted'; download: DownloadRecord }
  | { type: 'download-done'; download: DownloadRecord }
  | { type: 'download-error'; id: string; error: string }
  | { type: 'download-removed'; id: string }
  | { type: 'settings'; settings: Settings }
  | { type: 'queues'; queues: Queue[] };

/**
 * Turn an error into something a person can act on.
 *
 * Raw failures reach the UI verbatim — a full ENOENT with an internal staging
 * path tells the user nothing they can do anything about, and fills the row.
 * The original is kept for the tooltip; this is what gets shown.
 */
export function humanizeError(raw: string): string {
  const e = raw.toLowerCase();

  if (e.includes('ffmpeg') && (e.includes('unavailable') || e.includes('not installed'))) {
    return 'ffmpeg is missing, so video and audio could not be combined';
  }
  if (e.includes('enoent') && e.includes('staging')) {
    return 'The downloader finished but left no usable file';
  }
  if (e.includes('enoent')) return 'A file went missing during the download';
  if (e.includes('enospc')) return 'Not enough disk space';
  if (e.includes('eacces') || e.includes('eperm')) return 'No permission to write there';
  if (e.includes('econnrefused')) return 'The server refused the connection';
  if (e.includes('enotfound') || e.includes('getaddrinfo')) return 'Could not reach that server';
  if (e.includes('etimedout') || e.includes('timeout')) return 'The server stopped responding';
  if (e.includes('econnreset')) return 'The connection dropped';
  if (e.includes('remote file changed')) {
    return 'The file changed on the server, so this cannot pick up where it stopped — download it again';
  }
  if (e.includes('403')) return 'The server refused this download (403)';
  if (e.includes('404')) return 'That file is no longer there (404)';
  if (e.includes('429')) return 'The server is rate-limiting us — try later';
  if (e.includes('yt-dlp not found')) return 'yt-dlp is not installed';
  if (e.includes('no such file')) return 'The downloader produced no file';
  if (e.includes('unsupported url') || e.includes('unable to extract')) {
    return 'This page is not supported';
  }
  if (e.includes('requested format is not available')) {
    return 'That quality is no longer offered for this video — pick another';
  }
  if (e.includes('private video')) return 'This video is private';
  if (e.includes('video unavailable')) return 'This video is unavailable';
  if (e.includes('sign in') || e.includes('age')) return 'This video requires signing in';

  // Unknown: keep it, but only the first line and not an essay.
  const first = raw.split('\n')[0]!.trim();
  return first.length > 120 ? `${first.slice(0, 117)}…` : first;
}

export function categoryFor(filename: string): Category {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  for (const [cat, exts] of Object.entries(CATEGORY_EXTENSIONS)) {
    if (exts.includes(ext)) return cat as Category;
  }
  return 'other';
}
