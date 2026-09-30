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
import { removeWorkingFile, replaceWorkingFile } from '@idm-next/core';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/**
 * Marks the title line among yt-dlp's other stdout output. A control character
 * so it cannot collide with a real title.
 */
const TITLE_MARKER = '\u0001idm-title\u0001';

export interface YtFormat {
  id: string;
  ext: string;
  /** e.g. "1920x1080" or "720p"; null when the format does not say. */
  resolution: string | null;
  /** Pixel height, for grouping renditions into one choice per quality. */
  height: number | null;
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
  /**
   * One complete, playable choice per resolution — what a person actually
   * wants to pick from. Raw `formats` lists video and audio separately above
   * 720p, so choosing from it directly yields a silent file.
   */
  qualities: QualityChoice[];
  /** True when this is a playlist rather than a single item. */
  isPlaylist: boolean;
}

export interface QualityChoice {
  /** yt-dlp selector: "137+251" for a merge, "22" when it already has audio. */
  formatId: string;
  /** "1080p HD", "720p", "Audio only". */
  label: string;
  height: number | null;
  fps: number | null;
  ext: string;
  /** Video plus audio when a merge is needed; null when nothing reports a size. */
  filesize: number | null;
  /** Needs muxing, so it costs an ffmpeg pass. */
  merged: boolean;
  protocol: string;
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
    // A bare HLS media playlist carries no dimensions at all. Defaulting that
    // to "audio only" mislabels a 720p video, so report the absence honestly
    // and let the caller decide what to show.
    resolution:
      str(raw['resolution']) ??
      (width && height ? `${width}x${height}` : height ? `${height}p` : null),
    height,
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

  // Newest/highest first — yt-dlp orders worst-to-best.
  const ordered = formats.reverse();

  return {
    title: typeof entry['title'] === 'string' ? entry['title'] : 'download',
    duration: typeof entry['duration'] === 'number' ? entry['duration'] : null,
    thumbnail: typeof entry['thumbnail'] === 'string' ? entry['thumbnail'] : null,
    formats: ordered,
    qualities: buildQualities(ordered),
    isPlaylist,
  };
}

/**
 * Collapse yt-dlp's format list into one complete choice per resolution.
 *
 * Above 720p YouTube (and most adaptive sources) publish video and audio as
 * separate formats. A list built straight from `formats` therefore offers
 * "1080p" entries that download silent, which is the single most common way a
 * quality picker misleads people. Each choice here is guaranteed to carry
 * sound: a format that already has audio is used as-is, and a video-only one
 * is paired with the best audio track.
 */
export function buildQualities(formats: YtFormat[]): QualityChoice[] {
  const audioOnly = formats.filter((f) => !f.vcodec && f.acodec);
  const bestAudio = [...audioOnly].sort((a, b) => (b.tbr ?? 0) - (a.tbr ?? 0))[0] ?? null;

  const score = (f: YtFormat): number => f.filesize ?? f.tbr ?? 0;

  const byHeight = new Map<number, YtFormat>();
  for (const f of formats) {
    const h = f.height;
    if (!f.vcodec || h === null) continue;
    const current = byHeight.get(h);
    // Prefer a format that already carries audio: no merge, no ffmpeg pass.
    if (
      !current ||
      (!current.acodec && f.acodec) ||
      (Boolean(current.acodec) === Boolean(f.acodec) && score(f) > score(current))
    ) {
      byHeight.set(h, f);
    }
  }

  const choices: QualityChoice[] = [];
  for (const [height, video] of [...byHeight.entries()].sort((a, b) => b[0] - a[0])) {
    const needsAudio = !video.acodec && bestAudio !== null;
    const sizes = [video.filesize, needsAudio ? bestAudio!.filesize : null];
    const known = sizes.filter((n): n is number => typeof n === 'number');

    // Carry a fallback: format ids are not stable, and a rendition listed a
    // moment ago can be gone by the time the download starts — yt-dlp then
    // fails outright with "Requested format is not available" rather than
    // giving the user the quality they asked for.
    const exact = needsAudio ? `${video.id}+${bestAudio!.id}` : video.id;
    const byHeightSelector = `bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;

    choices.push({
      formatId: `${exact}/${byHeightSelector}`,
      label: `${height}p${height >= 720 ? ' HD' : ''}${video.fps && video.fps > 30 ? ` ${video.fps}` : ''}`,
      height,
      fps: video.fps,
      ext: video.ext,
      filesize: known.length > 0 ? known.reduce((a, b) => a + b, 0) : null,
      merged: needsAudio,
      protocol: video.protocol,
    });
  }

  if (bestAudio) {
    choices.push({
      formatId: bestAudio.id,
      label: 'Audio only',
      height: null,
      fps: null,
      ext: bestAudio.ext,
      filesize: bestAudio.filesize,
      merged: false,
      protocol: bestAudio.protocol,
    });
  }

  return choices;
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
    /** Fires as soon as yt-dlp knows the real title, before any bytes move. */
    onTitle?: (title: string) => void;
    signal?: AbortSignal;
  }): Promise<{ filePath: string }> {
    const args = [
      // Warnings are not suppressed here on purpose: "the formats won't be
      // merged" arrives as a warning on an otherwise successful run, and
      // silencing it is how a silent audio-only file passes for a 1080p video.
      '--no-playlist',
      '--newline',
      // Structured progress. Regexing the human-readable bar breaks on every
      // release and on carriage-return updates.
      '--progress-template',
      'download:%(progress)j',
      '--progress-delta',
      '0.25',
      '-N',
      String(opts.concurrentFragments ?? 8),
      '-o',
      `${opts.destDir}/${opts.filenameTemplate ?? '%(title)s.%(ext)s'}`,
      '--print',
      'after_move:%(filepath)s',
      // The real title, before the download starts. Without it a page URL
      // shows as its last path segment — every YouTube download is called
      // "watch" until it finishes.
      '--print',
      `before_dl:${TITLE_MARKER}%(title)s`,
    ];
    // --ffmpeg-location takes a PATH, not a command name. Given a bare
    // "ffmpeg" it warns that the location does not exist and then continues
    // *without ffmpeg at all*, which silently disables every merge. Pass it
    // only when it really is a path; otherwise let yt-dlp find ffmpeg itself.
    if (this.ffmpeg && this.ffmpeg.includes('/')) {
      args.push('--ffmpeg-location', this.ffmpeg);
    }

    if (opts.formatId) {
      // Above 720p YouTube serves video and audio separately, so asking for a
      // rendition by id alone yields a silent file. "<id>+bestaudio/<id>" asks
      // for the merge and falls back to the format on its own when it already
      // carries audio.
      const selector = opts.formatId.includes('+')
        ? opts.formatId
        : `${opts.formatId}+bestaudio/${opts.formatId}`;
      args.push('-f', selector);

      // A preference, not a demand. Forcing mp4 makes a VP9/WebM pair
      // unmergeable: ffmpeg refuses, yt-dlp still exits 0 having printed the
      // path it intended, and all that is left on disk are the two
      // intermediates — so the "1080p" download completes as a bare .m4a.
      args.push('--merge-output-format', 'mp4/mkv/webm');
    }
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
          const trimmed = line.trim();
          const progress = parseProgressLine(trimmed);
          if (progress) {
            opts.onProgress?.(progress);
          } else if (trimmed.startsWith(TITLE_MARKER)) {
            const title = trimmed.slice(TITLE_MARKER.length).trim();
            if (title) opts.onTitle?.(title);
          } else if (trimmed.startsWith('/')) {
            // after_move:%(filepath)s
            finalPath = trimmed;
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
        if (code !== 0) {
          reject(new Error(stderr.trim().split('\n').pop() ?? `yt-dlp exited ${code}`));
          return;
        }
        // A failed merge is only a warning, so exit code 0 would otherwise
        // deliver two unusable fragments as a finished download.
        if (/won't be merged|not installed/i.test(stderr)) {
          reject(
            new Error(
              'ffmpeg is unavailable, so video and audio could not be combined. ' +
                'Install ffmpeg, or set its path in Settings.',
            ),
          );
          return;
        }
        resolve({ filePath: finalPath });
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
    // Replaces the staged download with its remuxed copy — both still inside
    // the staging directory, so nothing of the user's is at stake.
    await replaceWorkingFile(tmp, filePath);
    return { remuxed: true, container: 'mp4' };
  } catch {
    await removeWorkingFile(tmp).catch(() => {});
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
