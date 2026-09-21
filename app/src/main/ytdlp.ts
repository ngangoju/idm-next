/**
 * yt-dlp backend.
 *
 * Site-specific extraction is a bottomless pit — yt-dlp already knows thousands
 * of sites, so we use it as an *extractor* and keep our own engine as the
 * transport wherever that is possible:
 *
 *   progressive http(s) format  ->  our segmented engine (fast, resumable)
 *   m3u8_native / dash          ->  yt-dlp's own fragment fetcher
 *
 * That split matters: for a plain MP4 behind a login, routing through our
 * engine gets multi-connection speed and crash-safe resume that yt-dlp's
 * single-stream download would not.
 *
 * yt-dlp and ffmpeg are invoked as external processes, never bundled or linked,
 * which keeps their GPL out of this project's licensing.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';

export interface YtFormat {
  id: string;
  ext: string;
  /** e.g. "1920x1080" or "audio only". */
  resolution: string;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  filesize: number | null;
  tbr: number | null;
  protocol: string;
  url: string | null;
  httpHeaders: Record<string, string>;
  note: string | null;
}

export interface Extraction {
  title: string;
  /** Best-effort page/stream duration in seconds. */
  duration: number | null;
  thumbnail: string | null;
  formats: YtFormat[];
  /** True when this is a playlist rather than a single item. */
  isPlaylist: boolean;
}

export interface YtProgress {
  status: 'downloading' | 'finished' | 'error';
  downloaded: number;
  total: number | null;
  speed: number | null;
  eta: number | null;
}

/**
 * Formats yt-dlp can hand to our engine as a plain ranged HTTP download.
 * Anything else has to stay inside yt-dlp.
 */
export function isProgressive(f: YtFormat): boolean {
  return (
    (f.protocol === 'https' || f.protocol === 'http') &&
    typeof f.url === 'string' &&
    f.url.length > 0
  );
}

/**
 * Parse one line of `--progress-template "download:%(progress)j"`.
 *
 * Deliberately not a regex over yt-dlp's human-readable progress bar: that
 * output is carriage-return updated, localizable, and changes between releases.
 * Returns null for any line that is not progress JSON — yt-dlp also writes
 * warnings and format notes to stdout.
 */
export function parseProgressLine(line: string): YtProgress | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  const status = raw['status'];
  if (status !== 'downloading' && status !== 'finished' && status !== 'error') return null;

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  return {
    status,
    downloaded: num(raw['downloaded_bytes']) ?? 0,
    // total_bytes is exact; total_bytes_estimate is what adaptive streams give.
    total: num(raw['total_bytes']) ?? num(raw['total_bytes_estimate']),
    speed: num(raw['speed']),
    eta: num(raw['eta']),
  };
}

function toFormat(raw: Record<string, unknown>): YtFormat {
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;

  const width = num(raw['width']);
  const height = num(raw['height']);

  return {
    id: String(raw['format_id'] ?? ''),
    ext: str(raw['ext']) ?? 'bin',
    resolution:
      str(raw['resolution']) ??
      (width && height ? `${width}x${height}` : height ? `${height}p` : 'audio only'),
    fps: num(raw['fps']),
    vcodec: str(raw['vcodec']) === 'none' ? null : str(raw['vcodec']),
    acodec: str(raw['acodec']) === 'none' ? null : str(raw['acodec']),
    filesize: num(raw['filesize']) ?? num(raw['filesize_approx']),
    tbr: num(raw['tbr']),
    protocol: str(raw['protocol']) ?? 'https',
    url: str(raw['url']),
    httpHeaders: (raw['http_headers'] as Record<string, string> | undefined) ?? {},
    note: str(raw['format_note']),
  };
}

export function parseExtraction(json: string): Extraction {
  const raw = JSON.parse(json) as Record<string, unknown>;

  // A playlist dump nests entries; take the first so the UI has something to
  // show rather than failing outright.
  const isPlaylist = raw['_type'] === 'playlist';
  const entry = isPlaylist
    ? ((raw['entries'] as Record<string, unknown>[] | undefined)?.[0] ?? raw)
    : raw;

  const formats = Array.isArray(entry['formats'])
    ? (entry['formats'] as Record<string, unknown>[]).map(toFormat)
    : [];

  return {
    title: typeof entry['title'] === 'string' ? entry['title'] : 'download',
    duration: typeof entry['duration'] === 'number' ? entry['duration'] : null,
    thumbnail: typeof entry['thumbnail'] === 'string' ? entry['thumbnail'] : null,
    // Newest/highest first — yt-dlp orders worst-to-best.
    formats: formats.reverse(),
    isPlaylist,
  };
}

export class YtDlp {
  private readonly bin: string;
  private readonly ffmpeg: string;

  constructor(bin = 'yt-dlp', ffmpeg = 'ffmpeg') {
    this.bin = bin;
    this.ffmpeg = ffmpeg;
  }

  async available(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const { stdout } = await run(this.bin, ['--version'], 10_000);
      return { ok: true, version: stdout.trim() };
    } catch (err) {
      return {
        ok: false,
        error: `yt-dlp not found (looked for "${this.bin}"). Install it, or set its path in settings.`,
      };
    }
  }

  /** List what is downloadable at a URL. */
  async extract(url: string, signal?: AbortSignal): Promise<Extraction> {
    const { stdout } = await run(
      this.bin,
      ['-J', '--no-warnings', '--no-playlist', '--flat-playlist', url],
      120_000,
      signal,
    );
    return parseExtraction(stdout);
  }

  /**
   * Download with yt-dlp itself. Used for adaptive streams, where our engine
   * has nothing to range over.
   */
  download(opts: {
    url: string;
    formatId?: string;
    destDir: string;
    filenameTemplate?: string;
    concurrentFragments?: number;
    onProgress?: (p: YtProgress) => void;
    signal?: AbortSignal;
  }): Promise<{ filePath: string }> {
    const args = [
      '--no-warnings',
      '--no-playlist',
      '--newline',
      // Structured progress. Regexing the human-readable bar breaks on every
      // release and on carriage-return updates.
      '--progress-template',
      'download:%(progress)j',
      '--progress-delta',
      '0.25',
      '--ffmpeg-location',
      this.ffmpeg,
      '-N',
      String(opts.concurrentFragments ?? 8),
      '-o',
      `${opts.destDir}/${opts.filenameTemplate ?? '%(title)s.%(ext)s'}`,
      '--print',
      'after_move:%(filepath)s',
    ];
    if (opts.formatId) args.push('-f', opts.formatId);
    args.push(opts.url);

    return new Promise((resolve, reject) => {
      // Args as an array, never a shell string: the URL is untrusted input.
      const child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let finalPath = '';
      let stderr = '';
      let buffer = '';

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const progress = parseProgressLine(line);
          if (progress) {
            opts.onProgress?.(progress);
          } else if (line.trim().startsWith('/')) {
            // after_move:%(filepath)s
            finalPath = line.trim();
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c: string) => {
        stderr += c;
        if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
      });

      const onAbort = (): void => {
        child.kill('SIGTERM');
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (err) => {
        opts.signal?.removeEventListener('abort', onAbort);
        reject(new Error(`Could not run yt-dlp: ${err.message}`));
      });

      child.on('close', (code) => {
        opts.signal?.removeEventListener('abort', onAbort);
        if (code === 0) return resolve({ filePath: finalPath });
        reject(new Error(stderr.trim().split('\n').pop() ?? `yt-dlp exited ${code}`));
      });
    });
  }
}

/**
 * Make the container match the extension.
 *
 * yt-dlp's native HLS downloader concatenates MPEG-TS segments but names the
 * result after the *format's* declared extension, so a stream lands as a .mp4
 * that is really MPEG-TS. VLC copes; Safari, QuickTime and every browser do
 * not. yt-dlp's own --remux-video skips it because it trusts that extension,
 * so we check the real container and fix it ourselves. It is a stream copy.
 */
export async function remuxIfMislabelled(
  filePath: string,
  ffmpegBin = 'ffmpeg',
  ffprobeBin = 'ffprobe',
): Promise<{ remuxed: boolean; container?: string }> {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (ext !== 'mp4' && ext !== 'm4v' && ext !== 'm4a') return { remuxed: false };

  let container: string;
  try {
    const { stdout } = await run(
      ffprobeBin,
      ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', filePath],
      30_000,
    );
    container = stdout.trim();
  } catch {
    return { remuxed: false }; // No ffprobe: leave the file alone.
  }

  // An ISO-BMFF container already reports mov/mp4/m4a.
  if (!container.includes('mpegts')) return { remuxed: false, container };

  const tmp = `${filePath}.remux.mp4`;
  try {
    await run(
      ffmpegBin,
      ['-v', 'error', '-y', '-i', filePath, '-c', 'copy', '-movflags', '+faststart', tmp],
      10 * 60_000,
    );
    const { rename } = await import('node:fs/promises');
    await rename(tmp, filePath);
    return { remuxed: true, container: 'mp4' };
  } catch {
    const { unlink } = await import('node:fs/promises');
    await unlink(tmp).catch(() => {});
    // A failed remux is not a failed download; keep the playable TS.
    return { remuxed: false, container };
  }
}

async function run(
  bin: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c: string) => (stdout += c));
  child.stderr.on('data', (c: string) => (stderr += c));

  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const onAbort = (): void => {
    child.kill('SIGTERM');
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const [code] = (await once(child, 'close')) as [number | null];
    if (code !== 0) throw new Error(stderr.trim() || `exited ${code}`);
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
