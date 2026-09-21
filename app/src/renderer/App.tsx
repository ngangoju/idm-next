import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  Category,
  DownloadRecord,
  ServerEvent,
  Settings,
} from '../shared/protocol.ts';
import { CATEGORIES, DEFAULT_PORT } from '../shared/protocol.ts';
import { SegmentStrip } from './SegmentStrip.tsx';
import { AddDialog } from './AddDialog.tsx';
import { FormatDialog } from './FormatDialog.tsx';
import { SettingsDialog } from './SettingsDialog.tsx';
import { bytes, eta, rate } from './format.ts';

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

export function App(): React.ReactElement {
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [connected, setConnected] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [ytdlp, setYtdlp] = useState<{ ok: boolean; version?: string; error?: string } | null>(null);
  /** Set when the user adds a page URL and we need a quality first. */
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
        // The main process may be restarting; keep trying rather than
        // presenting a dead UI.
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
  }, [downloads, filter]);

  const totalRate = downloads.reduce(
    (n, d) => n + (d.status === 'downloading' ? d.rateBps : 0),
    0,
  );

  const act = useCallback((path: string, id: string) => {
    void post(path, { id });
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">IDM-Next</div>
        <button className="primary" onClick={() => setAdding(true)}>
          + Add URL
        </button>

        <nav>
          {(['all', 'active', 'done'] as const).map((f) => (
            <button
              key={f}
              className={filter === f ? 'nav active' : 'nav'}
              onClick={() => setFilter(f)}
            >
              {f[0]!.toUpperCase() + f.slice(1)}
            </button>
          ))}
          <div className="nav-label">Categories</div>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              className={filter === c ? 'nav active' : 'nav'}
              onClick={() => setFilter(c)}
            >
              {c[0]!.toUpperCase() + c.slice(1)}
              <span className="count">{downloads.filter((d) => d.category === c).length}</span>
            </button>
          ))}
        </nav>

        <button
          className="nav"
          onClick={() => setShowSettings(true)}
          disabled={settings === null}
          title={settings === null ? 'Waiting for the app to respond…' : undefined}
        >
          Settings
        </button>

        <div className="status">
          <span className={connected ? 'dot ok' : 'dot bad'} />
          {connected ? 'Connected' : 'Reconnecting…'}
          <div className="total-rate">{rate(totalRate)}</div>
        </div>
      </aside>

      <main className="list">
        {visible.length === 0 && (
          <div className="empty">
            <p>Nothing here yet.</p>
            <p className="hint">
              Add a URL, copy a download link to your clipboard, or install the browser
              extension to grab media straight from a page.
            </p>
          </div>
        )}

        {visible.map((d) => (
          <Row key={d.id} d={d} onAct={act} />
        ))}
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
          onPick={async (formatId, title) => {
            await post('/downloads', {
              url: picking,
              useYtdlp: true,
              ...(formatId ? { formatId } : {}),
              ...(title ? { filename: undefined } : {}),
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

function Row({
  d,
  onAct,
}: {
  d: DownloadRecord;
  onAct: (path: string, id: string) => void;
}): React.ReactElement {
  const pct = d.totalSize ? Math.min(100, (d.downloaded / d.totalSize) * 100) : 0;

  return (
    <article className={`row ${d.status}`}>
      <div className="row-head">
        <span className="name" title={d.filePath}>
          {d.filename}
        </span>
        <span className="meta">
          {bytes(d.downloaded)} / {bytes(d.totalSize)}
          {d.status === 'downloading' && (
            <>
              {' · '}
              {rate(d.rateBps)} · {eta(d.etaSeconds)}
            </>
          )}
        </span>
      </div>

      <div className="bar">
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>

      {/* The per-connection view: this is what makes a segmented downloader
          legible, and it is the thing a single progress bar hides. */}
      {d.segments.length > 1 && <SegmentStrip segments={d.segments} total={d.totalSize} />}

      <div className="row-foot">
        <span className={`badge ${d.status}`}>{d.status}</span>
        {d.checksum?.verified === true && <span className="badge ok">checksum ok</span>}
        {d.checksum?.verified === false && <span className="badge bad">checksum failed</span>}
        {d.error && <span className="error" title={d.error}>{d.error}</span>}

        <div className="actions">
          {d.status === 'downloading' && (
            <button onClick={() => onAct('/downloads/pause', d.id)}>Pause</button>
          )}
          {(d.status === 'paused' || d.status === 'failed') && (
            <button onClick={() => onAct('/downloads/resume', d.id)}>Resume</button>
          )}
          {d.status === 'completed' && (
            <>
              <button onClick={() => void window.idm?.open(d.filePath)}>Open</button>
              <button onClick={() => void window.idm?.reveal(d.filePath)}>Show</button>
            </>
          )}
          <button className="danger" onClick={() => onAct('/downloads/cancel', d.id)}>
            Remove
          </button>
        </div>
      </div>
    </article>
  );
}
