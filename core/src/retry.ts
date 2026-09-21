/** Backoff shared by every segment worker. */

export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 10, baseMs: 1000, maxMs: 30_000 };

/**
 * Exponential backoff with full jitter. Jitter matters here specifically: all N
 * of our connections fail together when a host rate-limits, and without it they
 * would retry in lockstep and trip the same limit again.
 */
export function backoffMs(attempt: number, policy: RetryPolicy = DEFAULT_RETRY): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

/** Honour Retry-After, which may be seconds or an HTTP date. */
export function parseRetryAfter(header: string | undefined, now = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();

  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;

  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - now);
  return null;
}

/** Status codes where retrying the same range is reasonable. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

export function isRetryableError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNREFUSED' ||
    code === 'EPIPE' ||
    code === 'ENOTFOUND' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    err instanceof Error
  );
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      res();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      rej(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
