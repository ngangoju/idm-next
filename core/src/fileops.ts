/**
 * Every change this app makes to a user's disk goes through here.
 *
 * Three rules, enforced rather than hoped for:
 *
 * 1. A finished file is never overwritten. `fs.rename` replaces an existing
 *    destination on macOS and on Windows alike, so it is not used to put a
 *    file in place. `link` refuses an existing name (EEXIST), which makes
 *    "claim this name" and "put the file there" one atomic step.
 * 2. Only our own working files can be deleted — part files, journals,
 *    staging directories. A path that is not one of those is refused, so no
 *    bug anywhere can delete something the user owns.
 * 3. Every operation is logged, with the download that did it. If a file ever
 *    goes missing, the log says what happened to it.
 */
import { link, unlink, copyFile, rename, rm, constants } from 'node:fs/promises';
import { extname } from 'node:path';

export interface FileOp {
  op: 'reserve' | 'move' | 'remove' | 'replace';
  path: string;
  to?: string;
  /** The download responsible, when there is one. */
  owner?: string;
  /** How a move was done: 'link' normally, 'copy' where links are unsupported. */
  via?: 'link' | 'copy';
  at: string;
}

let logger: ((op: FileOp) => void) | null = null;

/** Where operations are recorded. The app points this at a log file. */
export function setFileOpLogger(fn: ((op: FileOp) => void) | null): void {
  logger = fn;
}

export function logFileOp(op: Omit<FileOp, 'at'>): void {
  try {
    logger?.({ ...op, at: new Date().toISOString() });
  } catch {
    // Logging must never be the reason a download fails.
  }
}

/** Names of files this app creates for its own use while downloading. */
const WORKING_FILE = [/\.part$/, /\.idmpart\.json$/, /\.idmpart\.json\.tmp$/, /\.remux\.mp4$/];

export function isWorkingFile(path: string): boolean {
  if (WORKING_FILE.some((re) => re.test(path))) return true;
  // A staging directory, or anything inside one.
  return path.split(/[\\/]/).some((segment) => segment.startsWith('.idm-staging-'));
}

/** Seams for tests that need a filesystem without hard links, or a locked file. */
export const fsOps = { link, unlink, copyFile, rename, rm };

/**
 * Put `from` at `to`, or at `to (1)`, `to (2)`… if the name is taken, and
 * return where it went. Never replaces anything.
 */
export async function moveNoClobber(from: string, to: string, owner?: string): Promise<string> {
  const ext = extname(to);
  const stem = ext ? to.slice(0, -ext.length) : to;

  for (let i = 0; i < 10_000; i++) {
    const candidate = i === 0 ? to : `${stem} (${i})${ext}`;
    try {
      const via = await placeExclusive(from, candidate);
      logFileOp({ op: 'move', path: from, to: candidate, owner, via });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error(`No free filename near ${to}`);
}

/**
 * Errors `link` gives when the filesystem cannot make a hard link at all —
 * FAT and exFAT drives, some network shares, or across devices. Copying
 * exclusively is the fallback; it is slower but has the same guarantee.
 */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EINVAL', 'EACCES']);

async function placeExclusive(from: string, to: string): Promise<'link' | 'copy'> {
  let via: 'link' | 'copy' = 'link';
  try {
    await fsOps.link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (!NO_HARD_LINKS.has(code)) throw err; // EEXIST included: the name is taken.
    await fsOps.copyFile(from, to, constants.COPYFILE_EXCL);
    via = 'copy';
  }
  // The file is safely in place under its new name; the old one is a leftover.
  await retryWhileBusy(() => fsOps.unlink(from));
  return via;
}

/** Delete one of our own working files. Anything else is refused. */
export async function removeWorkingFile(path: string, owner?: string): Promise<void> {
  if (!isWorkingFile(path)) {
    throw new Error(`Refusing to delete ${path}: it is not one of IDM-Next's working files`);
  }
  await retryWhileBusy(() => fsOps.rm(path, { recursive: true, force: true }));
  logFileOp({ op: 'remove', path, owner });
}

/**
 * Replace one working file with another — a journal with its new version, a
 * staged download with its remuxed copy. Both ends must be ours.
 */
export async function replaceWorkingFile(from: string, to: string, owner?: string): Promise<void> {
  if (!isWorkingFile(from) || !isWorkingFile(to)) {
    throw new Error(`Refusing to replace ${to}: only working files may be replaced`);
  }
  await retryWhileBusy(() => fsOps.rename(from, to));
  // Journals are rewritten every second; logging each would drown the log.
  if (!/\.idmpart\.json$/.test(to)) logFileOp({ op: 'replace', path: from, to, owner });
}

/**
 * Windows locks a file while antivirus or the search indexer reads it, which
 * is often right after it is written. Those locks last milliseconds to a
 * second or two; failing on the first one fails a finished download.
 */
const BUSY = new Set(['EBUSY', 'EPERM', 'EACCES']);

export async function retryWhileBusy<T>(fn: () => Promise<T>, attempts = 8): Promise<T> {
  let delay = 25;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!BUSY.has(code) || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 800);
    }
  }
}
