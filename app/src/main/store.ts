/**
 * Atomic JSON persistence.
 *
 * SQLite would mean a native module rebuilt against Electron's ABI for what is,
 * realistically, a few hundred rows. A JSON file written temp-then-rename gives
 * the same crash safety, and makes queue import/export fall out for free.
 */
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { DownloadRecord, Queue, Settings } from '../shared/protocol.ts';

export interface PersistedState {
  version: 1;
  downloads: DownloadRecord[];
  queues: Queue[];
  settings: Settings;
}

export function defaultSettings(): Settings {
  const home = homedir();
  return {
    downloadDir: join(home, 'Downloads', 'IDM-Next'),
    categoryDirs: {},
    defaultConnections: 16,
    globalRateBps: 0,
    maxConcurrentDownloads: 4,
    clipboardMonitor: true,
    watchedExtensions: [
      'zip', 'rar', '7z', 'tar', 'gz', 'iso', 'dmg', 'exe', 'msi', 'pkg', 'deb',
      'mp4', 'mkv', 'webm', 'mov', 'avi', 'mp3', 'flac', 'm4a', 'wav',
      'pdf', 'epub', 'apk',
    ],
    browserTakeover: true,
    postDownloadCommand: null,
    shutdownWhenQueueDone: false,
    autoOpenDetails: true,
    autoCloseDetails: true,
    theme: 'light',
    ytdlpPath: 'yt-dlp',
    ffmpegPath: 'ffmpeg',
    proxy: null,
  };
}

function emptyState(): PersistedState {
  return {
    version: 1,
    downloads: [],
    queues: [{ id: 'main', name: 'Main', maxConcurrent: 4, items: [], enabled: true }],
    settings: defaultSettings(),
  };
}

export class Store {
  private readonly path: string;
  private state: PersistedState;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  private constructor(path: string, state: PersistedState) {
    this.path = path;
    this.state = state;
  }

  static async open(path: string): Promise<Store> {
    let state = emptyState();
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      state = migrate(parsed);
    } catch {
      // Missing or corrupt: start clean rather than refusing to launch. The
      // .part files and their journals are the real recovery mechanism.
    }
    return new Store(path, state);
  }

  get data(): PersistedState {
    return this.state;
  }

  get settings(): Settings {
    return this.state.settings;
  }

  update(fn: (s: PersistedState) => void): void {
    fn(this.state);
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    // Coalesce the write burst that a progress tick produces.
    this.timer ??= setTimeout(() => void this.flush(), 500);
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.writing;
    this.dirty = false;

    const snapshot = JSON.stringify(this.state, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.path);
    });
    return this.writing;
  }
}

/**
 * Coerce whatever was on disk into a valid state.
 *
 * Every field is defaulted individually: a settings file written by an older
 * build is missing keys, and a half-populated Settings object crashes further
 * downstream than a missing file does.
 */
function migrate(raw: unknown): PersistedState {
  const base = emptyState();
  if (typeof raw !== 'object' || raw === null) return base;
  const obj = raw as Partial<PersistedState>;

  return {
    version: 1,
    downloads: Array.isArray(obj.downloads) ? obj.downloads.filter(isDownload) : [],
    queues: Array.isArray(obj.queues) && obj.queues.length > 0
      ? obj.queues.filter(isQueue)
      : base.queues,
    settings: { ...base.settings, ...(obj.settings ?? {}) },
  };
}

function isDownload(v: unknown): v is DownloadRecord {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Partial<DownloadRecord>;
  return typeof d.id === 'string' && typeof d.url === 'string' && typeof d.filePath === 'string';
}

function isQueue(v: unknown): v is Queue {
  if (typeof v !== 'object' || v === null) return false;
  const q = v as Partial<Queue>;
  return typeof q.id === 'string' && typeof q.name === 'string' && Array.isArray(q.items);
}
