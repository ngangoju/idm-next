/**
 * Segment planning and work stealing.
 *
 * The core idea: a worker that finishes does not exit, it takes half of somebody
 * else's remaining range. The subtlety is *whose*. Choosing the segment with the
 * most bytes left is the obvious rule and it is wrong — a fast worker with 8 MiB
 * left will finish long before a stalled one with 2 MiB, so a bytes-based rule
 * keeps splitting the healthy connection while the stalled segment holds the
 * whole download hostage. We pick by estimated time to completion instead.
 */
import type { SegmentState } from './types.ts';

/** Never create a tail smaller than this; below it, setup cost dominates. */
export const MIN_SPLIT_BYTES = 1024 * 1024;

/** Assumed cost of opening a fresh ranged request, in seconds. */
const SETUP_COST_SECONDS = 0.5;

/** Weight of the newest sample in the rate EWMA. */
const RATE_ALPHA = 0.3;

export interface WorkerSegment extends SegmentState {
  /** Smoothed bytes/sec for this worker; 0 means "no data yet". */
  rate: number;
  /** Whether a worker is currently pulling this range. */
  active: boolean;
}

/** Split [0, totalSize) into `count` roughly equal contiguous segments. */
export function planSegments(totalSize: number, count: number): WorkerSegment[] {
  const n = Math.max(1, Math.min(count, 32));
  if (totalSize <= 0) {
    return [{ start: 0, end: -1, cursor: 0, rate: 0, active: false }];
  }

  // Don't open 16 connections for a 200 KiB file.
  const effective = Math.max(1, Math.min(n, Math.ceil(totalSize / MIN_SPLIT_BYTES)));
  const base = Math.floor(totalSize / effective);

  const segments: WorkerSegment[] = [];
  for (let i = 0; i < effective; i++) {
    const start = i * base;
    const end = i === effective - 1 ? totalSize - 1 : start + base - 1;
    segments.push({ start, end, cursor: start, rate: 0, active: false });
  }
  return segments;
}

export function remainingOf(s: SegmentState): number {
  return Math.max(0, s.end - s.cursor + 1);
}

export function isComplete(s: SegmentState): boolean {
  return s.cursor > s.end;
}

/**
 * Estimated seconds for this segment to finish.
 * A segment with no rate data yet is treated as infinitely slow, which is the
 * right bias: a genuinely stalled connection reports no throughput either, and
 * that is exactly the one we want to relieve.
 */
export function etaOf(s: WorkerSegment): number {
  const remaining = remainingOf(s);
  if (remaining === 0) return 0;
  return s.rate > 0 ? remaining / s.rate : Number.POSITIVE_INFINITY;
}

export class SegmentScheduler {
  readonly segments: WorkerSegment[];

  constructor(segments: WorkerSegment[]) {
    this.segments = segments;
  }

  get downloaded(): number {
    return this.segments.reduce((sum, s) => sum + (s.cursor - s.start), 0);
  }

  get aggregateRate(): number {
    return this.segments.reduce((sum, s) => (s.active ? sum + s.rate : sum), 0);
  }

  /** Fold a fresh throughput sample into a worker's EWMA. */
  recordProgress(index: number, bytes: number, elapsedMs: number): void {
    const seg = this.segments[index];
    if (!seg || elapsedMs <= 0) return;
    const instant = (bytes * 1000) / elapsedMs;
    seg.rate = seg.rate === 0 ? instant : RATE_ALPHA * instant + (1 - RATE_ALPHA) * seg.rate;
  }

  /** Every segment finished. */
  get done(): boolean {
    return this.segments.every(isComplete);
  }

  /**
   * Find the best segment to split and carve its tail off into a new segment.
   * Returns the new segment, or null when splitting would not pay for itself.
   *
   * Mutates the victim's `end` — the victim keeps the head and will stop where
   * the new segment begins.
   */
  steal(): WorkerSegment | null {
    let victim: WorkerSegment | null = null;
    let worstEta = -1;

    for (const s of this.segments) {
      if (!s.active || isComplete(s)) continue;
      // Splitting below the floor produces churn, not throughput.
      if (remainingOf(s) < MIN_SPLIT_BYTES * 2) continue;

      const eta = etaOf(s);
      if (eta > worstEta) {
        worstEta = eta;
        victim = s;
      }
    }

    if (!victim) return null;

    // If the victim will finish in about the time a new connection takes to
    // open, taking half its work makes the download slower, not faster.
    if (worstEta !== Number.POSITIVE_INFINITY && worstEta < SETUP_COST_SECONDS * 2) {
      return null;
    }

    const remaining = remainingOf(victim);
    const tailSize = Math.floor(remaining / 2);
    if (tailSize < MIN_SPLIT_BYTES) return null;

    const splitAt = victim.end - tailSize + 1;
    const tail: WorkerSegment = {
      start: splitAt,
      end: victim.end,
      cursor: splitAt,
      rate: 0,
      active: false,
    };
    victim.end = splitAt - 1;

    this.segments.push(tail);
    return tail;
  }

  /** Strip the bookkeeping fields for the journal / UI. */
  snapshot(): SegmentState[] {
    return this.segments.map(({ start, end, cursor }) => ({ start, end, cursor }));
  }
}
