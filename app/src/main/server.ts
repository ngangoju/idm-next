/**
 * The local control server: the renderer and the browser extension both talk to
 * the app through this.
 *
 * Security model, since "it's only localhost" is not one:
 *
 *  - Bound to 127.0.0.1, so nothing off-host can reach it at all.
 *  - The renderer authenticates with a token handed to it over preload IPC.
 *    It cannot rely on its origin: a packaged renderer loads from file:// and
 *    sends `Origin: null`, and so does a sandboxed iframe on any hostile page,
 *    so `null` can never be allowlisted.
 *  - The extension authenticates by `Origin`, which must be an allowlisted
 *    extension id. A web page cannot forge `Origin` — the browser sets it — so
 *    this is what stops any site you visit from driving your downloader.
 *  - `Host` must be `127.0.0.1:<port>` verbatim. Without this check, an
 *    attacker's domain with a DNS record pointing at 127.0.0.1 would let a page
 *    reach us as a same-origin request (DNS rebinding).
 *  - Mutations are POST-only, so a bare <img src> or top-level navigation
 *    cannot trigger one.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DownloadManager } from './manager.ts';
import {
  DEFAULT_PORT,
  type AddDownloadRequest,
  type ServerEvent,
} from '../shared/protocol.ts';

export interface ServerOptions {
  manager: DownloadManager;
  port?: number;
  /** Extension ids permitted to call in, without the scheme. */
  allowedExtensionIds: string[];
  /** Secret handed to the renderer over IPC; grants access regardless of origin. */
  authToken: string;
  /**
   * Extra origins to accept, for running the renderer against a Vite dev
   * server. Only ever populated from IDM_DEV_ORIGIN, which no packaged build
   * sets — a release accepts the extension and the token, nothing else.
   */
  devOrigins?: string[];
  version?: string;
}

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Hard ceiling on what we will read before hanging up. Past MAX_BODY_BYTES we
 * stop buffering but keep draining to this point, so the 413 can actually be
 * delivered; a client that keeps writing past it is not worth answering.
 */
const DRAIN_CAP_BYTES = 16 * 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super('request body too large');
    this.name = 'BodyTooLargeError';
  }
}

export class ControlServer {
  private readonly manager: DownloadManager;
  private readonly port: number;
  private readonly allowedOrigins: Set<string>;
  private readonly authToken: string;
  private readonly version: string;
  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private sockets = new Set<WebSocket>();

  constructor(opts: ServerOptions) {
    this.manager = opts.manager;
    this.port = opts.port ?? DEFAULT_PORT;
    this.authToken = opts.authToken;
    this.version = opts.version ?? '0.1.0';
    this.allowedOrigins = new Set([
      ...opts.allowedExtensionIds.flatMap((id) => [
        `chrome-extension://${id}`,
        // Brave uses the chrome-extension scheme too; listed for clarity.
        `moz-extension://${id}`,
      ]),
      ...(opts.devOrigins ?? []),
    ]);
  }

  get address(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.http = createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ noServer: true });

    this.http.on('upgrade', (req, socket, head) => {
      // The upgrade path needs the same checks as a normal request; it is a
      // separate entry point into the same capability.
      if (this.reject(req) !== null) {
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });

    this.wireEvents();

    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(this.port, '127.0.0.1', () => resolve());
    });
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.close();
    this.sockets.clear();
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.closeAllConnections();
      this.http.close(() => resolve());
    });
  }

  /** Returns a rejection reason, or null when the request may proceed. */
  private reject(req: IncomingMessage): string | null {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      return 'bad Host header';
    }

    // The renderer's token beats the origin check, because its origin is
    // file:// (which reports as "null") in a packaged build and the dev server
    // origin in development. Neither can be allowlisted safely.
    if (this.hasValidToken(req)) return null;

    const origin = req.headers.origin;
    if (origin === undefined) return null; // local tools: curl, health checks
    if (!this.allowedOrigins.has(origin)) return 'origin not allowed';
    return null;
  }

  private hasValidToken(req: IncomingMessage): boolean {
    const header = req.headers['x-idm-token'];
    const fromHeader = Array.isArray(header) ? header[0] : header;
    if (fromHeader !== undefined) return safeEqual(fromHeader, this.authToken);

    // A browser cannot set headers on a WebSocket handshake, so the token
    // rides in the query string there. It is a loopback-only local secret,
    // never user data.
    try {
      const fromQuery = new URL(req.url ?? '/', this.address).searchParams.get('token');
      return fromQuery !== null && safeEqual(fromQuery, this.authToken);
    } catch {
      return false;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;

    // Answer the preflight before authenticating, because a preflight cannot
    // be authenticated: the browser sends it without the custom header, so
    // `x-idm-token` is never present on an OPTIONS. Rejecting it here meant
    // every renderer fetch failed before it was ever sent — the UI only looked
    // alive because downloads arrive over the WebSocket, which has no
    // preflight. A permissive preflight authorizes nothing; the real request
    // that follows is still fully checked.
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-idm-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204);
      res.end();
      return;
    }

    const denied = this.reject(req);
    if (denied !== null) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: denied }));
      return;
    }

    // The request authenticated, so the browser may read the response. That
    // includes `Origin: null` from a packaged file:// renderer holding a valid
    // token.
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Headers', 'content-type, x-idm-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Vary', 'Origin');
    }

    const url = new URL(req.url ?? '/', this.address);
    const path = url.pathname;

    try {
      // Reads.
      if (req.method === 'GET') {
        switch (path) {
          case '/health':
            return json(res, 200, { ok: true, version: this.version });
          case '/downloads':
            return json(res, 200, { downloads: this.manager.records });
          case '/queues':
            return json(res, 200, { queues: this.manager.queues });
          case '/settings':
            return json(res, 200, { settings: this.manager.settings });
          case '/ytdlp':
            return json(res, 200, await this.manager.ytdlpStatus());
          default:
            return json(res, 404, { error: 'not found' });
        }
      }

      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });

      const body = await readBody(req);

      switch (path) {
        case '/probe': {
          const { url: target, headers } = body as { url?: string; headers?: Record<string, string> };
          if (!isHttpUrl(target)) return json(res, 400, { error: 'bad url' });
          return json(res, 200, await this.manager.probeUrl(target, headers));
        }
        case '/extract': {
          const { url: target } = body as { url?: string };
          if (!isHttpUrl(target)) return json(res, 400, { error: 'bad url' });
          try {
            return json(res, 200, await this.manager.extract(target));
          } catch (err) {
            return json(res, 502, {
              error: err instanceof Error ? err.message : 'extraction failed',
            });
          }
        }
        case '/downloads': {
          const reqBody = body as AddDownloadRequest;
          if (!isHttpUrl(reqBody.url)) return json(res, 400, { error: 'bad url' });
          const record = this.manager.add(reqBody);
          return json(res, 200, { download: record });
        }
        case '/downloads/pause': {
          const { id } = body as { id?: string };
          if (!id) return json(res, 400, { error: 'missing id' });
          await this.manager.pause(id);
          return json(res, 200, { ok: true });
        }
        case '/downloads/resume': {
          const { id } = body as { id?: string };
          if (!id) return json(res, 400, { error: 'missing id' });
          this.manager.resume(id);
          return json(res, 200, { ok: true });
        }
        case '/downloads/cancel': {
          const { id } = body as { id?: string };
          if (!id) return json(res, 400, { error: 'missing id' });
          await this.manager.cancel(id);
          return json(res, 200, { ok: true });
        }
        case '/settings':
          return json(res, 200, { settings: this.manager.updateSettings(body as never) });
        default:
          return json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        // readBody drained the rest, so the connection is clean and the client
        // is ready to read this.
        return json(res, 413, { error: err.message });
      }
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private onSocket(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    send(ws, { type: 'hello', version: this.version });
    send(ws, { type: 'downloads', downloads: this.manager.records });
  }

  private wireEvents(): void {
    this.manager.on('added', (download) => this.broadcast({ type: 'download-added', download }));
    this.manager.on('done', (download) => this.broadcast({ type: 'download-done', download }));
    this.manager.on('failed', ({ id, error }) =>
      this.broadcast({ type: 'download-error', id, error }),
    );
    this.manager.on('removed', ({ id }) => this.broadcast({ type: 'download-removed', id }));
    this.manager.on('settings', (settings) => this.broadcast({ type: 'settings', settings }));
    this.manager.on('progress', (batch) =>
      this.broadcast({
        type: 'progress',
        downloads: batch.map((d) => ({
          id: d.id,
          status: d.status,
          downloaded: d.downloaded,
          totalSize: d.totalSize,
          rateBps: d.rateBps,
          etaSeconds: d.etaSeconds,
          segments: d.segments,
          filename: d.filename,
          category: d.category,
          filePath: d.filePath,
          error: d.error,
        })),
      }),
    );
  }

  broadcast(event: ServerEvent): void {
    for (const ws of this.sockets) send(ws, event);
  }
}

function send(ws: WebSocket, event: ServerEvent): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/** Constant-time compare, so the token cannot be recovered by timing. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let chunks: Buffer[] = [];
  let size = 0;
  let overflow = false;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;

    if (size > DRAIN_CAP_BYTES) {
      // Beyond any plausible mistake; stop paying for it.
      req.socket.destroy();
      throw new BodyTooLargeError();
    }

    if (size > MAX_BODY_BYTES) {
      // Stop buffering — an unbounded local endpoint is a trivial memory DoS —
      // but keep consuming. Answering while the client is still uploading means
      // either a reset it never reads, or an unread remainder that the next
      // request on this keep-alive connection would be parsed from.
      overflow = true;
      chunks = [];
      continue;
    }

    if (!overflow) chunks.push(chunk as Buffer);
  }

  if (overflow) throw new BodyTooLargeError();
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}
