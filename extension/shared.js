/**
 * Shared helpers for the background worker and popup.
 *
 * Plain JS on purpose: the extension loads unpacked with no build step, which
 * matters because "load unpacked, reload, test" is the whole development loop.
 */

export const API = 'http://127.0.0.1:47591';

/** Media types we offer to grab. */
export const MEDIA_TYPES = [
  'video/',
  'audio/',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/dash+xml',
];

export const MEDIA_EXTENSIONS = [
  'mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'ts', 'mpg', 'mpeg', 'wmv',
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma',
];

export const ARCHIVE_EXTENSIONS = [
  'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg', 'pkg', 'exe',
  'msi', 'deb', 'rpm', 'apk', 'pdf', 'epub',
];

/**
 * Ignore anything below this. Ad beacons, tracking pixels and thumbnail
 * sprites are served with media content types constantly, and without a floor
 * the popup fills with junk. Manifests are exempt — they are tiny by design.
 */
export const MIN_MEDIA_BYTES = 200 * 1024;

/** Query parameters that change per request and would defeat deduplication. */
const VOLATILE_PARAMS = [
  'range', 'start', 'end', 'offset', 'seek', 't', 'time', 'timestamp',
  '_', 'cachebust', 'sig', 'signature', 'expires', 'token', 'nonce', 'bytestart', 'byteend',
  // Streaming players re-request the same rendition constantly with a moving
  // range and a request counter; without these one video becomes fifty rows.
  'rn', 'rbuf', 'cpn', 'ver', 'cver', 'alr', 'gir', 'dur', 'lmt', 'keepalive',
  'ratebypass', 'pcm2cms', 'aitags', 'requiressl', 'ei', 'ip', 'initcwndbps',
];

/**
 * Endpoints that are never a download, however they are labelled.
 *
 * Subtitle, telemetry and API endpoints on streaming sites are frequently
 * served as attachments, which would otherwise walk straight past the type
 * check and fill the panel with 1 KB JSON files.
 */
const NOISE_PATHS = [
  '/api/timedtext', '/timedtext',
  '/youtubei/', '/api/stats', '/ptracking', '/generate_204', '/log_event',
  '/gen_204', '/csi_204', '/qoe', '/atr', '/pagead/', '/doubleclick',
];

/** Content types that are never, on their own, something a user wants. */
const NEVER_TYPES = [
  'application/json', 'application/xml', 'text/', 'application/javascript',
  'application/x-javascript', 'application/x-www-form-urlencoded',
];

/** Extensions that mean "this is part of a web page", not "this is a file". */
const WEB_EXTENSIONS = ['json', 'html', 'htm', 'xml', 'js', 'mjs', 'css', 'map'];

/** The filename a Content-Disposition claims, if it claims one. */
export function dispositionFilename(header) {
  if (!header) return null;
  const ext = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (ext?.[1]) {
    try {
      return decodeURIComponent(ext[1].trim());
    } catch {
      /* malformed encoding; fall through */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|([^;]+))/i.exec(header);
  const raw = plain?.[2] ?? plain?.[3];
  return raw ? raw.trim() : null;
}

function isNoiseUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.toLowerCase();
    return NOISE_PATHS.some((p) => path.includes(p));
  } catch {
    return false;
  }
}

/**
 * `bytes 0-65535/189000000` -> 189000000.
 *
 * A streaming player fetches media in small ranged chunks, so Content-Length
 * describes the chunk, not the file. Judging size by the chunk rejected every
 * real video on YouTube for being "too small"; the total is only ever here.
 */
export function parseContentRangeTotal(header) {
  if (!header) return null;
  const m = /^bytes\s+(?:\d+-\d+|\*)\/(\d+)$/i.exec(String(header).trim());
  if (!m) return null;
  const total = Number(m[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/**
 * Key used to deduplicate detections.
 *
 * A player seeking through a video fires dozens of requests that differ only in
 * a range or timestamp parameter; without this the popup shows fifty copies of
 * one file.
 */
export function dedupeKey(rawUrl) {
  try {
    const u = new URL(rawUrl);

    // When a URL identifies its rendition with an itag, that is the identity:
    // everything else on a googlevideo URL is per-request noise.
    const itag = u.searchParams.get('itag');
    if (itag) return `${u.origin}${u.pathname}#itag=${itag}`;

    for (const p of VOLATILE_PARAMS) u.searchParams.delete(p);
    return `${u.origin}${u.pathname}?${u.searchParams.toString()}`;
  } catch {
    return rawUrl;
  }
}

export function extensionOf(rawUrl) {
  try {
    const path = new URL(rawUrl).pathname;
    const last = path.split('/').pop() ?? '';
    return last.includes('.') ? last.split('.').pop().toLowerCase() : '';
  } catch {
    return '';
  }
}

export function filenameOf(rawUrl) {
  try {
    const name = decodeURIComponent(new URL(rawUrl).pathname.split('/').pop() ?? '');
    return name || 'download';
  } catch {
    return 'download';
  }
}

export function isManifest(url, contentType) {
  const ext = extensionOf(url);
  if (ext === 'm3u8' || ext === 'mpd') return true;
  const ct = (contentType ?? '').toLowerCase();
  return ct.includes('mpegurl') || ct.includes('dash+xml');
}

/** Classify a detection for the popup. */
export function kindOf(url, contentType) {
  if (isManifest(url, contentType)) return 'stream';
  const ct = (contentType ?? '').toLowerCase();
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';

  const ext = extensionOf(url);
  if (['mp4', 'mkv', 'webm', 'mov', 'avi', 'flv', 'm4v', 'ts'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus'].includes(ext)) return 'audio';
  return 'file';
}

/**
 * Decide whether a response is something we should offer to download.
 *
 * Pure so it can be tested without a browser — this is where the false
 * positives (ad beacons, tracking pixels, thumbnail sprites) and false
 * negatives (manifests, attachments with no useful content type) live.
 */
export function shouldRecord({ url, contentType, size, contentDisposition }) {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const ext = extensionOf(url);

  if (isNoiseUrl(url)) return false;

  const manifest = isManifest(url, ct);
  if (manifest) return true; // Manifests are tiny by design; no size floor.

  const typeMatch = MEDIA_TYPES.some((t) => ct.startsWith(t));
  const extMatch = MEDIA_EXTENSIONS.includes(ext) || ARCHIVE_EXTENSIONS.includes(ext);
  const attachment = (contentDisposition ?? '').toLowerCase().includes('attachment');

  const neverType = NEVER_TYPES.some((t) => ct.startsWith(t));

  // An attachment used to be admitted unconditionally, before any type check,
  // so subtitle and API endpoints — which are served that way — filled the
  // panel with 1 KB JSON files while the actual video was nowhere in it.
  //
  // The signal that separates the two is not the content type: a CSV export is
  // `text/csv` and is a perfectly real download. It is whether the response
  // names a file. A genuine attachment says `filename="report.csv"`; an API
  // endpoint dressed as one names nothing, or names a web document.
  if (attachment) {
    const named = dispositionFilename(contentDisposition);
    const namedExt = named && named.includes('.') ? named.split('.').pop().toLowerCase() : '';
    if (namedExt) return !WEB_EXTENSIONS.includes(namedExt);
    return !neverType;
  }

  if (neverType && !extMatch) return false;
  if (!typeMatch && !extMatch) return false;

  // `size` must be the size of the FILE. The caller resolves it from
  // Content-Range when the response is a range, because Content-Length then
  // describes only the chunk.
  if (size !== null && size !== undefined && size < MIN_MEDIA_BYTES) return false;
  return true;
}

/* --------------------------- detection store --------------------------- */
/*
 * Per-tab detections live in chrome.storage.session, never in a module-level
 * Map. The MV3 service worker is torn down after ~30 seconds idle, taking all
 * in-memory state with it — that is exactly the bug where detected videos
 * silently vanish while the user is still looking at the page.
 */

const KEY = (tabId) => `media:${tabId}`;

export async function getDetections(tabId) {
  const store = await chrome.storage.session.get(KEY(tabId));
  return store[KEY(tabId)] ?? [];
}

export async function addDetection(tabId, item) {
  const existing = await getDetections(tabId);
  const key = dedupeKey(item.url);

  const idx = existing.findIndex((d) => dedupeKey(d.url) === key);
  if (idx >= 0) {
    // Keep whichever copy knows more; a later sighting often has the size.
    existing[idx] = { ...existing[idx], ...item, size: item.size ?? existing[idx].size };
  } else {
    existing.push(item);
  }

  // Bound it, so a long-lived tab on a streaming site cannot grow without end.
  const trimmed = existing.slice(-60);
  await chrome.storage.session.set({ [KEY(tabId)]: trimmed });
  await updateBadge(tabId, trimmed.length);
  return trimmed.length;
}

export async function clearDetections(tabId) {
  await chrome.storage.session.remove(KEY(tabId));
  await updateBadge(tabId, 0);
}

export async function updateBadge(tabId, count) {
  try {
    await chrome.action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#4c8dff' });
  } catch {
    // The tab may have closed between detection and badge update.
  }
}

/* ------------------------------ app calls ------------------------------ */

export async function callApp(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`IDM-Next returned ${res.status}`);
  return res.json();
}

export async function appIsRunning() {
  try {
    const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Collect the request context a download needs to succeed when replayed from
 * outside the browser: the page's cookies, its referer, and our user agent.
 * Without these, anything behind a login 401s or 403s.
 */
export async function contextHeadersFor(url, pageUrl) {
  const headers = {};
  try {
    const cookies = await chrome.cookies.getAll({ url });
    if (cookies.length > 0) {
      headers.cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    }
  } catch {
    // cookies permission may be absent on some installs; proceed without.
  }
  if (pageUrl) headers.referer = pageUrl;
  headers['user-agent'] = navigator.userAgent;
  return headers;
}
