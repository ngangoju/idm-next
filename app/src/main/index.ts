/**
 * Electron main process.
 *
 * The engine lives here rather than in a separate daemon. "Downloads survive
 * closing the window" is the ordinary tray pattern: we simply don't quit on
 * window-all-closed. Quitting from the tray is what actually stops transfers,
 * which is also how IDM behaves.
 */
import { app, BrowserWindow, Tray, Menu, nativeImage, clipboard, Notification, shell, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from './store.ts';
import { DownloadManager } from './manager.ts';
import { ControlServer } from './server.ts';
import { DEFAULT_PORT } from '../shared/protocol.ts';

/**
 * This file is bundled to CommonJS for Electron, so __dirname exists at
 * runtime. It is declared rather than derived from import.meta.url, which
 * esbuild leaves undefined in a CJS bundle.
 */
declare const __dirname: string;
const appDir: string = __dirname;

/**
 * Extension ids allowed to reach the control server. The unpacked development
 * id is generated from the extension directory path, so it differs per machine;
 * it is read from an env var during development and baked in for a release.
 */
const ALLOWED_EXTENSION_IDS = [
  // Deterministic: the extension's manifest pins a public "key", so Chrome and
  // Brave both derive this same id whether it is loaded unpacked or installed.
  'nillkncbloeeggoephkkfnafgdnknmel',
  process.env.IDM_EXTENSION_ID,
].filter((v): v is string => typeof v === 'string' && v.length > 0);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let manager: DownloadManager;
let server: ControlServer;
let quitting = false;

/**
 * Credential for the renderer. Regenerated every launch and never written to
 * disk: it only has to outlive the process that handed it out.
 */
const AUTH_TOKEN = randomBytes(32).toString('hex');

// A second launch should focus the running instance, not start a rival copy
// that fights over the port and the state file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  void app.whenReady().then(main);
}

async function main(): Promise<void> {
  const store = await Store.open(join(app.getPath('userData'), 'state.json'));
  manager = new DownloadManager(store);
  await manager.init();

  server = new ControlServer({
    manager,
    port: DEFAULT_PORT,
    allowedExtensionIds: ALLOWED_EXTENSION_IDS,
    authToken: AUTH_TOKEN,
    // Set only by the dev script, never by a packaged build.
    ...(process.env.IDM_DEV_ORIGIN ? { devOrigins: [process.env.IDM_DEV_ORIGIN] } : {}),
    version: app.getVersion(),
  });

  try {
    await server.start();
  } catch (err) {
    // Almost always a stale instance or a port clash. Say so plainly instead of
    // failing silently, because the extension will appear broken.
    dialog.showErrorBox(
      'IDM-Next could not start its local service',
      `Port ${DEFAULT_PORT} is unavailable, so the browser extension will not be able to reach the app.\n\n${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  createWindow();
  createTray();
  startClipboardMonitor();
  wireNotifications();

  app.on('activate', () => showWindow());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 860,
    minHeight: 480,
    title: 'IDM-Next',
    backgroundColor: '#0b0d11',
    // Frameless with inset traffic lights: the sidebar runs to the top edge
    // and the app stops looking like a web page in a window. The renderer
    // reserves space for the lights and marks its own drag regions.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(appDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(join(appDir, '../renderer/index.html'));
  }

  // Closing the window hides it; the tray keeps the transfers alive.
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Never let the renderer navigate away or spawn windows.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow(): void {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  // A 1x1 transparent image keeps this dependency-free; a real icon ships with
  // the packaged build.
  const icon = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPUlEQVR42mNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCgY3AAAP8AAB0ZQmlQAAAABJRU5ErkJggg==',
  );
  tray = new Tray(icon);
  tray.setToolTip('IDM-Next');
  refreshTray();
  tray.on('click', () => showWindow());

  setInterval(refreshTray, 1000);
}

function refreshTray(): void {
  if (!tray) return;
  const active = manager.records.filter((d) => d.status === 'downloading');
  const total = active.reduce((n, d) => n + d.rateBps, 0);

  tray.setToolTip(
    active.length === 0
      ? 'IDM-Next — idle'
      : `IDM-Next — ${active.length} active, ${formatRate(total)}`,
  );

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open IDM-Next', click: () => showWindow() },
      { type: 'separator' },
      {
        label: `${active.length} downloading — ${formatRate(total)}`,
        enabled: false,
      },
      { label: 'Pause all', click: () => void manager.pauseAll() },
      { type: 'separator' },
      {
        label: 'Quit (stops downloads)',
        click: () => {
          quitting = true;
          void shutdown().then(() => app.quit());
        },
      },
    ]),
  );
}

/**
 * Clipboard monitoring: poll, and offer when a copied URL looks like a file we
 * would handle. Only ever a suggestion — copying a link must not start a
 * download by itself.
 */
function startClipboardMonitor(): void {
  // Electron 44's clipboard.readText() is async (it mirrors the W3C
  // navigator.clipboard API), so the poll has to await and guard against
  // overlapping ticks.
  let last = '';
  let reading = false;

  setInterval(() => {
    if (!manager.settings.clipboardMonitor || reading) return;
    reading = true;
    void (async () => {
      try {
        await pollClipboard();
      } finally {
        reading = false;
      }
    })();
  }, 800);

  async function pollClipboard(): Promise<void> {
    const text = (await clipboard.readText()).trim();
    if (text === last) return;
    last = text;

    if (!looksLikeDownloadable(text, manager.settings.watchedExtensions)) return;

    const n = new Notification({
      title: 'Download this file?',
      body: text.slice(0, 120),
      actions: [{ type: 'button', text: 'Download' }],
    });
    n.on('action', () => {
      manager.add({ url: text });
      showWindow();
    });
    n.on('click', () => {
      manager.add({ url: text });
      showWindow();
    });
    n.show();
  }
}

export function looksLikeDownloadable(text: string, extensions: string[]): boolean {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const ext = url.pathname.split('.').pop()?.toLowerCase() ?? '';
  return extensions.includes(ext);
}

function wireNotifications(): void {
  manager.on('done', (record) => {
    const n = new Notification({
      title: 'Download complete',
      body: record.filename,
    });
    n.on('click', () => shell.showItemInFolder(record.filePath));
    n.show();
  });

  manager.on('queue-drained', () => {
    if (!manager.settings.shutdownWhenQueueDone) return;
    void offerShutdown();
  });

  ipcMain.handle('idm:reveal', (_e, filePath: string) => shell.showItemInFolder(filePath));
  ipcMain.handle('idm:open', (_e, filePath: string) => shell.openPath(filePath));
  ipcMain.handle('idm:choose-dir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('idm:port', () => DEFAULT_PORT);
  ipcMain.handle('idm:token', () => AUTH_TOKEN);
}

/** Shutdown-on-complete, behind a countdown the user can cancel. */
async function offerShutdown(): Promise<void> {
  const res = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Cancel', 'Shut down now'],
    defaultId: 0,
    cancelId: 0,
    title: 'Queue finished',
    message: 'All downloads in the queue are complete.',
    detail: 'The computer will shut down in 60 seconds unless you cancel.',
  });
  if (res.response !== 1) return;

  quitting = true;
  await shutdown();
  const { exec } = await import('node:child_process');
  const cmd =
    process.platform === 'win32'
      ? 'shutdown /s /t 0'
      : process.platform === 'darwin'
        ? 'osascript -e \'tell app "System Events" to shut down\''
        : 'systemctl poweroff';
  exec(cmd);
}

async function shutdown(): Promise<void> {
  await server?.stop().catch(() => {});
  await manager?.shutdown().catch(() => {});
}

// The whole point of the tray: closing the last window must not quit.
app.on('window-all-closed', () => {
  // Intentionally empty.
});

app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  void shutdown().then(() => app.quit());
});

function formatRate(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}
