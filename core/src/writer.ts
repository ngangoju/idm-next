/**
 * Sparse-file writer.
 *
 * One file, one handle, positional writes. Node's FileHandle.write with an
 * explicit position maps to pwrite(2), which is safe from several workers at
 * once because it does not touch the shared file offset — so N connections can
 * land their ranges concurrently without locking.
 */
import { open, statfs, mkdir, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { InsufficientSpaceError } from './types.ts';
import { moveNoClobber } from './fileops.ts';

/**
 * ftruncate on a sparse filesystem succeeds whether or not the space exists,
 * so the download would otherwise die at 90% with ENOSPC. Check up front.
 */
export async function ensureSpace(dir: string, needed: number): Promise<void> {
  if (needed <= 0) return;
  try {
    const fs = await statfs(dir);
    const available = Number(fs.bavail) * Number(fs.bsize);
    // 64 MiB of headroom so we don't fill the volume completely.
    if (available < needed + 64 * 1024 * 1024) {
      throw new InsufficientSpaceError(needed, available);
    }
  } catch (err) {
    if (err instanceof InsufficientSpaceError) throw err;
    // statfs is unavailable on some mounts; not a reason to refuse the download.
  }
}

export class PartFileWriter {
  private readonly handle: FileHandle;
  readonly partPath: string;

  private constructor(handle: FileHandle, partPath: string) {
    this.handle = handle;
    this.partPath = partPath;
  }

  static async create(partPath: string, totalSize: number): Promise<PartFileWriter> {
    await mkdir(dirname(partPath), { recursive: true });
    // 'a+' would force every write to the end; 'r+' needs the file to exist.
    // Open with 'w+' only when new, so a resume keeps existing bytes.
    let handle: FileHandle;
    try {
      handle = await open(partPath, 'r+');
    } catch {
      handle = await open(partPath, 'w+');
    }

    if (totalSize > 0) {
      const current = await handle.stat();
      if (current.size !== totalSize) {
        // Sparse preallocation: reserves the extent map, writes no blocks.
        await handle.truncate(totalSize);
      }
    }
    return new PartFileWriter(handle, partPath);
  }

  /** Write at an absolute offset. Safe to call concurrently. */
  async writeAt(buffer: Buffer, position: number): Promise<number> {
    const { bytesWritten } = await this.handle.write(buffer, 0, buffer.length, position);
    return bytesWritten;
  }

  async sync(): Promise<void> {
    await this.handle.sync().catch(() => {});
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => {});
  }

  /**
   * Drop the .part suffix once every segment has landed, and say where the
   * file ended up: if something took the name meanwhile, it lands beside it
   * as "name (1)" rather than replacing it.
   */
  async finalize(finalPath: string, owner?: string): Promise<string> {
    await this.sync();
    await this.close();
    return moveNoClobber(this.partPath, finalPath, owner);
  }
}

/**
 * Hash the finished file in one pass.
 *
 * Deliberately not incremental: segments land out of order, so there is no
 * point at which a streaming hash would see the bytes in sequence.
 */
export async function hashFile(
  path: string,
  algorithm: 'md5' | 'sha1' | 'sha256' = 'sha256',
): Promise<string> {
  const hash: Hash = createHash(algorithm);
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
