import type { SegmentState } from '@idm-next/core';

/**
 * The classic IDM per-connection strip.
 *
 * Each segment is drawn at its true position and width in the file, with the
 * filled portion showing how far that connection has got. Because segments are
 * split dynamically by work stealing, the strip visibly changes shape mid
 * download — that is the scheduler working, not a rendering glitch.
 */
export function SegmentStrip({
  segments,
  total,
}: {
  segments: SegmentState[];
  total: number | null;
}): React.ReactElement | null {
  if (!total || total <= 0) return null;

  return (
    <div className="segments" aria-label={`${segments.length} connections`}>
      {segments.map((s, i) => {
        const width = ((s.end - s.start + 1) / total) * 100;
        const left = (s.start / total) * 100;
        const filled = Math.min(
          100,
          Math.max(0, ((s.cursor - s.start) / (s.end - s.start + 1)) * 100),
        );
        return (
          <div
            key={`${s.start}-${i}`}
            className="segment"
            style={{ left: `${left}%`, width: `${width}%` }}
            title={`Connection ${i + 1}: ${filled.toFixed(0)}%`}
          >
            <div className="segment-fill" style={{ width: `${filled}%` }} />
          </div>
        );
      })}
    </div>
  );
}
