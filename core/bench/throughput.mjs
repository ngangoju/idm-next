/**
 * Throughput benchmark.
 *
 * Two regimes, because they answer different questions:
 *
 *   "capped"    — the server limits EACH connection to a fixed rate. This is
 *                 what real servers and CDNs do, and it is the entire reason
 *                 multi-connection downloading is faster. Measures the win.
 *
 *   "unlimited" — the server serves as fast as the loopback allows. Nothing to
 *                 gain from more connections here, so any difference is our own
 *                 per-chunk overhead. Measures the cost.
 *
 * Run: node core/bench/throughput.mjs
 */
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const { Download } = await import('../src/index.ts');

const MB = 1024 * 1024;
const SIZE = 96 * MB;
/** Per-connection cap in the "capped" regime. */
const PER_CONN_BPS = 6 * MB;

const PAYLOAD = Buffer.alloc(256 * 1024, 7);

function startServer({ capped }) {
  const server = createServer((req, res) => {
    const range = req.headers.range;
    res.setHeader('ETag', '"bench"');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', 'application/octet-stream');

    if (!range) {
      res.setHeader('Content-Length', String(SIZE));
      res.writeHead(200);
      return res.end();
    }

    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : SIZE - 1;
    const len = end - start + 1;

    res.setHeader('Content-Range', `bytes ${start}-${end}/${SIZE}`);
    res.setHeader('Content-Length', String(len));
    res.writeHead(206);

    let sent = 0;
    let closed = false;
    req.on('close', () => (closed = true));

    if (!capped) {
      // As fast as the socket will take it.
      const pump = () => {
        while (sent < len && !closed) {
          const n = Math.min(PAYLOAD.length, len - sent);
          sent += n;
          if (!res.write(PAYLOAD.subarray(0, n))) {
            res.once('drain', pump);
            return;
          }
        }
        if (!closed) res.end();
      };
      pump();
      return;
    }

    // One slice every 25ms, sized to hit the per-connection cap.
    const slice = Math.max(1, Math.floor(PER_CONN_BPS / 40));
    const timer = setInterval(() => {
      if (closed || sent >= len) {
        clearInterval(timer);
        if (!closed && sent >= len) res.end();
        return;
      }
      const n = Math.min(slice, len - sent);
      let written = 0;
      while (written < n) {
        const chunk = Math.min(PAYLOAD.length, n - written);
        res.write(PAYLOAD.subarray(0, chunk));
        written += chunk;
      }
      sent += n;
    }, 25);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function run({ capped, connections, dir }) {
  const { server, port } = await startServer({ capped });
  const url = `http://127.0.0.1:${port}/bench-${capped ? 'c' : 'u'}-${connections}.bin`;

  const dl = new Download({ url, destDir: dir, connections });
  const started = performance.now();
  const done = once(dl, 'done');
  const failed = once(dl, 'error').then(([e]) => {
    throw e;
  });
  void dl.start();
  await Promise.race([done, failed]);
  const seconds = (performance.now() - started) / 1000;

  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dl.path, { force: true });

  return { seconds, mbps: SIZE / MB / seconds };
}

const dir = await mkdtemp(join(tmpdir(), 'idm-bench-'));
const counts = [1, 2, 4, 8, 16, 32];

console.log(`\nFile ${SIZE / MB} MB\n`);

console.log(`CAPPED  — server limits each connection to ${PER_CONN_BPS / MB} MB/s`);
console.log('  conns     time      speed    vs 1 conn');
let base = null;
for (const connections of counts) {
  const { seconds, mbps } = await run({ capped: true, connections, dir });
  base ??= mbps;
  console.log(
    `  ${String(connections).padStart(5)}  ${seconds.toFixed(2).padStart(7)}s  ` +
      `${mbps.toFixed(1).padStart(7)} MB/s  ${(mbps / base).toFixed(2).padStart(7)}x`,
  );
}

console.log(`\nUNLIMITED — server serves as fast as loopback allows`);
console.log('  conns     time      speed');
for (const connections of counts) {
  const { seconds, mbps } = await run({ capped: false, connections, dir });
  console.log(
    `  ${String(connections).padStart(5)}  ${seconds.toFixed(2).padStart(7)}s  ` +
      `${mbps.toFixed(1).padStart(7)} MB/s`,
  );
}

await rm(dir, { recursive: true, force: true });
console.log('');
