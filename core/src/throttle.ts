/**
 * Token-bucket rate limiting.
 *
 * Two buckets are consulted per write: one global, one per download. A worker
 * takes from both before it is allowed to write, which gives a global cap and
 * per-download caps from a single mechanism.
 */

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private waiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;

  private rateBps: number;

  /** @param rateBps bytes per second; 0 means unlimited. */
  constructor(rateBps: number) {
    this.rateBps = rateBps;
    this.tokens = rateBps;
    this.lastRefill = Date.now();
  }

  get unlimited(): boolean {
    return this.rateBps <= 0;
  }

  setRate(rateBps: number): void {
    this.rateBps = rateBps;
    // A raised (or removed) cap should take effect immediately, not after the
    // next refill tick.
    if (this.unlimited) this.release();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    // Burst is capped at one second's worth, so a long idle period cannot bank
    // tokens and then blow far past the cap in a single moment.
    this.tokens = Math.min(this.rateBps, this.tokens + elapsed * this.rateBps);
  }

  /**
   * Consume up to `want` bytes, returning how many were granted.
   * Always grants at least 1 byte when tokens exist, so callers make progress.
   */
  tryTake(want: number): number {
    if (this.unlimited) return want;
    this.refill();
    const granted = Math.min(want, Math.floor(this.tokens));
    if (granted > 0) this.tokens -= granted;
    return granted;
  }

  /** Block until at least one byte is available, then take what we can. */
  async take(want: number): Promise<number> {
    if (this.unlimited) return want;

    for (;;) {
      const granted = this.tryTake(want);
      if (granted > 0) return granted;
      await this.waitForTokens();
    }
  }

  private waitForTokens(): Promise<void> {
    return new Promise((res) => {
      this.waiters.push(res);
      this.timer ??= setInterval(() => this.release(), 50);
    });
  }

  private release(): void {
    if (this.waiters.length === 0) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      return;
    }
    const woken = this.waiters;
    this.waiters = [];
    for (const w of woken) w();
  }

  /** Release every waiter and stop the timer; used on shutdown. */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.release();
  }
}

/** A global bucket and a per-download bucket, consulted together. */
export class RateLimiter {
  private readonly global: TokenBucket;
  private readonly local: TokenBucket;

  constructor(global: TokenBucket, local: TokenBucket) {
    this.global = global;
    this.local = local;
  }

  /** Grant is the smaller of what the two buckets allow. */
  async take(want: number): Promise<number> {
    const g = await this.global.take(want);
    const l = await this.local.take(g);
    return Math.max(1, Math.min(g, l));
  }
}
