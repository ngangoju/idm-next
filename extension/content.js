/**
 * Content script: the floating download panel.
 *
 * Modelled on IDM's: a bar pinned over the player that opens a list of every
 * variant found on the page, with "Download all" at the top. Two panels exist:
 *
 *   - a media panel anchored to each <video>/<audio> element;
 *   - a page panel in the corner, for pages whose downloads are documents or
 *     archives and have no media element to anchor to.
 *
 * Everything visible lives in a closed shadow root. On a media site the host
 * page's CSS is aggressive and global, and without isolation this is a layout
 * bug rather than a button.
 */

(() => {
  if (window.__idmNextInjected) return;
  window.__idmNextInjected = true;

  const Z = '2147483647';
  const reported = new Set();
  /** Panels currently on the page, so a refresh can re-render their lists. */
  const panels = new Set();
  /** Elements the user closed; we do not put the panel back on them. */
  const dismissed = new WeakSet();
  let pageDismissed = false;

  /* ------------------------------ labels ------------------------------ */

  const RES_PATTERNS = [
    /(\d{3,4})p(?:60)?\b/i,
    /\b(?:hd|h)(\d{3,4})\b/i,
    /[_\-/](\d{3,4})x(\d{3,4})[_\-/.]/i,
  ];

  /**
   * YouTube serves every rendition from the same host with the quality encoded
   * only as an `itag`. Without this map the list reads "MP4 file" five times
   * over, which is exactly the case the panel exists to disambiguate.
   */
  const ITAG = {
    17: '144p', 160: '144p', 278: '144p',
    133: '240p', 242: '240p', 5: '240p',
    134: '360p', 243: '360p', 18: '360p', 396: '360p',
    135: '480p', 244: '480p', 397: '480p',
    136: '720p', 247: '720p', 22: '720p', 298: '720p60', 398: '720p',
    137: '1080p', 248: '1080p', 299: '1080p60', 399: '1080p',
    271: '1440p', 308: '1440p60',
    313: '2160p', 315: '2160p60', 401: '2160p',
    140: 'audio 128k', 139: 'audio 48k', 251: 'audio opus', 250: 'audio opus',
  };

  function itagQuality(url) {
    try {
      const itag = new URL(url).searchParams.get('itag');
      return itag ? (ITAG[Number(itag)] ?? null) : null;
    } catch {
      return null;
    }
  }

  /** Best-effort quality, the way IDM labels its list. */
  function qualityOf(item) {
    const fromItag = itagQuality(item.url);
    if (fromItag) return fromItag.startsWith('audio') ? fromItag : withHd(parseInt(fromItag, 10));

    if (item.height) return withHd(item.height);

    for (const re of RES_PATTERNS) {
      const m = re.exec(item.url);
      if (m) {
        const h = Number(m[2] ?? m[1]);
        if (h >= 100 && h <= 4320) return withHd(h);
      }
    }
    return null;
  }

  function withHd(h) {
    return `${h}p${h >= 720 ? ' HD' : ''}`;
  }

  function extensionOf(url) {
    try {
      const last = new URL(url).pathname.split('/').pop() ?? '';
      return last.includes('.') ? last.split('.').pop().toLowerCase() : '';
    } catch {
      return '';
    }
  }

  function humanSize(n) {
    if (!n) return null;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  /**
   * The container, for the "MP4 file" part of the label.
   *
   * A streaming URL usually has no extension in its path — YouTube's is just
   * /videoplayback — so fall back to the content type, then to the `mime`
   * query parameter those URLs carry.
   */
  function containerOf(item) {
    const ext = extensionOf(item.url);
    if (ext) return ext;

    const sub = (item.contentType ?? '').split('/')[1];
    if (sub) return sub.split(';')[0].replace(/^x-/, '');

    try {
      const mime = new URL(item.url).searchParams.get('mime');
      if (mime) return mime.split('/')[1]?.replace(/^x-/, '') ?? '';
    } catch {
      /* not a parseable URL */
    }
    return '';
  }

  /**
   * "Streets of Rage 2 Stage 1, MP4 file, quality 720p HD" — the same shape
   * IDM uses: what it is, then what kind, then how good.
   */
  function describe(item) {
    const parts = [];
    parts.push(item.title || 'Media file');

    const container = containerOf(item);
    if (item.isManifest) parts.push('Streaming video');
    else if (container) parts.push(`${container.toUpperCase()} file`);

    const quality = qualityOf(item);
    if (quality) parts.push(`quality ${quality}`);
    else {
      const size = humanSize(item.size);
      if (size) parts.push(size);
    }
    return parts.join(', ');
  }

  /* ------------------------------ panels ------------------------------ */

  const PANEL_CSS = `
    :host { all: initial; }
    .wrap {
      position: absolute;
      z-index: ${Z};
      font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #eef1f6;
      user-select: none;
    }
    .bar {
      display: inline-flex; align-items: center; gap: 8px;
      background: rgba(14, 17, 22, .94);
      border: 1px solid rgba(255,255,255,.16);
      border-radius: 8px;
      padding: 7px 9px;
      box-shadow: 0 4px 18px rgba(0,0,0,.45);
      backdrop-filter: blur(6px);
      cursor: pointer;
      transition: background .13s ease, border-color .13s ease;
    }
    .bar:hover { background: rgba(24,30,40,.97); border-color: rgba(122,162,255,.55); }
    .mark { display: grid; place-items: center; width: 17px; height: 17px; border-radius: 5px;
            background: linear-gradient(145deg,#7aa2ff,#5b8cff); color: #fff; flex: none; }
    .label { white-space: nowrap; font-weight: 550; }
    .count { font-size: 10.5px; color: #9aa3b2; background: rgba(255,255,255,.08);
             padding: 1px 6px; border-radius: 99px; }
    .icon-btn { display: grid; place-items: center; width: 18px; height: 18px;
                border: none; background: none; color: #9aa3b2; cursor: pointer;
                border-radius: 4px; padding: 0; font: inherit; }
    .icon-btn:hover { background: rgba(255,255,255,.1); color: #fff; }

    .wrap { display: flex; flex-direction: column; align-items: center; }
    .menu {
      margin-top: 5px;
      align-self: stretch;
      min-width: 320px; max-width: 460px;
      background: rgba(14,17,22,.97);
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 9px;
      box-shadow: 0 12px 40px rgba(0,0,0,.55);
      backdrop-filter: blur(8px);
      overflow: hidden;
      display: none;
    }
    .menu.open { display: block; }
    .menu-head {
      padding: 9px 12px; font-weight: 600; cursor: pointer;
      border-bottom: 1px solid rgba(255,255,255,.09);
    }
    .menu-head:hover { background: rgba(122,162,255,.16); }
    ol { list-style: none; margin: 0; padding: 4px 0; max-height: 300px; overflow-y: auto; }
    li { display: flex; gap: 9px; align-items: baseline;
         padding: 7px 12px; cursor: pointer; }
    li:hover { background: rgba(122,162,255,.16); }
    .n { color: #6b7483; font-variant-numeric: tabular-nums; flex: none; }
    .desc { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .empty { padding: 11px 12px; color: #9aa3b2; }
    .toast { color: #3ecf8e; }
  `;

  function svgDown() {
    return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 4v11M7 11l5 5 5-5"/></svg>`;
  }

  /**
   * Build one panel. `anchor` positions it; null means the page corner.
   */
  function createPanel({ anchor, labelFor }) {
    const host = document.createElement('div');
    host.style.cssText = `position:absolute;z-index:${Z};pointer-events:none;top:0;left:0;`;
    // Open rather than closed: the CSS isolation is identical, and a closed
    // root only hides a handle the page could find anyway via the host
    // element — while making the panel impossible to inspect or test.
    const root = host.attachShadow({ mode: 'open' });

    root.innerHTML = `
      <style>${PANEL_CSS}</style>
      <div class="wrap" style="pointer-events:auto">
        <div class="bar" part="bar">
          <span class="mark">${svgDown()}</span>
          <span class="label"></span>
          <span class="count" hidden></span>
          <button class="icon-btn caret" title="Show all files">${svgDown()}</button>
          <button class="icon-btn close" title="Hide">&#x2715;</button>
        </div>
        <div class="menu">
          <div class="menu-head">Download all</div>
          <ol></ol>
        </div>
      </div>
    `;

    const wrap = root.querySelector('.wrap');
    const bar = root.querySelector('.bar');
    const label = root.querySelector('.label');
    const count = root.querySelector('.count');
    const menu = root.querySelector('.menu');
    const list = root.querySelector('ol');
    const head = root.querySelector('.menu-head');

    let items = [];

    const flash = (text) => {
      const prev = label.textContent;
      label.textContent = text;
      label.classList.add('toast');
      setTimeout(() => {
        label.textContent = prev;
        label.classList.remove('toast');
      }, 2200);
    };

    const send = (item) => {
      chrome.runtime
        .sendMessage({
          type: 'download',
          url: item.url,
          pageUrl: location.href,
          filename: item.title ?? '',
        })
        .then((res) => flash(res?.ok ? '✓ Sent to IDM-Next' : '✗ IDM-Next not running'))
        .catch(() => flash('✗ Failed'));
      menu.classList.remove('open');
    };

    // Clicking the bar downloads the best candidate; the caret opens the list.
    // Same split IDM uses, so the common case is one click.
    bar.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (items.length > 0) send(items[0]);
    });

    root.querySelector('.caret').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      menu.classList.toggle('open');
    });

    root.querySelector('.close').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      host.remove();
      panels.delete(panel);
      if (anchor) dismissed.add(anchor);
      else pageDismissed = true;
    });

    head.addEventListener('click', (e) => {
      e.stopPropagation();
      for (const item of items) send(item);
      flash(`✓ Queued ${items.length}`);
    });

    const render = (next) => {
      items = next;
      label.textContent = labelFor(items);
      count.hidden = items.length < 2;
      count.textContent = String(items.length);

      list.textContent = '';
      if (items.length === 0) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'Nothing detected yet — start playing the video.';
        list.appendChild(li);
        return;
      }
      items.forEach((item, i) => {
        const li = document.createElement('li');
        const n = document.createElement('span');
        n.className = 'n';
        n.textContent = `${i + 1}.`;
        const d = document.createElement('span');
        d.className = 'desc';
        d.textContent = describe(item);
        d.title = item.url;
        li.append(n, d);
        li.addEventListener('click', (e) => {
          e.stopPropagation();
          send(item);
        });
        list.appendChild(li);
      });
    };

    const place = () => {
      if (!anchor) {
        // Page corner, fixed to the viewport.
        wrap.style.position = 'fixed';
        wrap.style.top = '16px';
        wrap.style.right = '16px';
        wrap.style.left = 'auto';
        return true;
      }
      const r = anchor.getBoundingClientRect();
      // Hide over players too small to be the page's actual content; a panel
      // floating on a 60px thumbnail is noise.
      if (r.width < 220 || r.height < 130) {
        host.style.display = 'none';
        return false;
      }
      host.style.display = '';
      wrap.style.position = 'absolute';
      wrap.style.top = `${window.scrollY + r.top + 10}px`;
      // Centred over the player, which is where IDM puts it and where it is
      // least likely to sit on top of the player's own controls.
      wrap.style.left = `${window.scrollX + r.left + r.width / 2}px`;
      wrap.style.transform = 'translateX(-50%)';
      return true;
    };

    const panel = { host, render, place, anchor };
    document.body.appendChild(host);
    place();
    panels.add(panel);
    return panel;
  }

  /* ---------------------------- orchestration ---------------------------- */

  function attachMediaPanel(media) {
    if (media.__idmPanel || dismissed.has(media)) return;
    const kind = media.tagName === 'AUDIO' ? 'audio' : 'video';
    const panel = createPanel({ anchor: media, labelFor: () => `Download this ${kind}` });
    media.__idmPanel = panel;

    const reposition = () => panel.place();
    window.addEventListener('scroll', reposition, { passive: true });
    window.addEventListener('resize', reposition, { passive: true });
    try {
      new ResizeObserver(reposition).observe(media);
    } catch {
      /* ResizeObserver is unavailable in some embedded contexts */
    }
    void refresh();
  }

  let pagePanel = null;

  function ensurePagePanel(items) {
    // Only when there is something to offer and no player to anchor to —
    // otherwise the media panel already covers it.
    const hasMedia = document.querySelector('video, audio') !== null;
    if (hasMedia || items.length === 0 || pageDismissed) {
      if (pagePanel) {
        pagePanel.host.remove();
        panels.delete(pagePanel);
        pagePanel = null;
      }
      return;
    }
    pagePanel ??= createPanel({
      anchor: null,
      labelFor: (list) => (list.length > 1 ? `Download ${list.length} files` : 'Download this file'),
    });
  }

  async function refresh() {
    let items = [];
    try {
      const res = await chrome.runtime.sendMessage({ type: 'list' });
      items = res?.items ?? [];
    } catch {
      return; // worker restarting
    }

    // Best first, because the bar's one click takes items[0]. Resolution beats
    // byte count: a long 360p file is bigger than a short 1080p one.
    items = [...items].sort((a, b) => {
      const q = (heightOf(b) ?? 0) - (heightOf(a) ?? 0);
      return q !== 0 ? q : (b.size ?? 0) - (a.size ?? 0);
    });

    ensurePagePanel(items);
    for (const panel of panels) {
      panel.render(items);
      panel.place();
    }
  }

  /** Numeric height for sorting, or null when the quality is unknown. */
  function heightOf(item) {
    const q = qualityOf(item);
    if (!q || q.startsWith('audio')) return null;
    const n = parseInt(q, 10);
    return Number.isFinite(n) ? n : null;
  }

  /* The background tells us when its registry changed. */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'media-updated') void refresh();
    return false;
  });

  function scan() {
    for (const el of document.querySelectorAll('video, audio')) {
      const kind = el.tagName.toLowerCase() === 'video' ? 'video' : 'audio';
      // videoHeight is the only reliable quality signal for a plain <video>.
      const height = el.videoHeight || null;
      const src = el.currentSrc || el.src;
      if (src) reportWithHeight(src, kind, height);
      for (const source of el.querySelectorAll('source')) {
        reportWithHeight(source.src, kind, height);
      }
      attachMediaPanel(el);
    }
    void refresh();
  }

  /**
   * blob: and data: sources mean nothing outside this page; the real manifest
   * behind them is caught by the background worker's header sniffing instead.
   */
  function reportWithHeight(url, kind, height) {
    if (!url || reported.has(url) || !/^https?:/.test(url)) return;
    reported.add(url);
    chrome.runtime
      .sendMessage({ type: 'media-found', url, kind, title: document.title, height })
      .catch(() => {});
  }

  let scanTimer = null;
  const scheduleScan = () => {
    // Media sites mutate constantly; coalesce or this runs hundreds of times a
    // second for nothing.
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 400);
  };

  scan();
  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'currentSrc'],
  });

  // A <video> only learns its dimensions once metadata arrives.
  document.addEventListener('loadedmetadata', scheduleScan, true);
  document.addEventListener('play', scheduleScan, true);
})();
