import { useState } from 'react';
import type { Settings } from '../shared/protocol.ts';

/** Speed caps are stored in bytes/sec but nobody thinks in bytes/sec. */
const toMBps = (bps: number): string => (bps > 0 ? (bps / (1024 * 1024)).toFixed(1) : '');
const fromMBps = (v: string): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1024 * 1024) : 0;
};

export function SettingsDialog({
  settings,
  ytdlp,
  onClose,
  onSave,
}: {
  settings: Settings;
  ytdlp: { ok: boolean; version?: string; error?: string } | null;
  onClose: () => void;
  onSave: (patch: Partial<Settings>) => void | Promise<void>;
}): React.ReactElement {
  const [draft, setDraft] = useState<Settings>(settings);
  const [rate, setRate] = useState(toMBps(settings.globalRateBps));

  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void onSave({ ...draft, globalRateBps: fromMBps(rate) });
        }}
      >
        <h2>Settings</h2>

        <label>
          Download folder
          <div className="row-inline">
            <input value={draft.downloadDir} onChange={(e) => set('downloadDir', e.target.value)} />
            <button
              type="button"
              onClick={async () => {
                const dir = await window.idm?.chooseDir();
                if (dir) set('downloadDir', dir);
              }}
            >
              Browse
            </button>
          </div>
        </label>

        <div className="two">
          <label>
            Connections per download
            <input
              type="number"
              min={1}
              max={32}
              value={draft.defaultConnections}
              onChange={(e) => set('defaultConnections', Number(e.target.value))}
            />
          </label>
          <label>
            Max concurrent
            <input
              type="number"
              min={1}
              max={16}
              value={draft.maxConcurrentDownloads}
              onChange={(e) => set('maxConcurrentDownloads', Number(e.target.value))}
            />
          </label>
        </div>

        <label>
          Global speed limit (MB/s — blank for unlimited)
          <input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="unlimited" />
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.clipboardMonitor}
            onChange={(e) => set('clipboardMonitor', e.target.checked)}
          />
          Watch the clipboard for download links
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.browserTakeover}
            onChange={(e) => set('browserTakeover', e.target.checked)}
          />
          Take over downloads started in the browser
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.autoOpenDetails}
            onChange={(e) => set('autoOpenDetails', e.target.checked)}
          />
          Show the detail window when a download starts
        </label>

        <label className="check">
          <input
            type="checkbox"
            checked={draft.shutdownWhenQueueDone}
            onChange={(e) => set('shutdownWhenQueueDone', e.target.checked)}
          />
          Offer to shut down when a queue finishes
        </label>

        <details>
          <summary>Advanced</summary>
          <label>
            Proxy
            <input
              value={draft.proxy ?? ''}
              onChange={(e) => set('proxy', e.target.value || null)}
              placeholder="http://host:port"
            />
          </label>
          <label>
            Post-download command ({'{file}'} is replaced with the path)
            <input
              value={draft.postDownloadCommand ?? ''}
              onChange={(e) => set('postDownloadCommand', e.target.value || null)}
              placeholder="clamscan {file}"
            />
          </label>
          <label>
            yt-dlp path
            <input value={draft.ytdlpPath} onChange={(e) => set('ytdlpPath', e.target.value)} />
          </label>
          <label>
            ffmpeg path
            <input value={draft.ffmpegPath} onChange={(e) => set('ffmpegPath', e.target.value)} />
          </label>
          {/* Say plainly whether the external tools are actually usable — a
              missing binary otherwise only shows up as a failed download. */}
          <p className={ytdlp?.ok ? 'muted' : 'warn-line'}>
            {ytdlp === null
              ? 'Checking yt-dlp…'
              : ytdlp.ok
                ? `yt-dlp ${ytdlp.version} found — page and stream downloads available.`
                : `${ytdlp.error} Page and stream downloads will not work until this is fixed.`}
          </p>
        </details>

        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
