/**
 * The file-operations log.
 *
 * Every file IDM-Next creates, moves or deletes is written here, one JSON line
 * each, with the download responsible. It exists because a finished file once
 * went missing during testing and nothing could say what removed it; with
 * this, the answer is a grep away.
 *
 * Appends are synchronous on purpose: operations are few (a handful per
 * download), and a line that survives a crash is worth more than a
 * microsecond.
 */
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FileOp } from '@idm-next/core';

export interface OpLogOptions {
  dir: string;
  name?: string;
  /** Rotate once the current file passes this size. */
  maxBytes?: number;
  /** How many rotated files to keep beside the current one. */
  keep?: number;
}

export function createOpLog({
  dir,
  name = 'fileops.log',
  maxBytes = 1024 * 1024,
  keep = 3,
}: OpLogOptions): (op: FileOp) => void {
  const current = join(dir, name);
  mkdirSync(dir, { recursive: true });

  const rotate = (): void => {
    rmSync(`${current}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      try {
        renameSync(`${current}.${i}`, `${current}.${i + 1}`);
      } catch {
        // That generation does not exist yet.
      }
    }
    renameSync(current, `${current}.1`);
  };

  return (op) => {
    try {
      const size = statSync(current, { throwIfNoEntry: false })?.size ?? 0;
      if (size >= maxBytes) rotate();
    } catch {
      // A failed rotation just means a longer file.
    }
    appendFileSync(current, `${JSON.stringify(op)}\n`);
  };
}
