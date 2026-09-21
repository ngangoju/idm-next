import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Category, DownloadRecord, ServerEvent, Settings } from '../shared/protocol.ts';
import { CATEGORIES, DEFAULT_PORT } from '../shared/protocol.ts';
import { SegmentStrip } from './SegmentStrip.tsx';
import { AddDialog } from './AddDialog.tsx';
import { FormatDialog } from './FormatDialog.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { bytes, eta, rate, relativeTime, hostOf } from './format.ts';
import * as Icon from './icons.tsx';

const API = `http://127.0.0.1:${DEFAULT_PORT}`;

declare global {
  interface Window {
    idm?: {
      reveal(p: string): Promise<void>;
      open(p: string): Promise<string>;
      chooseDir(): Promise<string | null>;
      port(): Promise<number>;
      token(): Promise<string>;
    };
  }
}

/**
 * The renderer authenticates with a token from preload rather than by origin:
 * a packaged build loads from file:// and reports `Origin: null`, which cannot
 * be allowlisted because a sandboxed iframe on any site reports it too.
 */
let authToken = '';

async function post(path: string, body: unknown = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-idm-token': authToken },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { 'x-idm-token': authToken } });
  return res.json() as Promise<T>;
}

type Filter = Category | 'all' | 'active' | 'done';

const FILTER_LABELS: Record<Filter, string> = {
  all: 'All downloads',
  active: 'Active',
  done: 'Completed',
  video: 'Video',
  audio: 'Audio',
  documents: 'Documents',
  compressed: 'Archives',
  programs: 'Programs',
  other: 'Other',
};

/** Sort order for the list: what needs attention first, then what is done. */
const STATUS_RANK: Record<string, number> = {
  downloading: 0,
  probing: 1,
  paused: 2,
  failed: 3,
  completed: 4,
  cancelled: 5,
};

const CATEGORY_ICON: Record<Category, (p: { size?: number }) => React.ReactElement> = {
  video: Icon.Film,
  audio: Icon.Music,
  documents: Icon.Doc,
  compressed: Icon.Archive,
  programs: Icon.AppBox,
  other: Icon.FileGeneric,
};

export function App(): React.ReactElement {
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [connected, setConnected] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [ytdlp, setYtdlp] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);
  const [picking, setPicking] = useState<string | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout>;
    let closed = false;

    const connect = (): void => {
      // A browser cannot set headers on a WebSocket handshake, so the token
      // goes in the query string here.
      ws = new WebSocket(`ws://127.0.0.1:${DEFAULT_PORT}/?token=${encodeURIComponent(authToken)}`);

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1000);
      };
      ws.onmessage = (e: MessageEvent<string>) => {
        const event = JSON.parse(e.data) as ServerEvent;
        switch (event.type) {
          case 'downloads':
            setDownloads(event.downloads);
            break;
          case 'download-added':
            setDownloads((prev) => [event.download, ...prev]);
            break;
          case 'download-done':
            setDownloads((prev) =>
              prev.map((d) => (d.id === event.download.id ? event.download : d)),
            );
            break;
          case 'download-removed':
            setDownloads((prev) => prev.filter((d) => d.id !== event.id));
            break;
          case 'download-error':
            setDownloads((prev) =>
              prev.map((d) =>
                d.id === event.id ? { ...d, status: 'failed', error: event.error } : d,
              ),
            );
            break;
          case 'progress': {
            // Merge by id rather than replacing the list, so scroll position
            // and any local state survive a 4 Hz tick.
            const patch = new Map(event.downloads.map((p) => [p.id, p]));
            setDownloads((prev) =>
              prev.map((d) => {
                const p = patch.get(d.id);
                return p ? { ...d, ...p } : d;
              }),
            );
            break;
          }
          case 'settings':
            setSettings(event.settings);
            break;
        }
      };
    };

    void (async () => {
      authToken = (await window.idm?.token()) ?? '';
      connect();
      try {
        setSettings((await get<{ settings: Settings }>('/settings')).settings);
        setYtdlp(await get<{ ok: boolean; version?: string; error?: string }>('/ytdlp'));
      } catch {
        /* the list arrives over the socket regardless */
      }
    })();

    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  const visible = useMemo(() => {
    const byFilter = (() => {
      switch (filter) {
        case 'all':
          return downloads;
        case 'active':
          return downloads.filter((d) => d.status === 'downloading' || d.status === 'paused');
        case 'done':
          return downloads.filter((d) => d.status === 'completed');
        default:
          return downloads.filter((d) => d.category === filter);
      }
    })();

    // What is happening now outranks what happened earlier. Strict ordering by
    // recency buries a live transfer under a pile of finished ones.
    return [...byFilter].sort((a, b) => {
      const rank = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
      if (rank !== 0) return rank;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });
  }, [downloads, filter]);

  const activeCount = downloads.filter((d) => d.status === 'downloading').length;
  const totalRate = downloads.reduce(
    (n, d) => n + (d.status === 'downloading' ? d.rateBps : 0),
    0,
  );
  const completedCount = downloads.filter((d) => d.status === 'completed').length;

  const act = useCallback((path: string, id: string) => {
    void post(path, { id });
  }, []);

  const clearCompleted = useCallback(() => {
    // No optimistic removal: the server broadcasts download-removed, which
    // keeps every client in step instead of just this one.
    for (const d of downloads.filter((x) => x.status === 'completed')) {
      void post('/downloads/cancel', { id: d.id });
    }
  }, [downloads]);

  return (
    <div className="app">
      <aside className="sidebar">
        {/* Clears the traffic lights and gives the window a drag handle. */}
        <div className="titlebar-pad" />

        <div className="brand">
          <span className="brand-mark">
            <Icon.DownloadArrow size={15} />
          </span>
          <span className="brand-name">IDM-Next</span>
        </div>

        <button className="btn-primary" onClick={() => setAdding(true)}>
          <Icon.Plus size={15} />
          Add download
        </button>

        <nav className="nav">
          <NavItem
            label="All"
            icon={<Icon.Inbox size={15} />}
            count={downloads.length}
            active={filter === 'all'}
            onClick={() => setFilter('all')}
          />
          <NavItem
            label="Active"
            icon={<Icon.Bolt size={15} />}
            count={
              downloads.filter((d) => d.status === 'downloading' || d.status === 'paused').length
            }
            active={filter === 'active'}
            onClick={() => setFilter('active')}
          />
          <NavItem
            label="Completed"
            icon={<Icon.Check size={15} />}
            count={completedCount}
            active={filter === 'done'}
            onClick={() => setFilter('done')}
          />

          <div className="nav-label">Categories</div>
          {CATEGORIES.map((c) => {
            const CatIcon = CATEGORY_ICON[c];
            return (
              <NavItem
                key={c}
                label={FILTER_LABELS[c]}
                icon={<CatIcon size={15} />}
                count={downloads.filter((d) => d.category === c).length}
                active={filter === c}
                onClick={() => setFilter(c)}
              />
            );
          })}
        </nav>

        <div className="sidebar-foot">
          <button
            className="nav-item"
            onClick={() => setShowSettings(true)}
            disabled={settings === null}
            title={settings === null ? 'Waiting for the app to respond…' : 'Settings'}
          >
            <span className="nav-icon">
              <Icon.Settings size={15} />
            </span>
            <span className="nav-text">Settings</span>
          </button>

          <div className="status">
            <span className={connected ? 'dot ok' : 'dot bad'} />
            <span className="status-text">{connected ? 'Connected' : 'Reconnecting…'}</span>
            <span className="status-rate">{activeCount > 0 ? rate(totalRate) : 'Idle'}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{FILTER_LABELS[filter]}</h1>
            <p className="topbar-sub">
              {visible.length === 0
                ? 'Nothing here'
                : `${visible.length} item${visible.length === 1 ? '' : 's'}`}
              {activeCount > 0 && ` · ${activeCount} downloading at ${rate(totalRate)}`}
            </p>
          </div>

          <div className="topbar-actions">
            {activeCount > 0 && (
              <button
                className="btn-ghost"
                onClick={() => {
                  for (const d of downloads.filter((x) => x.status === 'downloading')) {
                    act('/downloads/pause', d.id);
                  }
                }}
              >
                <Icon.Pause size={14} />
                Pause all
              </button>
            )}
            {completedCount > 0 && (
              <button className="btn-ghost" onClick={clearCompleted}>
                <Icon.Broom size={14} />
                Clear completed
              </button>
            )}
          </div>
        </header>

        <div className="list">
          {visible.length === 0 ? (
            <EmptyState filter={filter} onAdd={() => setAdding(true)} />
          ) : (
            visible.map((d) => <Row key={d.id} d={d} onAct={act} />)
          )}
        </div>
      </main>

      {adding && (
        <AddDialog
          defaultConnections={settings?.defaultConnections ?? 8}
          onClose={() => setAdding(false)}
          onSubmit={async (req) => {
            setAdding(false);
            // A page URL has no single file to fetch, so ask which rendition
            // the user wants before queuing anything.
            if (looksLikePage(req.url)) {
              setPicking(req.url);
              return;
            }
            await post('/downloads', req);
          }}
        />
      )}

      {picking && (
        <FormatDialog
          url={picking}
          onClose={() => setPicking(null)}
          fetchExtraction={async (url) => {
            const res = await fetch(`${API}/extract`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-idm-token': authToken },
              body: JSON.stringify({ url }),
            });
            const body = (await res.json()) as { error?: string };
            if (!res.ok) throw new Error(body.error ?? `extraction failed (${res.status})`);
            return body as never;
          }}
          onPick={async (formatId) => {
            await post('/downloads', {
              url: picking,
              useYtdlp: true,
              ...(formatId ? { formatId } : {}),
            });
            setPicking(null);
          }}
        />
      )}

      {showSettings && settings !== null && (
        <SettingsDialog
          settings={settings}
          ytdlp={ytdlp}
          onClose={() => setShowSettings(false)}
          onSave={async (patch) => {
            const res = (await post('/settings', patch)) as { settings: Settings };
            setSettings(res.settings);
            setShowSettings(false);
          }}
        />
      )}
    </div>
  );
}

function NavItem({
  label,
  icon,
  count,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  count: number;
  active: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button className={active ? 'nav-item active' : 'nav-item'} onClick={onClick}>
      <span className="nav-icon">{icon}</span>
      <span className="nav-text">{label}</span>
      {count > 0 && <span className="nav-count">{count}</span>}
    </button>
  );
}

function Row({
  d,
  onAct,
}: {
  d: DownloadRecord;
  onAct: (path: string, id: string) => void;
}): React.ReactElement {
  const CatIcon = CATEGORY_ICON[d.category];

  // A finished download is 100% by definition. Deriving the bar from byte
  // counts left completed rows empty whenever the size was never known — which
  // is exactly what a fast yt-dlp download produces.
  const done = d.status === 'completed';
  const pct = done
    ? 100
    : d.totalSize && d.totalSize > 0
      ? Math.min(100, (d.downloaded / d.totalSize) * 100)
      : 0;

  // An adaptive stream reports no total until it finishes, so show motion
  // rather than a bar stuck at zero.
  const indeterminate = !done && d.status === 'downloading' && !d.totalSize;

  return (
    <article className={`row ${d.status}`}>
      <div className={`row-icon ${d.category}`}>
        <CatIcon size={17} />
      </div>

      <div className="row-body">
        <div className="row-head">
          <span className="name" title={d.filePath}>
            {d.filename}
          </span>
          <span className="figures">
            {done ? (
              bytes(d.totalSize ?? d.downloaded)
            ) : (
              <>
                <span className="fig-main">{bytes(d.downloaded)}</span>
                <span className="fig-sep">/</span>
                <span className="fig-total">{bytes(d.totalSize)}</span>
              </>
            )}
          </span>
        </div>

        <div className={indeterminate ? 'bar indeterminate' : 'bar'}>
          <div className="fill" style={indeterminate ? undefined : { width: `${pct}%` }} />
        </div>

        {/* The per-connection view: what makes a segmented downloader legible,
            and the thing a single progress bar hides. */}
        {d.segments.length > 1 && !done && (
          <SegmentStrip segments={d.segments} total={d.totalSize} />
        )}

        <div className="row-foot">
          <StatusChip d={d} />

          <span className="sub">
            {d.sourcePage && <span className="sub-host">{hostOf(d.sourcePage)}</span>}
            {d.status === 'downloading' && (
              <>
                {d.sourcePage && <span className="sub-dot">·</span>}
                {/* A bare dash reads as broken in the first moments before any
                    throughput has been measured. */}
                <span className="sub-rate">
                  {d.rateBps > 0 ? rate(d.rateBps) : 'Starting…'}
                </span>
                {d.etaSeconds !== null && (
                  <>
                    <span className="sub-dot">·</span>
                    <span>{eta(d.etaSeconds)} left</span>
                  </>
                )}
                {d.segments.length > 1 && (
                  <>
                    <span className="sub-dot">·</span>
                    <span>{d.segments.length} connections</span>
                  </>
                )}
              </>
            )}
            {done && d.completedAt && (
              <>
                {d.sourcePage && <span className="sub-dot">·</span>}
                <span>{relativeTime(d.completedAt)}</span>
              </>
            )}
            {d.error && (
              <span className="sub-error" title={d.error}>
                {d.error}
              </span>
            )}
          </span>

          <div className="actions">
            {d.status === 'downloading' && (
              <IconButton label="Pause" onClick={() => onAct('/downloads/pause', d.id)}>
                <Icon.Pause size={14} />
              </IconButton>
            )}
            {d.status === 'paused' && (
              <IconButton label="Resume" onClick={() => onAct('/downloads/resume', d.id)}>
                <Icon.Play size={14} />
              </IconButton>
            )}
            {d.status === 'failed' && (
              <IconButton label="Retry" onClick={() => onAct('/downloads/resume', d.id)}>
                <Icon.Retry size={14} />
              </IconButton>
            )}
            {done && (
              <>
                <IconButton label="Open file" onClick={() => void window.idm?.open(d.filePath)}>
                  <Icon.ExternalOpen size={14} />
                </IconButton>
                <IconButton
                  label="Show in folder"
                  onClick={() => void window.idm?.reveal(d.filePath)}
                >
                  <Icon.FolderOpen size={14} />
                </IconButton>
              </>
            )}
            <IconButton label="Remove" danger onClick={() => onAct('/downloads/cancel', d.id)}>
              <Icon.Trash size={14} />
            </IconButton>
          </div>
        </div>
      </div>
    </article>
  );
}

function StatusChip({ d }: { d: DownloadRecord }): React.ReactElement {
  if (d.checksum?.verified === true) {
    return (
      <span className="chip ok">
        <Icon.Check size={12} />
        Verified
      </span>
    );
  }
  if (d.checksum?.verified === false) {
    return (
      <span className="chip bad">
        <Icon.Alert size={12} />
        Checksum failed
      </span>
    );
  }

  const label: Record<string, string> = {
    downloading: 'Downloading',
    paused: 'Paused',
    completed: 'Completed',
    failed: 'Failed',
    probing: 'Starting',
    cancelled: 'Cancelled',
  };
  return <span className={`chip ${d.status}`}>{label[d.status] ?? d.status}</span>;
}

function IconButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      className={danger ? 'icon-btn danger' : 'icon-btn'}
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

function EmptyState({
  filter,
  onAdd,
}: {
  filter: Filter;
  onAdd: () => void;
}): React.ReactElement {
  const isRoot = filter === 'all';
  return (
    <div className="empty">
      <div className="empty-mark">
        <Icon.DownloadArrow size={26} />
      </div>
      <h2>{isRoot ? 'No downloads yet' : `Nothing in ${FILTER_LABELS[filter]}`}</h2>
      {isRoot && (
        <>
          <p>
            Paste a link, copy one to your clipboard, or install the browser extension to grab
            video and audio straight from a page.
          </p>
          <button className="btn-primary" onClick={onAdd}>
            <Icon.Plus size={15} />
            Add download
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Mirrors the main process's routing heuristic so the UI can ask for a quality
 * before sending a page URL. The server decides authoritatively; this only
 * decides whether to show the picker.
 */
function looksLikePage(url: string): boolean {
  try {
    const last = new URL(url).pathname.split('/').pop() ?? '';
    const ext = last.includes('.') ? last.split('.').pop()!.toLowerCase() : '';
    if (ext === 'm3u8' || ext === 'mpd' || ext === '') return true;
    return ['html', 'htm', 'php', 'aspx', 'jsp'].includes(ext);
  } catch {
    return false;
  }
}
