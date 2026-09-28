/**
 * A deliberately misbehaving HTTP server.
 *
 * Every failure mode the engine claims to handle needs to be reproducible on
 * demand, otherwise the tests only prove it works against a well-behaved server
 * — which is the case that was never in doubt.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface FixtureOptions {
  /** Body served to clients. */
  body: Buffer;
  /** Refuse Range headers and answer 200 with the whole body. */
  noRanges?: boolean;
  /** Report this instead of the real size. */
  lieContentLength?: number;
  /** Kill the connection after this many bytes of each response. */
  dropAfterBytes?: number;
  /** Serve this ETag; change it between runs to simulate an edited file. */
  etag?: string | null;
  lastModified?: string | null;
  /** Answer the first N range requests with 429. */
  rateLimitFirst?: number;
  /** Retry-After value sent with a 429. */
  retryAfter?: string;
  /** Throttle any request whose range starts inside this window, in bytes/sec. */
  slowRange?: { from: number; to: number; bps: number };
  /** Send Content-Disposition with this raw value. */
  contentDisposition?: string;
  /** Content-Type to report; defaults to application/octet-stream. */
  contentType?: string;
}

export interface Fixture {
  url: string;
  server: Server;
  /** Every range request seen, in order, for assertions about scheduling. */
  requests: Array<{ range: string | undefined; method: string }>;
  options: FixtureOptions;
  close: () => Promise<void>;
}

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Deterministic pseudo-random body, so a corrupt byte is actually detectable. */
export function makeBody(size: number, seed = 1): Buffer {
  const buf = Buffer.allocUnsafe(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    // xorshift32
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

export async function startFixture(options: FixtureOptions): Promise<Fixture> {
  const requests: Fixture['requests'] = [];
  let rateLimited = 0;

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const rangeHeader = req.headers.range;
    requests.push({ range: rangeHeader, method: req.method ?? 'GET' });

    const body = options.body;
    const total = options.lieContentLength ?? body.length;

    if (options.etag) res.setHeader('ETag', options.etag);
    if (options.lastModified) res.setHeader('Last-Modified', options.lastModified);
    if (options.contentDisposition) {
      res.setHeader('Content-Disposition', options.contentDisposition);
    }
    res.setHeader('Content-Type', options.contentType ?? 'application/octet-stream');

    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', String(total));
      if (!options.noRanges) res.setHeader('Accept-Ranges', 'bytes');
      res.writeHead(200);
      res.end();
      return;
    }

    // Rate-limit the first N *ranged* requests, so the probe still succeeds and
    // we exercise backoff in the workers rather than at startup.
    if (rangeHeader && options.rateLimitFirst && rateLimited < options.rateLimitFirst) {
      rateLimited++;
      if (options.retryAfter) res.setHeader('Retry-After', options.retryAfter);
      res.writeHead(429);
      res.end('slow down');
      return;
    }

    if (options.noRanges || !rangeHeader) {
      res.setHeader('Content-Length', String(total));
      res.writeHead(200);
      await writeBody(res, body, options, 0);
      return;
    }

    const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (!m) {
      res.writeHead(416);
      res.end();
      return;
    }

    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : body.length - 1;
    if (start >= body.length) {
      res.setHeader('Content-Range', `bytes */${body.length}`);
      res.writeHead(416);
      res.end();
      return;
    }

    const slice = body.subarray(start, Math.min(end + 1, body.length));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Range', `bytes ${start}-${start + slice.length - 1}/${total}`);
    res.setHeader('Content-Length', String(slice.length));
    res.writeHead(206);
    await writeBody(res, slice, options, start);
  };

  const server = createServer((req, res) => {
    void handler(req, res).catch(() => res.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/file.bin`,
    server,
    requests,
    options,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function writeBody(
  res: ServerResponse,
  data: Buffer,
  options: FixtureOptions,
  absoluteStart: number,
): Promise<void> {
  const slow = options.slowRange;
  const isSlow = slow !== undefined && absoluteStart >= slow.from && absoluteStart <= slow.to;

  // Small chunks when throttling so the engine sees a genuinely slow trickle
  // rather than one big stall.
  const chunkSize = isSlow ? Math.max(1, Math.floor(slow.bps / 20)) : 64 * 1024;
  let sent = 0;

  while (sent < data.length) {
    if (options.dropAfterBytes !== undefined && sent >= options.dropAfterBytes) {
      res.destroy();
      return;
    }

    const chunk = data.subarray(sent, sent + chunkSize);
    const ok = res.write(chunk);
    sent += chunk.length;

    if (!ok) await new Promise<void>((r) => res.once('drain', () => r()));
    if (isSlow) await new Promise<void>((r) => setTimeout(r, 50));
  }
  res.end();
}
