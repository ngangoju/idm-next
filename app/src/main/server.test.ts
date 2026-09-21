/**
 * Server tests, weighted toward the access-control claims. "It's only
 * localhost" is not a security model, and each of these checks corresponds to a
 * specific way a web page could otherwise reach the downloader.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from './store.ts';
import { DownloadManager } from './manager.ts';
import { ControlServer } from './server.ts';

const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
const GOOD_ORIGIN = `chrome-extension://${EXT_ID}`;
const TOKEN = 'a'.repeat(64);

let server: ControlServer;
let manager: DownloadManager;
let dir: string;
let port: number;
let base: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'idm-srv-'));
  const store = await Store.open(join(dir, 'state.json'));
  store.update((s) => {
    s.settings.downloadDir = dir;
  });
  manager = new DownloadManager(store);
  await manager.init();

  // Port 0 would be simpler, but the Host check needs a known port, so take a
  // high one and accept the small flake risk.
  port = 45000 + Math.floor(Math.random() * 2000);
  base = `http://127.0.0.1:${port}`;
  server = new ControlServer({
    manager,
    port,
    allowedExtensionIds: [EXT_ID],
    authToken: TOKEN,
  });
  await server.start();
});

after(async () => {
  await server.stop();
  await manager.shutdown();
  await rm(dir, { recursive: true, force: true });
});

/** fetch() sets Host itself, so drive the socket directly to control it. */
async function rawRequest(headers: Record<string, string>, path = '/health'): Promise<number> {
  const { connect } = await import('node:net');
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        'Connection: close',
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    let data = '';
    socket.on('data', (d) => (data += d.toString()));
    socket.on('end', () => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(data)?.[1];
      status ? resolve(Number(status)) : reject(new Error(`no status in: ${data.slice(0, 80)}`));
    });
    socket.on('error', reject);
  });
}

describe('access control', () => {
  test('allows a request with no Origin (the renderer, curl)', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
  });

  test('allows the allowlisted extension origin', async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: GOOD_ORIGIN } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), GOOD_ORIGIN);
  });

  test('rejects an unknown extension id', async () => {
    const res = await fetch(`${base}/health`, {
      headers: { Origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' },
    });
    assert.equal(res.status, 403);
  });

  test('rejects Origin: null (file:// and sandboxed iframes both send it)', async () => {
    // The renderer loads from file:// in a packaged build and reports this
    // origin — but so does a sandboxed iframe on any hostile page, so it can
    // never be allowlisted. The renderer uses a token instead.
    const res = await fetch(`${base}/health`, { headers: { Origin: 'null' } });
    assert.equal(res.status, 403);
  });

  test('accepts the renderer token regardless of origin', async () => {
    const res = await fetch(`${base}/health`, {
      headers: { Origin: 'null', 'x-idm-token': TOKEN },
    });
    assert.equal(res.status, 200);
  });

  test('rejects a wrong token', async () => {
    const res = await fetch(`${base}/health`, {
      headers: { Origin: 'null', 'x-idm-token': 'b'.repeat(64) },
    });
    assert.equal(res.status, 403);
  });

  test('accepts a WebSocket carrying the token in the query string', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`, {
      headers: { Origin: 'null' },
    });
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('rejected'));
      ws.on('close', () => resolve('rejected'));
    });
    ws.close();
    assert.equal(outcome, 'open');
  });

  test('rejects a web page origin', async () => {
    // The case that matters: any site the user visits must not drive this.
    const res = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
  });

  test('rejects a foreign Host header (DNS rebinding)', async () => {
    // A domain resolving to 127.0.0.1 would reach us with its own Host. Without
    // this check the request looks local and the Origin check alone would not
    // save us on a no-CORS form post.
    assert.equal(await rawRequest({ Host: 'evil.example' }), 403);
    assert.equal(await rawRequest({ Host: `evil.example:${port}` }), 403);
  });

  test('accepts the literal loopback Host', async () => {
    assert.equal(await rawRequest({ Host: `127.0.0.1:${port}` }), 200);
  });

  test('rejects a WebSocket upgrade from a bad origin', async () => {
    const { WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, {
      headers: { Origin: 'https://evil.example' },
    });
    const outcome = await new Promise<string>((resolve) => {
      ws.on('open', () => resolve('open'));
      ws.on('error', () => resolve('rejected'));
      ws.on('close', () => resolve('rejected'));
    });
    assert.equal(outcome, 'rejected');
  });
});

describe('method discipline', () => {
  test('mutations are not reachable by GET', async () => {
    // Stops <img src> and top-level navigation from triggering a mutation.
    const res = await fetch(`${base}/downloads/cancel?id=x`);
    assert.equal(res.status, 404);
  });

  test('rejects an unsupported method', async () => {
    const res = await fetch(`${base}/settings`, { method: 'DELETE' });
    assert.equal(res.status, 405);
  });
});

describe('input validation', () => {
  test('rejects a non-http scheme', async () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      const res = await fetch(`${base}/downloads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      assert.equal(res.status, 400, `accepted ${url}`);
    }
  });

  test('rejects malformed JSON', async () => {
    const res = await fetch(`${base}/downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 500);
  });

  test('rejects an oversized body with 413', async () => {
    const res = await fetch(`${base}/downloads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://x.test/a', pad: 'x'.repeat(2 * 1024 * 1024) }),
    });
    assert.equal(res.status, 413);
  });

  test('a rejected oversized body does not poison the next request', async () => {
    // Regression: the server used to answer and leave the client still
    // writing, so the unread remainder was parsed as the following request on
    // that keep-alive connection.
    const res = await fetch(`${base}/downloads`);
    assert.equal(res.status, 200);
  });
});

describe('reads', () => {
  test('exposes downloads, queues and settings', async () => {
    for (const path of ['/downloads', '/queues', '/settings']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
    }
  });

  test('unknown paths 404', async () => {
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});
