import { appIsRunning } from './shared.js';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const statusEl = document.getElementById('status');
const dotEl = document.getElementById('dot');
const warnEl = document.getElementById('warn');

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

const running = await appIsRunning();
dotEl.classList.toggle('ok', running);
statusEl.textContent = running ? 'app connected' : 'app not running';
warnEl.hidden = running;

const { items } = await chrome.runtime.sendMessage({ type: 'list', tabId: tab?.id });

if (!items || items.length === 0) {
  emptyEl.hidden = false;
} else {
  // Biggest first: on a streaming page the full-quality rendition is almost
  // always the one the user wants, and it is almost always the largest.
  items.sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  for (const item of items) listEl.appendChild(row(item));
}

function row(item) {
  const li = document.createElement('li');

  const kind = document.createElement('span');
  kind.className = `kind ${item.kind}`;
  kind.textContent = item.kind;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = item.title || item.url;
  title.title = item.url;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = [item.contentType, item.size ? formatBytes(item.size) : null]
    .filter(Boolean)
    .join(' · ') || (item.isManifest ? 'adaptive stream' : 'unknown size');
  meta.append(title, sub);

  const btn = document.createElement('button');
  btn.textContent = 'Get';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '…';
    const res = await chrome.runtime.sendMessage({
      type: 'download',
      url: item.url,
      pageUrl: item.pageUrl,
      filename: item.title,
    });
    btn.textContent = res?.ok ? 'Queued' : 'Failed';
    btn.disabled = res?.ok === true;
  });

  li.append(kind, meta, btn);
  return li;
}

document.getElementById('all').addEventListener('click', async () => {
  for (const item of items ?? []) {
    await chrome.runtime.sendMessage({
      type: 'download',
      url: item.url,
      pageUrl: item.pageUrl,
      filename: item.title,
    });
  }
  window.close();
});

document.getElementById('page').addEventListener('click', async () => {
  // The escape hatch for players we cannot see into: hand the page URL to the
  // app, which resolves it with yt-dlp.
  await chrome.runtime.sendMessage({
    type: 'download',
    url: tab.url,
    pageUrl: tab.url,
    filename: '',
  });
  window.close();
});

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
