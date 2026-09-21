/**
 * MV3 service worker.
 *
 * Two hard constraints shape everything here:
 *
 *  1. This worker is torn down after ~30s idle. Nothing may live in a
 *     module-level variable across events — all state goes to
 *     chrome.storage.session, and every listener must work on a cold start.
 *  2. chrome.downloads.cancel() cannot be undone, so we never cancel before we
 *     know the download can actually be replayed.
 */
import {
  MEDIA_EXTENSIONS,
  ARCHIVE_EXTENSIONS,
  shouldRecord,
  parseContentRangeTotal,
  addDetection,
  clearDetections,
  getDetections,
  callApp,
  appIsRunning,
  contextHeadersFor,
  filenameOf,
  isManifest,
  kindOf,
} from './shared.js';

/* ----------------------------- detection ----------------------------- */

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    // Observe-only: MV3 removed blocking webRequest, but we only need to look.
    if (details.tabId < 0) return;
    void recordIfMedia(details);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

async function recordIfMedia(details) {
  const headers = Object.fromEntries(
    (details.responseHeaders ?? []).map((h) => [h.name.toLowerCase(), h.value ?? '']),
  );

  const contentType = (headers['content-type'] ?? '').split(';')[0].trim();

  // Content-Length describes this response; on a ranged request that is one
  // chunk of the file, not the file. Streaming players fetch media in small
  // ranges, so judging by Content-Length rejected every real video for being
  // too small. Content-Range carries the only true total.
  const total = parseContentRangeTotal(headers['content-range']);
  const length = headers['content-length'] ? Number(headers['content-length']) : null;
  const size = total ?? length;

  if (!shouldRecord({
    url: details.url,
    contentType,
    size,
    contentDisposition: headers['content-disposition'],
  })) {
    return;
  }

  const manifest = isManifest(details.url, contentType);

  let pageUrl = '';
  try {
    pageUrl = (await chrome.tabs.get(details.tabId)).url ?? '';
  } catch {
    return; // tab gone
  }

  await addDetection(details.tabId, {
    url: details.url,
    kind: kindOf(details.url, contentType),
    contentType: contentType || null,
    size: Number.isFinite(size) ? size : null,
    title: filenameOf(details.url),
    pageUrl,
    isManifest: manifest,
    detectedAt: Date.now(),
  });
  notifyTab(details.tabId);
}

/**
 * Tell the page's panel its list changed. The content script cannot poll for
 * this — the worker owns the registry — and without it the panel would show
 * whatever was known at load time and never update as renditions appear.
 */
function notifyTab(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'media-updated' }).catch(() => {
    // No content script on this tab (a PDF viewer, a chrome:// page); fine.
  });
}

/** Detections reported by the content script's DOM scan. */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'media-found' && sender.tab?.id !== undefined) {
    const tabId = sender.tab.id;
    void addDetection(tabId, {
      url: msg.url,
      kind: msg.kind ?? kindOf(msg.url, null),
      contentType: null,
      size: null,
      // The <video> element's own height is the only trustworthy quality
      // signal for a plain source; everything else is inferred from the URL.
      ...(msg.height ? { height: msg.height } : {}),
      title: msg.title ?? filenameOf(msg.url),
      pageUrl: sender.tab.url ?? '',
      isManifest: isManifest(msg.url, null),
      detectedAt: Date.now(),
    }).then(() => notifyTab(tabId));
    return false;
  }

  if (msg?.type === 'download') {
    // Must return true synchronously to keep the channel open.
    void startDownload(msg.url, msg.pageUrl, msg.filename)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'list') {
    void (async () => {
      const tabId = msg.tabId ?? sender.tab?.id;
      sendResponse({ items: tabId === undefined ? [] : await getDetections(tabId) });
    })();
    return true;
  }

  return false;
});

/** Clear a tab's registry on navigation and on close. */
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && info.url) void clearDetections(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => void clearDetections(tabId));

/* ------------------------------ takeover ------------------------------ */

/**
 * Take over a download the browser started — but only after proving we can
 * fetch it ourselves.
 *
 * chrome.downloads.cancel() is irreversible, and a one-time or signed URL, or
 * anything initiated by POST, will 403 when we replay it. Cancelling first and
 * discovering that afterwards destroys the user's download with nothing to fall
 * back on. So: probe, and only cancel on proof.
 */
chrome.downloads.onCreated.addListener((item) => {
  void maybeTakeOver(item);
});

async function maybeTakeOver(item) {
  const { takeoverEnabled = true } = await chrome.storage.local.get('takeoverEnabled');
  if (!takeoverEnabled) return;
  if (!item.url || !/^https?:/.test(item.url)) return;
  if (item.state !== 'in_progress') return;

  // A POST-initiated download cannot be replayed as a GET at all.
  if (item.method && item.method.toUpperCase() !== 'GET') return;

  if (!(await appIsRunning())) return;

  const headers = await contextHeadersFor(item.url, item.referrer);

  let verdict;
  try {
    verdict = await callApp('/probe', { url: item.url, headers });
  } catch {
    return; // App unreachable: leave Chrome's download alone.
  }

  if (!verdict.canTakeOver) {
    // Chrome keeps the download. This is the correct outcome, not a failure.
    return;
  }

  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch {
    // Already finished or cancelled by the user; don't start a duplicate.
    return;
  }

  await callApp('/downloads', {
    url: item.url,
    filename: verdict.filename ?? item.filename?.split(/[/\\]/).pop() ?? undefined,
    headers,
    sourcePage: item.referrer || undefined,
  });

  notify('Download taken over', verdict.filename ?? filenameOf(item.url));
}

/* ------------------------------ actions ------------------------------ */

export async function startDownload(url, pageUrl, filename) {
  if (!(await appIsRunning())) {
    notify('IDM-Next is not running', 'Start the IDM-Next app and try again.');
    return { ok: false, error: 'app not running' };
  }

  const headers = await contextHeadersFor(url, pageUrl);
  await callApp('/downloads', {
    url,
    headers,
    filename: filename || undefined,
    sourcePage: pageUrl || undefined,
  });
  return { ok: true };
}

/* ---------------------------- context menu ---------------------------- */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'idm-link',
      title: 'Download with IDM-Next',
      contexts: ['link', 'video', 'audio', 'image'],
    });
    chrome.contextMenus.create({
      id: 'idm-all-links',
      title: 'Download all links on this page',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'idm-all-media',
      title: 'Download all media on this page',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  void (async () => {
    if (info.menuItemId === 'idm-link') {
      const target = info.linkUrl ?? info.srcUrl;
      if (target) await startDownload(target, info.pageUrl);
      return;
    }

    if (info.menuItemId === 'idm-all-media') {
      const items = await getDetections(tab?.id ?? -1);
      for (const item of items) await startDownload(item.url, item.pageUrl, item.title);
      notify('IDM-Next', `Queued ${items.length} item(s).`);
      return;
    }

    if (info.menuItemId === 'idm-all-links' && tab?.id !== undefined) {
      const [{ result: links } = { result: [] }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => Array.from(document.querySelectorAll('a[href]')).map((a) => a.href),
      });

      const wanted = (links ?? []).filter((href) => {
        const ext = href.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
        return MEDIA_EXTENSIONS.includes(ext) || ARCHIVE_EXTENSIONS.includes(ext);
      });

      for (const href of [...new Set(wanted)]) await startDownload(href, info.pageUrl);
      notify('IDM-Next', `Queued ${wanted.length} link(s).`);
    }
  })();
});

function notify(title, message) {
  // notifications is an optional permission; fall back to the badge silently.
  try {
    chrome.notifications?.create({
      type: 'basic',
      title,
      message,
      iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    });
  } catch {
    /* no-op */
  }
}
