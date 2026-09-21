/**
 * Scheduler unit tests.
 *
 * The victim-selection test is the important one: it is the assertion that
 * separates this from a naive fixed-chunk splitter, and it is written so that a
 * bytes-based implementation fails it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SegmentScheduler,
  planSegments,
  etaOf,
  remainingOf,
  MIN_SPLIT_BYTES,
  type WorkerSegment,
} from '../src/segments.ts';

const MB = 1024 * 1024;

function seg(start: number, end: number, cursor: number, rate: number): WorkerSegment {
  return { start, end, cursor, rate, active: true };
}

describe('planSegments', () => {
  test('covers the whole file with no gaps or overlaps', () => {
    const total = 100 * MB;
    const segs = planSegments(total, 8);

    assert.equal(segs[0]!.start, 0);
    assert.equal(segs.at(-1)!.end, total - 1);

    for (let i = 1; i < segs.length; i++) {
      assert.equal(segs[i]!.start, segs[i - 1]!.end + 1, `gap before segment ${i}`);
    }
    const covered = segs.reduce((n, s) => n + (s.end - s.start + 1), 0);
    assert.equal(covered, total);
  });

  test('does not open more connections than the file can feed', () => {
    // 200 KiB across 16 connections would give each ~12 KiB; not worth it.
    const segs = planSegments(200 * 1024, 16);
    assert.equal(segs.length, 1);
  });

  test('clamps to 32 connections', () => {
    const segs = planSegments(500 * MB, 999);
    assert.ok(segs.length <= 32, `got ${segs.length}`);
  });
});

describe('steal: victim selection', () => {
  test('picks the stalled worker, not the one with the most bytes left', () => {
    // This is the case a bytes-based rule gets wrong. The fast segment has four
    // times the bytes remaining, but will finish in 4s; the stalled one needs
    // 2000s. Relieving the fast one would be actively harmful.
    const fast = seg(0, 40 * MB - 1, 0, 10 * MB); // 40 MB left @ 10 MB/s -> 4s
    const stalled = seg(40 * MB, 50 * MB - 1, 40 * MB, 5 * 1024); // 10 MB @ 5 KB/s -> ~2000s

    const sched = new SegmentScheduler([fast, stalled]);

    assert.ok(etaOf(stalled) > etaOf(fast), 'fixture precondition');
    assert.ok(remainingOf(fast) > remainingOf(stalled), 'fixture precondition');

    const tail = sched.steal();
    assert.ok(tail, 'expected a split');

    // The tail must have come out of the stalled segment's range.
    assert.ok(
      tail.start >= 40 * MB,
      `stole from the fast segment (tail.start=${tail.start}) — victim chosen by bytes, not ETA`,
    );
    assert.equal(stalled.end, tail.start - 1);
  });

  test('treats a worker with no throughput data as maximally slow', () => {
    const known = seg(0, 40 * MB - 1, 0, 10 * MB);
    const noData = seg(40 * MB, 60 * MB - 1, 40 * MB, 0);

    assert.equal(etaOf(noData), Number.POSITIVE_INFINITY);

    const tail = new SegmentScheduler([known, noData]).steal();
    assert.ok(tail && tail.start >= 40 * MB);
  });
});

describe('steal: termination', () => {
  test('refuses to split below the minimum tail size', () => {
    const small = seg(0, MIN_SPLIT_BYTES - 1, 0, 1024);
    assert.equal(new SegmentScheduler([small]).steal(), null);
  });

  test('refuses to split a segment that is about to finish anyway', () => {
    // 2.5 MiB left at 50 MB/s finishes in ~0.05s — far less than the cost of
    // opening another connection.
    const nearlyDone = seg(0, 10 * MB - 1, 10 * MB - (MIN_SPLIT_BYTES * 2 + 1), 50 * MB);
    assert.equal(new SegmentScheduler([nearlyDone]).steal(), null);
  });

  test('repeated stealing terminates and stays consistent', () => {
    const sched = new SegmentScheduler(planSegments(64 * MB, 4));
    for (const s of sched.segments) {
      s.active = true;
      s.rate = 1024; // slow enough that ETA never blocks a split
    }

    let splits = 0;
    while (sched.steal() !== null) {
      splits++;
      for (const s of sched.segments) s.active = true;
      assert.ok(splits < 500, 'steal() failed to terminate');
    }

    // Coverage must still be exact after all that mutation.
    const sorted = [...sched.segments].sort((a, b) => a.start - b.start);
    assert.equal(sorted[0]!.start, 0);
    assert.equal(sorted.at(-1)!.end, 64 * MB - 1);
    for (let i = 1; i < sorted.length; i++) {
      assert.equal(sorted[i]!.start, sorted[i - 1]!.end + 1, `gap at ${i}`);
    }
    for (const s of sched.segments) {
      assert.ok(remainingOf(s) >= 0);
    }
  });

  test('ignores inactive and completed segments', () => {
    const done = seg(0, 10 * MB - 1, 10 * MB, 1024);
    const inactive = { ...seg(10 * MB, 30 * MB - 1, 10 * MB, 1024), active: false };
    assert.equal(new SegmentScheduler([done, inactive]).steal(), null);
  });
});

describe('progress accounting', () => {
  test('downloaded sums cursor movement across segments', () => {
    const sched = new SegmentScheduler([
      seg(0, 9, 5, 0),
      seg(10, 19, 20, 0),
    ]);
    assert.equal(sched.downloaded, 5 + 10);
  });

  test('rate EWMA converges toward the observed rate', () => {
    const sched = new SegmentScheduler([seg(0, 100 * MB, 0, 0)]);
    for (let i = 0; i < 40; i++) sched.recordProgress(0, MB, 1000);
    assert.ok(Math.abs(sched.segments[0]!.rate - MB) < MB * 0.05);
  });
});
