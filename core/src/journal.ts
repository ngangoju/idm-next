/**
 * Crash-safe resume state.
 *
 * Written next to the .part file, atomically (temp + rename) so a crash during
 * the write leaves the previous good journal intact rather than a truncated one.
 * Debounced, because fsyncing on every chunk would dominate the transfer.
 */
import { writeFile, readFile, access, mkdir, open } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { logFileOp, removeWorkingFile, replaceWorkingFile } from './fileops.ts';
import type { Journal, SegmentState } from './types.ts';

const DEBOUNCE_MS = 1000;

export function journalPath(filePath: string): string {
  return `${filePath}.idmpart.json`;
}

export function partPath(filePath: string): string {
  return `${filePath}.part`;
}

export class JournalWriter {
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  private readonly path: string;
  private state: Journal;

  private readonly owner: string | undefined;

  constructor(path: string, state: Journal, owner?: string) {
    this.path = path;
    this.state = state;
    this.owner = owner;
  }

  /** Record new segment positions; the write itself is debounced. */
  update(segments: readonly SegmentState[]): void {
    this.state = { ...this.state, segments: segments.map((s) => ({ ...s })) };
    this.dirty = true;
    this.timer ??= setTimeout(() => void this.flush(), DEBOUNCE_MS);
  }

  /** Force the pending write out now — on pause, completion, or shutdown. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.writing;
    this.dirty = false;

    // Serialize writes so two flushes cannot interleave their renames.
    this.writing = this.writing.then(async () => {
      const tmp = `${this.path}.tmp`;
      await writeFile(tmp, JSON.stringify(this.state), 'utf8');
      await replaceWorkingFile(tmp, this.path, this.owner);
    });
    return this.writing;
  }

  async remove(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = false;
    await this.writing.catch(() => {});
    await removeWorkingFile(this.path, this.owner).catch(() => {});
  }
}

/** Read an existing journal, or null when there is nothing usable to resume. */
export async function readJournal(path: string): Promise<Journal | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isJournal(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validate the shape before trusting it — this file is on disk between runs and
 * a malformed one must degrade to "start over", never to a bad seek offset.
 */
function isJournal(v: unknown): v is Journal {
  if (typeof v !== 'object' || v === null) return false;
  const j = v as Partial<Journal>;
  if (j.version !== 1) return false;
  if (typeof j.url !== 'string') return false;
  if (typeof j.totalSize !== 'number' || !Number.isSafeInteger(j.totalSize)) return false;
  if (!Array.isArray(j.segments) || j.segments.length === 0) return false;

  return j.segments.every((s) => {
    if (typeof s !== 'object' || s === null) return false;
    const seg = s as Partial<SegmentState>;
    return (
      Number.isSafeInteger(seg.start) &&
      Number.isSafeInteger(seg.end) &&
      Number.isSafeInteger(seg.cursor) &&
      seg.start! >= 0 &&
      seg.end! >= seg.start! - 1 &&
      seg.cursor! >= seg.start! &&
      seg.cursor! <= seg.end! + 1
    );
  });
}

/**
 * Claim a path for a download that is about to start from nothing.
 *
 * A download in progress has only its `.part` and journal on disk, so checking
 * the finished name alone let a second download of "video.mp4" pick the same
 * path and write into the first one's part file: whichever finished first
 * renamed it, the other died with ENOENT, and two different files sharing a
 * name would have been merged into one. So the sidecars take the name too,
 * and the part is created with O_EXCL — two downloads racing for one name
 * cannot both win.
 */
export async function reserveTarget(target: string, owner?: string): Promise<string> {
  const ext = extname(target);
  const stem = ext ? target.slice(0, -ext.length) : target;
  await mkdir(dirname(target), { recursive: true });

  for (let i = 0; i < 10_000; i++) {
    const candidate = i === 0 ? target : `${stem} (${i})${ext}`;
    if ((await taken(candidate)) || (await taken(journalPath(candidate)))) continue;
    try {
      await (await open(partPath(candidate), 'wx')).close();
      logFileOp({ op: 'reserve', path: partPath(candidate), owner });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`No free filename near ${target}`);
}

async function taken(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
