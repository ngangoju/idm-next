import type { DownloadRecord } from '../shared/protocol.ts';
import { humanizeError } from '../shared/protocol.ts';
import { bytes, eta, rate, hostOf } from './format.ts';
import * as Icon from './icons.tsx';


/**
 * The per-download detail window.
 *
 * Modelled on IDM's: the figures it shows are the ones people actually check
 * mid-download — size, how much has arrived, current rate, time left, and
 * whether it can be resumed if something goes wrong.
 *
 * The connection table is the part a single progress bar cannot express. Each
 * row is one HTTP connection working its own byte range, and because segments
 * are split by work stealing the list grows and the shares move while you
 * watch. That is the scheduler doing its job, and it is worth being able to
 * see it.
 */
export function DetailDialog({
  record: d,
  onClose,
  onAct,
}: {
  record: DownloadRecord;
  onClose: () => void;
  onAct: (path: string, id: string) => void;
}): React.ReactElement {
  const done = d.status === 'completed';
  const pct = done
    ? 100
    : d.totalSize && d.totalSize > 0
      ? Math.min(100, (d.downloaded / d.totalSize) * 100)
      : 0;
  const indeterminate = !done && d.status === 'downloading' && !d.totalSize;

  const statusText: Record<string, string> = {
    downloading: d.rateBps > 0 ? 'Receiving data…' : 'Starting…',
    paused: 'Paused',
    completed: 'Complete',
    failed: 'Failed',
    probing: 'Connecting…',
    cancelled: 'Cancelled',
  };

  // A transfer is resumable when the server honoured ranges, which is exactly
  // what having more than one segment proves.
  const resumable = d.segments.length > 1 || (d.totalSize !== null && !d.useYtdlp);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog detail" onClick={(e) => e.stopPropagation()}>
        <header className="detail-head">
          <span className="detail-pct">{done ? '100%' : `${Math.round(pct)}%`}</span>
          <h2 title={d.filename}>{d.filename}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <span aria-hidden="true">&#x2715;</span>
          </button>
        </header>

        <a
          className="detail-url"
          title={d.url}
          onClick={(e) => {
            e.preventDefault();
          }}
        >
          {d.url}
        </a>

        <dl className="stats">
          <div>
            <dt>Status</dt>
            <dd className={`st-${d.status}`}>{statusText[d.status] ?? d.status}</dd>
          </div>
          <div>
            <dt>File size</dt>
            <dd>{d.totalSize ? bytes(d.totalSize) : 'Unknown'}</dd>
          </div>
          <div>
            <dt>Downloaded</dt>
            <dd>
              {bytes(d.downloaded)}
              {d.totalSize ? <span className="muted-inline"> ({pct.toFixed(2)}%)</span> : null}
            </dd>
          </div>
          <div>
            <dt>Transfer rate</dt>
            <dd>{d.status === 'downloading' && d.rateBps > 0 ? rate(d.rateBps) : '—'}</dd>
          </div>
          <div>
            <dt>Time left</dt>
            <dd>{d.status === 'downloading' ? eta(d.etaSeconds) : '—'}</dd>
          </div>
          <div>
            <dt>Resume capability</dt>
            <dd className={resumable ? 'yes' : 'no'}>{resumable ? 'Yes' : 'No'}</dd>
          </div>
          {d.sourcePage && (
            <div>
              <dt>From</dt>
              <dd>{hostOf(d.sourcePage)}</dd>
            </div>
          )}
          <div>
            <dt>Saving to</dt>
            <dd className="path" title={d.filePath}>
              {d.filePath}
            </dd>
          </div>
        </dl>

        <div className={indeterminate ? 'bar big indeterminate' : 'bar big'}>
          <div className="fill" style={indeterminate ? undefined : { width: `${pct}%` }} />
        </div>

        {d.error && (
          <p className="row-error" title={d.error}>
            {humanizeError(d.error)}
          </p>
        )}

        {d.segments.length > 1 && (
          <>
            <p className="detail-caption">Start positions and progress by connection</p>

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
              <div className="conn-row conn-head" role="row">
                <span>N.</span>
                <span>Downloaded</span>
                <span>Info</span>
              </div>
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
                        : d.status === 'downloading'
                          ? `Receiving data… (${((got / size) * 100).toFixed(0)}%)`
                          : 'Waiting'}
                    </span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="dialog-actions">
          {d.status === 'downloading' && (
            <button onClick={() => onAct('/downloads/pause', d.id)}>
              <Icon.Pause size={13} /> Pause
            </button>
          )}
          {(d.status === 'paused' || d.status === 'failed') && (
            <button onClick={() => onAct('/downloads/resume', d.id)}>
              <Icon.Play size={13} /> Resume
            </button>
          )}
          {done && (
            <>
              <button onClick={() => void window.idm?.reveal(d.filePath)}>
                <Icon.FolderOpen size={13} /> Show in folder
              </button>
              <button className="primary" onClick={() => void window.idm?.open(d.filePath)}>
                <Icon.ExternalOpen size={13} /> Open
              </button>
            </>
          )}
          {!done && (
            <button
              onClick={() => {
                onAct('/downloads/cancel', d.id);
                onClose();
              }}
            >
              Cancel download
            </button>
          )}
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
