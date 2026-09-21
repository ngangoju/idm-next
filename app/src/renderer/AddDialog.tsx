import { useState } from 'react';
import type { AddDownloadRequest } from '../shared/protocol.ts';

/** IDM's advanced add dialog: the options power users actually reach for. */
export function AddDialog({
  defaultConnections,
  onClose,
  onSubmit,
}: {
  /** Taken from settings when they are loaded, else a sane default — this
      dialog must not be blocked on a settings fetch. */
  defaultConnections: number;
  onClose: () => void;
  onSubmit: (req: AddDownloadRequest) => void | Promise<void>;
}): React.ReactElement {
  const [url, setUrl] = useState('');
  const [filename, setFilename] = useState('');
  const [destDir, setDestDir] = useState('');
  const [connections, setConnections] = useState(defaultConnections);
  const [referer, setReferer] = useState('');
  const [cookie, setCookie] = useState('');
  const [checksum, setChecksum] = useState('');
  const [startPaused, setStartPaused] = useState(false);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!url.trim()) return;

    const headers: Record<string, string> = {};
    if (referer.trim()) headers['referer'] = referer.trim();
    if (cookie.trim()) headers['cookie'] = cookie.trim();

    void onSubmit({
      url: url.trim(),
      connections,
      startPaused,
      ...(filename.trim() ? { filename: filename.trim() } : {}),
      ...(destDir.trim() ? { destDir: destDir.trim() } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(checksum.trim()
        ? { checksum: { algorithm: 'sha256' as const, value: checksum.trim() } }
        : {}),
    });
  };

  return (
    <div className="overlay" onClick={onClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2>Add download</h2>

        <label>
          URL
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/file.zip"
          />
        </label>

        <div className="two">
          <label>
            Save as
            <input
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="(from server)"
            />
          </label>
          <label>
            Connections
            <input
              type="number"
              min={1}
              max={32}
              value={connections}
              onChange={(e) => setConnections(Number(e.target.value))}
            />
          </label>
        </div>

        <label>
          Folder
          <div className="row-inline">
            <input
              value={destDir}
              onChange={(e) => setDestDir(e.target.value)}
              placeholder="(by category)"
            />
            <button
              type="button"
              onClick={async () => {
                const dir = await window.idm?.chooseDir();
                if (dir) setDestDir(dir);
              }}
            >
              Browse
            </button>
          </div>
        </label>

        <details>
          <summary>Advanced</summary>
          <label>
            Referer
            <input value={referer} onChange={(e) => setReferer(e.target.value)} />
          </label>
          <label>
            Cookie
            <input value={cookie} onChange={(e) => setCookie(e.target.value)} />
          </label>
          <label>
            Expected SHA-256
            <input value={checksum} onChange={(e) => setChecksum(e.target.value)} />
          </label>
        </details>

        <label className="check">
          <input
            type="checkbox"
            checked={startPaused}
            onChange={(e) => setStartPaused(e.target.checked)}
          />
          Add paused
        </label>

        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Download
          </button>
        </div>
      </form>
    </div>
  );
}
