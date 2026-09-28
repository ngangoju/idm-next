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

/**
 * Query parameters that genuinely identify *which* file is being requested.
 *
 * The list is an allowlist rather than a blocklist because CDN URLs are mostly
 * signature and routing: Instagram alone carries oh, oe, efg, ccb, bytestart,
 * byteend and a dozen _nc_* parameters, all of which change per request. A
 * blocklist has to guess them all, and each one it misses becomes another
 * duplicate row — which is how one video became thirty-seven.
 */
const IDENTITY_PARAMS = ['itag', 'quality', 'res', 'resolution', 'format', 'fmt', 'type', 'vq'];

/**
 * A title that is just the site's name tells the user nothing about which
 * file a row is. Instagram's reel pages often report exactly this.
 */
const SITE_NAMES = new Set([
  'instagram', 'youtube', 'facebook', 'vimeo', 'tiktok', 'twitter', 'x',
  'reddit', 'twitch', 'dailymotion', 'video', 'watch', 'home', 'feed',
]);

export function isSiteName(title) {
  return SITE_NAMES.has((title ?? '').trim().toLowerCase());
}

/** Endpoint names shared by every file on a site, so they identify nothing. */
const GENERIC_NAMES = new Set([
  'videoplayback', 'watch', 'download', 'index', 'master', 'playlist',
  'video', 'audio', 'media', 'file', 'stream', 'play', 'get', 'v', 'dl',
]);

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
 * Extract total file size from `clen` parameter if present (common on googlevideo URLs).
 */
export function parseClen(rawUrl) {
  try {
    const clen = new URL(rawUrl).searchParams.get('clen');
    if (!clen) return null;
    const n = Number(clen);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Does this URL indicate a ranged chunk request?
 */
export function isRangedUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.searchParams.has('range') || u.searchParams.has('bytestart');
  } catch {
    return false;
  }
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

    // Keep only the parameters that say which file this is; the path plus
    // those is the identity, and everything else is per-request noise.
    const identity = IDENTITY_PARAMS.map((p) => {
      const v = u.searchParams.get(p);
      return v === null ? null : `${p}=${v}`;
    }).filter(Boolean);

    return `${u.origin}${u.pathname}${identity.length ? `#${identity.join('&')}` : ''}`;
  } catch {
    return rawUrl;
  }
}

/**
 * Is this filename meaningless to a person?
 *
 * CDNs name media with signed opaque blobs — Instagram's look like
 * "AQMOZ1cfHZuJEuODZ770FSIURCg9L7NMAYjQnJSRDfdCrj4lFYNqzU". Listing thirty of
 * those gives the user nothing to choose between, so the page title is a
 * better label even though it is less specific.
 */
export function looksOpaqueName(name) {
  if (!name) return true;

  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;

  // Endpoint names that every file on a site shares. Short, so the
  // length-based checks below would never catch them.
  if (GENERIC_NAMES.has(stem.toLowerCase())) return true;

  if (stem.length < 16) return false;

  // A UUID is an identifier however it is punctuated.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stem)) return true;

  // Otherwise judge the longest unbroken run. A real name breaks into short
  // words — "annual-report-2026", "ubuntu-24.04-desktop" — while a CDN token
  // is one long random stretch, even when it happens to contain an underscore.
  const longest = stem.split(/[\s._-]+/).reduce((a, b) => (b.length > a.length ? b : a), '');
  if (longest.length < 16) return false;

  const hasUpper = /[A-Z]/.test(longest);
  const hasLower = /[a-z]/.test(longest);
  const hasDigit = /\d/.test(longest);
  return (hasUpper && hasLower && hasDigit) || /^[0-9a-f]{20,}$/i.test(longest);
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
/**
 * Content types that identify media we can see but cannot fetch on our own.
 *
 * YouTube's SABR/UMP transport multiplexes video and audio into one stream
 * requested by POST with a protobuf body, so the URL is not replayable — there
 * is nothing to hand a downloader. Recognising it is still worth doing: it
 * tells us to offer page-level extraction instead of pretending to find
 * nothing.
 */
export const UNFETCHABLE_TYPES = ['application/vnd.yt-ump', 'application/x-ump'];

export function isUnfetchableStream(contentType) {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return UNFETCHABLE_TYPES.includes(ct);
}

/**
 * One piece of an adaptive stream rather than a whole file.
 *
 * X plays video as DASH: the player fetches hundreds of `.m4s` segments, each
 * a second or two long, served as video/mp4. Recorded as files, each looked
 * like a download — and one downloaded gave a 1 MB fragment that is not the
 * video and often will not play at all without its init segment. Like SABR,
 * seeing one is a sign to offer the page to yt-dlp, which assembles the whole
 * stream.
 */
const FRAGMENT_EXTENSIONS = ['m4s', 'cmfv', 'cmfa'];

export function isStreamFragment(url) {
  return FRAGMENT_EXTENSIONS.includes(extensionOf(url));
}

/**
 * A page title, as the name for something downloaded from it.
 *
 * Site suffixes go ("… - YouTube", "… / X"), and X's own format —
 * `Name on X: "the post text" / X` — becomes `Name - the post text`, without
 * the t.co link that ends most posts.
 */
export function cleanPageTitle(raw) {
  let t = (raw ?? '')
    .replace(/^\(\d+\)\s*/, '')
    .replace(/\s*[-–—|•·/]\s*(YouTube|Instagram|Vimeo|Facebook|X|Twitter|TikTok|Reddit)\s*$/i, '')
    .trim();
  const post = /^(.*?) on (?:X|Twitter): ["“]([\s\S]*)["”]$/.exec(t);
  if (post) t = `${post[1]} - ${post[2]}`;
  return t
    .replace(/\s*https?:\/\/t\.co\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Was this response at least media-adjacent?
 *
 * Used to decide whether a rejection is worth reporting. A rejected stylesheet
 * is noise; a rejected video/mp4 is a clue.
 */
export function looksMediaAdjacent(url, contentType) {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.startsWith('video/') || ct.startsWith('audio/')) return true;
  if (isUnfetchableStream(ct)) return true;
  try {
    const host = new URL(url).hostname;
    if (/googlevideo\.com$|\.akamaized\.net$|cdn|media|stream/i.test(host)) return true;
  } catch {
    /* unparseable */
  }
  return MEDIA_EXTENSIONS.includes(extensionOf(url));
}

/**
 * The decision, with the reason for it.
 *
 * `shouldRecord` is the boolean form. The reason matters because "nothing was
 * detected" is not an explanation a user can act on — and on a page that has
 * clearly been playing video, it is usually wrong in an interesting way.
 */
export function classify({ url, contentType, size, contentDisposition }) {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();

  if (isNoiseUrl(url)) return { ok: false, reason: 'telemetry or subtitle endpoint' };
  if (isUnfetchableStream(ct)) {
    return { ok: false, reason: 'YouTube SABR/UMP stream — not fetchable by URL' };
  }
  if (isStreamFragment(url)) {
    return { ok: false, reason: 'a fragment of a streamed video, not the whole file' };
  }
  if (!shouldRecordInner({ url, contentType, size, contentDisposition })) {
    const floored =
      size !== null && size !== undefined && size < MIN_MEDIA_BYTES && ct.startsWith('video/');
    return { ok: false, reason: floored ? 'below the size floor' : 'not a downloadable type' };
  }
  return { ok: true, reason: '' };
}

export function shouldRecord(input) {
  return shouldRecordInner(input);
}

function shouldRecordInner({ url, contentType, size, contentDisposition }) {
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
    // Keep whichever copy knows more; a later sighting often has the size or real title.
    const prev = existing[idx];
    const preferredTitle =
      item.title && item.title !== 'videoplayback' && item.title !== 'download'
        ? item.title
        : prev.title;
    existing[idx] = {
      ...prev,
      ...item,
      size: item.size ?? prev.size,
      title: preferredTitle || prev.title || item.title,
    };
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
  await chrome.storage.session.remove([KEY(tabId), REJECT_KEY(tabId)]);
  await updateBadge(tabId, 0);
}

/* --------------------------- rejection log --------------------------- */
/*
 * "Nothing detected" is not a diagnosis. When a page has obviously been
 * playing video and the panel is empty, the useful question is what arrived
 * and why it was turned down — so media-adjacent rejections are kept, briefly,
 * and surfaced in the popup.
 */

const REJECT_KEY = (tabId) => `rejects:${tabId}`;

export async function getRejects(tabId) {
  const store = await chrome.storage.session.get(REJECT_KEY(tabId));
  return store[REJECT_KEY(tabId)] ?? [];
}

export async function recordReject(tabId, entry) {
  const existing = await getRejects(tabId);
  const key = dedupeKey(entry.url);
  if (existing.some((e) => dedupeKey(e.url) === key)) return;
  existing.push(entry);
  await chrome.storage.session.set({ [REJECT_KEY(tabId)]: existing.slice(-25) });
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

/**
 * Ask the app what qualities a page offers.
 *
 * This is the only route that works on a site whose media URLs are not
 * fetchable on their own, and it is also the only one that can promise sound
 * with HD — the app pairs video-only renditions with an audio track.
 */
export async function extractQualities(pageUrl) {
  const res = await fetch(`${API}/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: pageUrl }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error ?? `extraction failed (${res.status})`);
  return body;
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
