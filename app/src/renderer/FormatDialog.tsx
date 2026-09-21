import { useEffect, useState } from 'react';

interface YtFormat {
  id: string;
  ext: string;
  resolution: string;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  filesize: number | null;
  tbr: number | null;
  protocol: string;
  note: string | null;
}

interface Extraction {
  title: string;
  duration: number | null;
  formats: YtFormat[];
  isPlaylist: boolean;
}

/**
 * Quality picker for a page URL.
 *
 * The protocol column is not decoration: it tells the user which transport
 * their download will take. An https format goes through our segmented engine
 * with resume; an HLS/DASH one is fetched by yt-dlp instead.
 */
export function FormatDialog({
  url,
  onClose,
  onPick,
  fetchExtraction,
}: {
  url: string;
  onClose: () => void;
  onPick: (formatId: string | null, title: string) => void;
  fetchExtraction: (url: string) => Promise<Extraction>;
}): React.ReactElement {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; data: Extraction }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchExtraction(url)
      .then((data) => {
        if (!cancelled) setState({ kind: 'ready', data });
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ kind: 'error', message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [url, fetchExtraction]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
        <h2>Choose quality</h2>
        <p className="sub-line" title={url}>
          {url}
        </p>

        {state.kind === 'loading' && <p className="muted">Asking yt-dlp what is available…</p>}

        {state.kind === 'error' && (
          <div className="error-box">
            <strong>Could not read that page.</strong>
            <p>{state.message}</p>
          </div>
        )}

        {state.kind === 'ready' && (
          <>
            <p className="muted">
              {state.data.title}
              {state.data.duration ? ` · ${formatDuration(state.data.duration)}` : ''}
            </p>

            {state.data.formats.length === 0 ? (
              <p className="muted">No downloadable formats found.</p>
            ) : (
              <div className="formats">
                {state.data.formats.map((f) => (
                  <button
                    key={f.id}
                    className="format"
                    onClick={() => onPick(f.id, state.data.title)}
                  >
                    <span className="res">{f.resolution}</span>
                    <span className="codec">
                      {[f.vcodec, f.acodec].filter(Boolean).join(' + ') || 'unknown codec'}
                      {f.fps ? ` · ${f.fps}fps` : ''}
                      {f.note ? ` · ${f.note}` : ''}
                    </span>
                    <span className="size">{f.filesize ? bytes(f.filesize) : '—'}</span>
                    <span className={`proto ${isDirect(f) ? 'direct' : ''}`}>
                      {isDirect(f) ? 'direct' : f.protocol}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() =>
              onPick(null, state.kind === 'ready' ? state.data.title : '')
            }
          >
            Best available
          </button>
        </div>
      </div>
    </div>
  );
}

function isDirect(f: YtFormat): boolean {
  return f.protocol === 'https' || f.protocol === 'http';
}

function bytes(n: number): string {
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
               : `${m}:${String(s).padStart(2, '0')}`;
}
