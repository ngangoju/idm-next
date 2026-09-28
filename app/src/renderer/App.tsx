import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Category, DownloadRecord, ServerEvent, Settings } from '../shared/protocol.ts';
import { CATEGORIES, humanizeError } from '../shared/protocol.ts';
import { SegmentStrip } from './SegmentStrip.tsx';
import { AddDialog } from './AddDialog.tsx';
import { FormatDialog } from './FormatDialog.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { API, authenticate, get, headers, post, subscribe } from './client.ts';
import { bytes, eta, rate, relativeTime, hostOf } from './format.ts';
import * as Icon from './icons.tsx';

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
    // A download's progress window is opened by the main process, not here:
    // it appears while the browser is in front, and a panel inside a window
    // nobody raised is the same as nothing appearing at all.
    const onEvent = (event: ServerEvent): void => {
      switch (event.type) {
        case 'downloads':
          setDownloads(event.downloads);
          break;
        case 'download-added':
          setDownloads((prev) => [event.download, ...prev]);
          break;
        case 'download-done':
        case 'download-restarted':
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

    let dispose = (): void => {};
    void (async () => {
      await authenticate();
      dispose = subscribe({ onEvent, onConnected: setConnected });
      try {
        setSettings((await get<{ settings: Settings }>('/settings')).settings);
        setYtdlp(await get<{ ok: boolean; version?: string; error?: string }>('/ytdlp'));
      } catch {
        /* the list arrives over the socket regardless */
      }
    })();

    // Whether a finished file is still on disk changes behind our back — the
    // usual way is someone tidying their Downloads folder. Coming back to the
    // window is the moment to look again.
    const recheck = (): void => {
      void get<{ downloads: DownloadRecord[] }>('/downloads')
        .then((r) => setDownloads(r.downloads))
        .catch(() => undefined);
    };
    window.addEventListener('focus', recheck);

    return () => {
      window.removeEventListener('focus', recheck);
      dispose();
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
  const failedCount = downloads.filter((d) => d.status === 'failed').length;

  const act = useCallback((path: string, id: string) => {
    void post(path, { id });
  }, []);

  // No optimistic removal: the server broadcasts download-removed, which keeps
  // every client in step instead of just this one.
  const clearWhere = useCallback(
    (match: (d: DownloadRecord) => boolean) => {
      for (const d of downloads.filter(match)) void post('/downloads/cancel', { id: d.id });
    },
    [downloads],
  );

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
            const CatIcon = Icon.CATEGORY_ICON[c];
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
            {/* A zero rate rendered as a bare dash reads as broken; before any
                throughput is measured there is simply nothing to report. */}
            <span className="status-rate">
              {activeCount === 0 ? 'Idle' : totalRate > 0 ? rate(totalRate) : 'Starting…'}
            </span>
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
              {activeCount > 0 &&
                ` · ${activeCount} downloading${totalRate > 0 ? ` at ${rate(totalRate)}` : ''}`}
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
            {failedCount > 0 && (
              <button
                className="btn-ghost"
                onClick={() => clearWhere((d) => d.status === 'failed')}
              >
                <Icon.Alert size={14} />
                Clear {failedCount} failed
              </button>
            )}
            {completedCount > 0 && (
              <button
                className="btn-ghost"
                onClick={() => clearWhere((d) => d.status === 'completed')}
              >
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
            visible.map((d) => (
              <Row key={d.id} d={d} onAct={act} onOpen={() => void window.idm?.openDetail(d.id)} />
            ))
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
              headers: headers(true),
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
  onOpen,
}: {
  d: DownloadRecord;
  onAct: (path: string, id: string) => void;
  onOpen: () => void;
}): React.ReactElement {
  const CatIcon = Icon.CATEGORY_ICON[d.category];

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
    <article
      className={`row ${d.status}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={`row-icon ${d.category}`}>
        <CatIcon size={17} />
      </div>

      <div className="row-body">
        <div className="row-head">
          <span className="name" title={d.filePath}>
            {d.filename}
          </span>
          <span className="figures">{figuresFor(d)}</span>
        </div>

        <div className={indeterminate ? 'bar indeterminate' : 'bar'}>
          <div className="fill" style={indeterminate ? undefined : { width: `${pct}%` }} />
        </div>

        {/* Its own line: an error squeezed between the status chip and the
            buttons was truncated to uselessness. */}
        {d.error && (
          <p className="row-error" title={d.error}>
            {humanizeError(d.error)}
          </p>
        )}

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
            {/* After a failure, carry on from what already arrived — unless the
                server changed the file, when carrying on can only fail again. */}
            {d.status === 'failed' &&
              d.downloaded > 0 &&
              !/remote file changed/i.test(d.error ?? '') && (
                <IconButton label="Resume" onClick={() => onAct('/downloads/resume', d.id)}>
                  <Icon.Play size={14} />
                </IconButton>
              )}
            {/* Start over, from nothing. Offered wherever that can help: after a
                failure (a resume that keeps failing the same way needs this),
                on a stopped download, and on a finished one — deleted or not. */}
            {(d.status === 'failed' || d.status === 'paused' || done) && (
              <IconButton
                label="Download again"
                emphasis={d.status === 'failed' || d.fileMissing === true}
                onClick={() => onAct('/downloads/restart', d.id)}
              >
                <Icon.Retry size={14} />
              </IconButton>
            )}
            {done && !d.fileMissing && (
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

/**
 * What the size column should say.
 *
 * A download that has not moved yet knows neither figure, and rendering that
 * as "0 B / —" reads as broken rather than as pending. Say nothing until there
 * is something to say.
 */
function figuresFor(d: DownloadRecord): React.ReactNode {
  if (d.status === 'completed') return bytes(d.totalSize ?? d.downloaded);
  if (d.status === 'failed' || d.status === 'cancelled') {
    return d.downloaded > 0 ? `${bytes(d.downloaded)} of ${bytes(d.totalSize)}` : null;
  }
  if (d.downloaded === 0 && !d.totalSize) return null;
  if (!d.totalSize) return <span className="fig-main">{bytes(d.downloaded)}</span>;

  return (
    <>
      <span className="fig-main">{bytes(d.downloaded)}</span>
      <span className="fig-sep">/</span>
      <span className="fig-total">{bytes(d.totalSize)}</span>
    </>
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

  if (d.fileMissing) {
    return (
      <span className="chip warn">
        <Icon.Alert size={12} />
        File missing
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
  emphasis,
  children,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  /** The action this row most needs — drawn filled so it is found first. */
  emphasis?: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      className={['icon-btn', danger && 'danger', emphasis && 'emphasis'].filter(Boolean).join(' ')}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
    >
      {children}
      {/* The one action a row most needs is named, not left to a tooltip. */}
      {emphasis && <span>{label}</span>}
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
