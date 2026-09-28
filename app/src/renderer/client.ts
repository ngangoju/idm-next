/**
 * The renderer's connection to the app.
 *
 * There is more than one window now — the list, and a progress window per
 * download — and both talk to the same local server. The transport lives here
 * so neither of them owns it.
 */
import { DEFAULT_PORT, type ServerEvent } from '../shared/protocol.ts';

export const API = `http://127.0.0.1:${DEFAULT_PORT}`;

declare global {
  interface Window {
    idm?: {
      reveal(p: string): Promise<void>;
      open(p: string): Promise<string>;
      chooseDir(): Promise<string | null>;
      port(): Promise<number>;
      token(): Promise<string>;
      openDetail(id: string): Promise<void>;
      closeSelf(): Promise<void>;
      fitHeight(px: number): Promise<void>;
    };
  }
}

/**
 * The renderer authenticates with a token from preload rather than by origin:
 * a packaged build loads from file:// and reports `Origin: null`, which cannot
 * be allowlisted because a sandboxed iframe on any site reports it too.
 */
let authToken = '';

/** Must resolve before anything else here is called. */
export async function authenticate(): Promise<void> {
  authToken = (await window.idm?.token()) ?? '';
}

export function headers(json = false): Record<string, string> {
  return json
    ? { 'content-type': 'application/json', 'x-idm-token': authToken }
    : { 'x-idm-token': authToken };
}

export async function post(path: string, body: unknown = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: headers() });
  return res.json() as Promise<T>;
}

/**
 * Opens the event socket and keeps it open, reconnecting after a drop.
 * Returns a disposer.
 */
export function subscribe(handlers: {
  onEvent: (event: ServerEvent) => void;
  onConnected: (up: boolean) => void;
}): () => void {
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout>;
  let closed = false;

  const connect = (): void => {
    // A browser cannot set headers on a WebSocket handshake, so the token goes
    // in the query string here.
    ws = new WebSocket(`ws://127.0.0.1:${DEFAULT_PORT}/?token=${encodeURIComponent(authToken)}`);
    ws.onopen = () => handlers.onConnected(true);
    ws.onclose = () => {
      handlers.onConnected(false);
      if (!closed) retry = setTimeout(connect, 1000);
    };
    ws.onmessage = (e: MessageEvent<string>) => handlers.onEvent(JSON.parse(e.data) as ServerEvent);
  };

  connect();

  return () => {
    closed = true;
    clearTimeout(retry);
    ws?.close();
  };
}

/**
 * Put the page in the theme the app is in.
 *
 * The main process sets Electron's `nativeTheme.themeSource` from the setting,
 * and that is what `prefers-color-scheme` reports here — for "light" and "dark"
 * as well as "system". So there is one source of truth, it is right before the
 * first paint (no flash of the wrong theme), and a change in Settings or in the
 * OS arrives as an ordinary media-query change.
 */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function syncTheme(): void {
  const root = document.documentElement;
  // Every hover colour in the app is transitioned, so without this a theme
  // change animates element by element and looks half-switched for a moment.
  root.classList.add('theme-switching');
  root.dataset.theme = darkQuery.matches ? 'dark' : 'light';
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.classList.remove('theme-switching')),
  );
}

export function followTheme(): void {
  syncTheme();
  darkQuery.addEventListener('change', syncTheme);
}
