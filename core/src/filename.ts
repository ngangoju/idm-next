/**
 * Filename resolution and sanitization.
 *
 * The name we end up using comes from a remote server and is about to become a
 * filesystem path, so every branch here is a security boundary, not cosmetics.
 */
import { basename, extname, join, resolve, sep } from 'node:path';
import { access } from 'node:fs/promises';

/** Windows forbids these basenames regardless of extension. */
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** Most filesystems cap a single component at 255 bytes. */
const MAX_NAME_BYTES = 255;

/** Control characters plus the set Windows rejects in a filename. */
const ILLEGAL = new RegExp('[\\u0000-\\u001f\\u007f<>:"|?*]', 'g');

/**
 * Parse Content-Disposition, preferring RFC 5987 `filename*` (which carries an
 * explicit charset) over the legacy `filename`.
 */
export function parseContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;

  // filename*=UTF-8''foo%20bar.zip
  const ext = /filename\*\s*=\s*([^']*)'([^']*)'([^;]+)/i.exec(header);
  if (ext?.[3]) {
    try {
      return decodeURIComponent(ext[3].trim());
    } catch {
      /* malformed percent-encoding; fall through to the plain form */
    }
  }

  // filename="foo bar.zip"  |  filename=foo.zip
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header);
  const raw = plain?.[2] ?? plain?.[3];
  return raw ? raw.trim() : null;
}

/** Derive a candidate name from the URL path, ignoring the query string. */
export function nameFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const base = decodeURIComponent(basename(path));
    return base && base !== '/' ? base : null;
  } catch {
    return null;
  }
}

/**
 * Reduce an arbitrary string to a single safe path component.
 *
 * Strips directory separators outright rather than escaping them: a server that
 * sends `../../etc/passwd` gets `etcpasswd`, never a traversal.
 */
export function sanitizeFilename(input: string, fallback = 'download'): string {
  let name = input.normalize('NFC');

  // Directory separators and leading traversal dots, in one pass.
  name = name.replace(/[/\\]/g, '');
  name = name.replace(/^\.+/, '');
  name = name.replace(ILLEGAL, '');

  // Trailing dots and spaces are silently dropped by Windows, which turns
  // "a. " into "a" behind our back; do it ourselves so the name we record is
  // the name that actually lands on disk.
  name = name.replace(/[. ]+$/, '').trim();

  if (!name) return fallback;

  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;

  if (RESERVED.has(stem.toUpperCase())) {
    name = `_${name}`;
  }

  return clampBytes(name, MAX_NAME_BYTES) || fallback;
}

/**
 * Trim to a byte budget without splitting a UTF-8 sequence, preserving the
 * extension — a truncated name is survivable, a lost extension is not.
 */
function clampBytes(name: string, maxBytes: number): string {
  if (Buffer.byteLength(name, 'utf8') <= maxBytes) return name;

  const ext = extname(name).slice(0, maxBytes);
  const budget = maxBytes - Buffer.byteLength(ext, 'utf8');
  const stem = ext ? name.slice(0, -ext.length) : name;

  let out = '';
  let used = 0;
  for (const ch of stem) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return out + ext;
}

/**
 * The extension a Content-Type implies, for names that arrive without one.
 *
 * Deliberately short: only types a person would expect to double-click. An
 * HTML response is not in it — a "download" that turns out to be a page is
 * almost always an error or a login wall, and naming it .html hides that.
 */
const TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'heic',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/mp2t': 'ts',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-7z-compressed': '7z',
  'application/vnd.rar': 'rar',
  'application/x-rar-compressed': 'rar',
  'application/gzip': 'gz',
  'application/x-apple-diskimage': 'dmg',
  'application/vnd.android.package-archive': 'apk',
  'application/epub+zip': 'epub',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/csv': 'csv',
};

export function extensionForType(contentType: string | null | undefined): string | null {
  if (!contentType) return null;
  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  return TYPE_EXTENSIONS[mime] ?? null;
}

/**
 * Does this name already carry a real extension?
 *
 * `extname` alone says yes to "v1.2" and "Mr. Robot"; an extension is short
 * and has at least one letter in it.
 */
function hasExtension(name: string): boolean {
  const ext = extname(name).slice(1);
  return ext.length >= 1 && ext.length <= 5 && /^[a-z0-9]+$/i.test(ext) && /[a-z]/i.test(ext);
}

/**
 * Pick the final name, in precedence order, and sanitize it.
 * `override` is trusted less than it looks — it still goes through sanitize.
 *
 * A name with no extension gets one from the Content-Type. Plenty of CDNs
 * serve files from paths that never had one — X's images live at
 * `/media/<id>?format=jpg` — and a file with no extension is one the OS will
 * not open.
 */
export function resolveFilename(opts: {
  override?: string | undefined;
  /** Already-parsed name from Content-Disposition, if the server sent one. */
  suggested?: string | null | undefined;
  url: string;
  contentType?: string | null | undefined;
}): string {
  const candidate = opts.override ?? opts.suggested ?? nameFromUrl(opts.url);
  const name = sanitizeFilename(candidate ?? 'download');
  if (hasExtension(name)) return name;
  const ext = extensionForType(opts.contentType);
  return ext ? sanitizeFilename(`${name}.${ext}`) : name;
}

/**
 * Join into destDir and prove the result stayed inside it. Defence in depth:
 * sanitizeFilename should already have made traversal impossible.
 */
export function safeJoin(destDir: string, filename: string): string {
  const dir = resolve(destDir);
  const full = resolve(join(dir, sanitizeFilename(filename)));
  if (full !== dir && !full.startsWith(dir + sep)) {
    throw new Error(`Refusing to write outside ${dir}`);
  }
  return full;
}

/** Turn `report.pdf` into `report (1).pdf` when the path is taken. */
export async function uniquePath(fullPath: string): Promise<string> {
  const exists = async (p: string) => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  };

  if (!(await exists(fullPath))) return fullPath;

  const ext = extname(fullPath);
  const stem = ext ? fullPath.slice(0, -ext.length) : fullPath;
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${stem} (${Date.now()})${ext}`;
}
