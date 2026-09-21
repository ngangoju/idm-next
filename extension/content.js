/**
 * Content script: scan the DOM for media and put a download button on it.
 *
 * Everything visible lives in a shadow root so the host page's CSS cannot
 * restyle it and ours cannot leak out — on a media site that is the difference
 * between a button and a layout bug.
 */

(() => {
  if (window.__idmNextInjected) return;
  window.__idmNextInjected = true;

  const seen = new Set();

  /* ----------------------------- scanning ----------------------------- */

  function report(url, kind, title) {
    if (!url || seen.has(url)) return;
    // blob: and data: URLs are meaningless outside this page; the manifest
    // behind them is caught by the background worker's header sniffing.
    if (!/^https?:/.test(url)) return;
    seen.add(url);
    chrome.runtime.sendMessage({ type: 'media-found', url, kind, title }).catch(() => {});
  }

  function scan() {
    for (const el of document.querySelectorAll('video, audio')) {
      const kind = el.tagName.toLowerCase() === 'video' ? 'video' : 'audio';
      report(el.currentSrc || el.src, kind, document.title);
      for (const source of el.querySelectorAll('source')) {
        report(source.src, kind, document.title);
      }
      attachButton(el);
    }
  }

  const observer = new MutationObserver(() => scheduleScan());
  let scanTimer = null;
  function scheduleScan() {
    // Media sites mutate constantly; coalesce or we rescan hundreds of times a
    // second for nothing.
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 400);
  }

  /* ------------------------- the floating button ------------------------- */

  function attachButton(media) {
    if (media.__idmButton) return;
    // Skip the decorative autoplay clips that pepper modern pages.
    if (media.tagName === 'VIDEO' && media.duration && media.duration < 5) return;

    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:none;';
    const root = host.attachShadow({ mode: 'closed' });

    root.innerHTML = `
      <style>
        .btn {
          pointer-events: auto;
          font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background: rgba(20, 22, 26, .92);
          color: #e6e9ef;
          border: 1px solid rgba(255,255,255,.18);
          border-radius: 7px;
          padding: 7px 11px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          box-shadow: 0 2px 10px rgba(0,0,0,.35);
          opacity: 0;
          transition: opacity .15s ease;
        }
        .btn:hover { background: #4c8dff; border-color: #4c8dff; }
        .btn.show { opacity: 1; }
        .btn.done { background: #38c172; border-color: #38c172; }
      </style>
      <button class="btn" part="btn">&#x2193; Download this video</button>
    `;

    const btn = root.querySelector('.btn');
    if (media.tagName === 'AUDIO') btn.innerHTML = '&#x2193; Download this audio';

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = media.currentSrc || media.src;

      chrome.runtime
        .sendMessage({
          type: 'download',
          url: /^https?:/.test(url) ? url : location.href,
          pageUrl: location.href,
          filename: '',
        })
        .then((res) => {
          btn.textContent = res?.ok ? '✓ Sent to IDM-Next' : '✗ IDM-Next not running';
          btn.classList.add('done');
          setTimeout(() => {
            btn.textContent = '↓ Download this video';
            btn.classList.remove('done');
          }, 2500);
        })
        .catch(() => {
          btn.textContent = '✗ Failed';
        });
    });

    document.body.appendChild(host);
    media.__idmButton = host;

    const place = () => {
      const r = media.getBoundingClientRect();
      // Hide the button for off-screen or tiny players rather than leaving it
      // floating over unrelated content.
      if (r.width < 200 || r.height < 120) {
        host.style.display = 'none';
        return;
      }
      host.style.display = '';
      host.style.top = `${window.scrollY + r.top + 12}px`;
      host.style.left = `${window.scrollX + r.left + 12}px`;
    };

    place();
    media.addEventListener('mouseenter', () => btn.classList.add('show'));
    media.addEventListener('mouseleave', () => btn.classList.remove('show'));
    host.addEventListener('mouseenter', () => btn.classList.add('show'));
    host.addEventListener('mouseleave', () => btn.classList.remove('show'));

    window.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place, { passive: true });
    new ResizeObserver(place).observe(media);
  }

  scan();
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'currentSrc'],
  });
})();
