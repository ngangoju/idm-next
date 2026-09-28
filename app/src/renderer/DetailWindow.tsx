import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DownloadRecord, ServerEvent } from '../shared/protocol.ts';
import { humanizeError } from '../shared/protocol.ts';
import { authenticate, post, subscribe } from './client.ts';
import { bytes, eta, rate, hostOf } from './format.ts';
import * as Icon from './icons.tsx';

/**
 * A download's own progress window.
 *
 * A separate OS window, not a panel inside the list, because it opens by
 * itself the moment a transfer starts — usually while the browser is in front —
 * and a panel inside an app window nobody raised is the same as nothing
 * happening.
 *
 * Small on purpose. It sits over whatever the user was doing, so it answers the
 * three questions people actually have mid-download — how far, how fast, how
 * long — and keeps the rest (per-connection detail) one click away. It sizes
 * itself to its content, and closes itself once the download is done.
 */
export function DetailWindow({ id }: { id: string }): React.ReactElement {
  const [record, setRecord] = useState<DownloadRecord | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const apply = (event: ServerEvent): void => {
      switch (event.type) {
        case 'downloads':
          setRecord(event.downloads.find((d) => d.id === id) ?? null);
          setLoaded(true);
          break;
        case 'download-added':
        case 'download-done':
        case 'download-restarted':
          if (event.download.id === id) setRecord(event.download);
          break;
        case 'download-removed':
          if (event.id === id) setRecord(null);
          break;
        case 'download-error':
          if (event.id === id) {
            setRecord((prev) => (prev ? { ...prev, status: 'failed', error: event.error } : prev));
          }
          break;
        case 'progress': {
          const patch = event.downloads.find((d) => d.id === id);
          if (patch) setRecord((prev) => (prev ? { ...prev, ...patch } : prev));
          break;
        }
      }
    };

    let dispose = (): void => {};
    void (async () => {
      await authenticate();
      dispose = subscribe({ onEvent: apply, onConnected: () => {} });
    })();
    return () => dispose();
  }, [id]);

  // Size the window to what it shows, so it is never a mostly-empty panel.
  // The root is rendered in every state and the observer sees every change
  // inside it, so this only has to be set up once.
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const fit = (): void => void window.idm?.fitHeight(el.offsetHeight);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="dw" ref={root}>
      <div className="dw-drag" />
      {record ? (
        <Detail record={record} />
      ) : (
        <div className="dw-gone">
          <p>{loaded ? 'This download is no longer in the list.' : 'Connecting…'}</p>
          {loaded && (
            <button className="dw-btn" onClick={() => void window.idm?.closeSelf()}>
              Close
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Detail({ record: d }: { record: DownloadRecord }): React.ReactElement {
  const [showConnections, setShowConnections] = useState(false);

  const done = d.status === 'completed';
  const failed = d.status === 'failed';
  const running = d.status === 'downloading' || d.status === 'probing';
  const pct = done
    ? 100
    : d.totalSize && d.totalSize > 0
      ? Math.min(100, (d.downloaded / d.totalSize) * 100)
      : 0;
  const indeterminate = running && !d.totalSize;

  // The window title is where IDM puts the live percentage, and the only part
  // still legible when the window is minimised into the dock.
  useEffect(() => {
    document.title = running && d.totalSize ? `${Math.floor(pct)}% ${d.filename}` : d.filename;
  }, [running, pct, d.filename, d.totalSize]);

  // Resumable once the server has honoured ranges, which more than one segment
  // proves; before that, a known size from a direct URL is the best signal.
  const resumable = d.segments.length > 1 || (d.totalSize !== null && !d.useYtdlp);
  const CatIcon = Icon.CATEGORY_ICON[d.category];
  const act = (path: string): void => void post(path, { id: d.id });
  const close = (): void => void window.idm?.closeSelf();

  const meta = [
    d.sourcePage ? hostOf(d.sourcePage) : hostOf(d.url),
    d.totalSize ? bytes(d.totalSize) : null,
    resumable && !done ? 'Resumable' : null,
  ].filter(Boolean);

  return (
    <div className={`dw-body ${d.status}`}>
      <header className="dw-head">
        <div className={`dw-icon ${d.category}`}>
          {done ? <Icon.Check size={18} /> : <CatIcon size={18} />}
        </div>
        <div className="dw-title">
          <h1 title={d.filename}>{d.filename}</h1>
          <p>{meta.join(' · ')}</p>
        </div>
      </header>

      {done ? (
        <p className="dw-done">Download complete</p>
      ) : failed ? (
        <p className="dw-error" title={d.error}>
          {humanizeError(d.error ?? 'The download failed')}
        </p>
      ) : (
        <section className="dw-progress">
          <div className="dw-figures">
            <span className="dw-pct">
              {indeterminate
                ? 'Downloading'
                : d.status === 'probing'
                  ? 'Connecting'
                  : `${Math.floor(pct)}%`}
            </span>
            <span className="dw-rate">
              {d.status === 'paused' ? 'Paused' : d.rateBps > 0 ? rate(d.rateBps) : 'Starting…'}
            </span>
          </div>

          <div className={indeterminate ? 'bar big indeterminate' : 'bar big'}>
            <div className="fill" style={indeterminate ? undefined : { width: `${pct}%` }} />
          </div>

          <div className="dw-sub">
            <span>
              {bytes(d.downloaded)}
              {d.totalSize ? ` of ${bytes(d.totalSize)}` : ''}
            </span>
            <span>{running && d.etaSeconds !== null ? `${eta(d.etaSeconds)} left` : ''}</span>
          </div>
        </section>
      )}

      {!done && d.segments.length > 1 && (
        <section className="dw-conns">
          <button
            className="dw-disclosure"
            aria-expanded={showConnections}
            onClick={() => setShowConnections((v) => !v)}
          >
            <span className="dw-caret" aria-hidden="true" />
            {d.segments.length} connections
          </button>

          {showConnections && (
            <>
              <div className="conn-strip">
                {d.segments.map((s, i) => {
                  const total = d.totalSize ?? 1;
                  const width = ((s.end - s.start + 1) / total) * 100;
                  const left = (s.start / total) * 100;
                  const filled = Math.min(
                    100,
                    Math.max(0, ((s.cursor - s.start) / (s.end - s.start + 1)) * 100),
                  );
                  return (
                    <div
                      key={`${s.start}-${i}`}
                      className="conn-seg"
                      style={{ left: `${left}%`, width: `${width}%` }}
                    >
                      <div className="conn-seg-fill" style={{ width: `${filled}%` }} />
                    </div>
                  );
                })}
              </div>

              <div className="conn-table" role="table">
                {d.segments.map((s, i) => {
                  const got = Math.max(0, s.cursor - s.start);
                  const size = s.end - s.start + 1;
                  const complete = s.cursor > s.end;
                  return (
                    <div className="conn-row" role="row" key={`r-${s.start}-${i}`}>
                      <span className="conn-n">{i + 1}</span>
                      <span className="conn-bytes">{bytes(got)}</span>
                      <span className={complete ? 'conn-info done' : 'conn-info'}>
                        {complete
                          ? 'Complete'
                          : running
                            ? `${((got / size) * 100).toFixed(0)}%`
                            : 'Waiting'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </section>
      )}

      <footer className="dw-actions">
        {running && (
          <>
            <button className="dw-btn" onClick={() => act('/downloads/pause')}>
              <Icon.Pause size={13} /> Pause
            </button>
            {/* Stop keeps the download in the list, so it can be resumed or
                downloaded again later. Removing it is the list's job. */}
            <button
              className="dw-btn"
              onClick={() => {
                act('/downloads/pause');
                close();
              }}
            >
              Stop
            </button>
          </>
        )}
        {d.status === 'paused' && (
          <button className="dw-btn primary" onClick={() => act('/downloads/resume')}>
            <Icon.Play size={13} /> Resume
          </button>
        )}
        {failed && (
          <>
            <button className="dw-btn primary" onClick={() => act('/downloads/restart')}>
              <Icon.Retry size={13} /> Download again
            </button>
            {/* Continuing is only worth offering when there is something to
                continue from, and the server has not changed the file. */}
            {d.downloaded > 0 && !/remote file changed/i.test(d.error ?? '') && (
              <button className="dw-btn" onClick={() => act('/downloads/resume')}>
                Resume
              </button>
            )}
          </>
        )}
        {done && (
          <>
            <button className="dw-btn primary" onClick={() => void window.idm?.open(d.filePath)}>
              <Icon.ExternalOpen size={13} /> Open
            </button>
            <button className="dw-btn" onClick={() => void window.idm?.reveal(d.filePath)}>
              <Icon.FolderOpen size={13} /> Show in folder
            </button>
          </>
        )}

        <span className="dw-spacer" />
        <button className="dw-btn ghost" onClick={close}>
          {running ? 'Hide' : 'Close'}
        </button>
      </footer>
    </div>
  );
}
