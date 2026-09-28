/**
 * Capability detection.
 *
 * A download is only resumable if the server proves it by answering a ranged
 * request with a 206 and a parseable Content-Range. Anything softer than that
 * (an `Accept-Ranges: bytes` header on its own, say) is a claim, not proof, and
 * trusting it is how you end up with a corrupt file.
 */
import { request, Agent, ProxyAgent, interceptors, type Dispatcher } from 'undici';
import { parseContentDisposition, sanitizeFilename } from './filename.ts';
import type { ProbeResult } from './types.ts';

export function makeDispatcher(opts: { proxy?: string; connections?: number }): Dispatcher {
  const shared = {
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 120_000,
    connections: Math.max(1, opts.connections ?? 8),
  };
  const base = opts.proxy ? new ProxyAgent({ uri: opts.proxy, ...shared }) : new Agent(shared);
  // undici 8 moved redirect handling out of request() and into the dispatcher.
  return base.compose(interceptors.redirect({ maxRedirections: 10 }));
}

/** `bytes 0-0/12345` -> 12345. Returns null for `*` or malformed values. */
export function parseContentRangeTotal(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^bytes\s+(?:\d+-\d+|\*)\/(\d+|\*)$/i.exec(header.trim());
  if (!m || m[1] === '*' || m[1] === undefined) return null;
  const total = Number(m[1]);
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

function headerString(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export interface ProbeOptions {
  url: string;
  headers?: Record<string, string>;
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
}

/**
 * Probe with `Range: bytes=0-0`, falling back to HEAD.
 *
 * We use a ranged GET rather than a bare HEAD because plenty of servers answer
 * HEAD with a Content-Length they then fail to honour on a real ranged read.
 */
export async function probe(opts: ProbeOptions): Promise<ProbeResult> {
  const { url, headers = {}, dispatcher, signal } = opts;

  const res = await request(url, {
    method: 'GET',
    headers: { ...headers, range: 'bytes=0-0' },
    dispatcher,
    signal,
  });

  // We only wanted the headers; dumping avoids leaking the connection.
  await res.body.dump();

  const h = res.headers as Record<string, string | string[] | undefined>;
  const contentRangeTotal = parseContentRangeTotal(headerString(h['content-range']) ?? undefined);
  const resumable = res.statusCode === 206 && contentRangeTotal !== null;

  let totalSize: number | null = contentRangeTotal;

  if (!resumable) {
    // Either the server ignored the Range (200 with the whole body) or it
    // errored. Fall back to HEAD purely to learn the size.
    if (res.statusCode === 200) {
      const len = headerString(h['content-length']);
      totalSize = len !== null && /^\d+$/.test(len) ? Number(len) : null;
    } else if (res.statusCode >= 400) {
      const head = await probeHead({ url, headers, dispatcher, signal });
      if (head) return head;
      throw new Error(`Probe failed: HTTP ${res.statusCode}`);
    }
  }

  const disposition = headerString(h['content-disposition']);
  const suggested = parseContentDisposition(disposition);

  return {
    url,
    totalSize,
    resumable,
    contentType: headerString(h['content-type']),
    suggestedName: suggested ? sanitizeFilename(suggested) : null,
    etag: headerString(h['etag']),
    lastModified: headerString(h['last-modified']),
    statusCode: res.statusCode,
  };
}

async function probeHead(opts: ProbeOptions): Promise<ProbeResult | null> {
  try {
    const res = await request(opts.url, {
      method: 'HEAD',
      headers: opts.headers,
      dispatcher: opts.dispatcher,
      signal: opts.signal,
    });
    await res.body.dump();
    if (res.statusCode >= 400) return null;

    const h = res.headers as Record<string, string | string[] | undefined>;
    const len = headerString(h['content-length']);
    const disposition = headerString(h['content-disposition']);
    const suggested = parseContentDisposition(disposition);

    return {
      url: opts.url,
      totalSize: len !== null && /^\d+$/.test(len) ? Number(len) : null,
      resumable: false,
      contentType: headerString(h['content-type']),
      suggestedName: suggested ? sanitizeFilename(suggested) : null,
      etag: headerString(h['etag']),
      lastModified: headerString(h['last-modified']),
      statusCode: res.statusCode,
    };
  } catch {
    return null;
  }
}

/**
 * Decide whether a resumed download still matches the server's copy.
 * ETag is authoritative; Last-Modified is a weaker fallback; size alone is the
 * last resort and only catches gross mismatches.
 */
export function validateResume(
  journal: { etag: string | null; lastModified: string | null; totalSize: number },
  fresh: ProbeResult,
): { ok: true } | { ok: false; reason: string } {
  if (journal.etag && fresh.etag) {
    return journal.etag === fresh.etag ? { ok: true } : { ok: false, reason: 'ETag changed' };
  }
  if (journal.lastModified && fresh.lastModified) {
    return journal.lastModified === fresh.lastModified
      ? { ok: true }
      : { ok: false, reason: 'Last-Modified changed' };
  }
  if (fresh.totalSize !== null && fresh.totalSize !== journal.totalSize) {
    return { ok: false, reason: 'size changed' };
  }
  return { ok: true };
}
