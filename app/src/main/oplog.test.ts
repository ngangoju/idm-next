import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOpLog } from './oplog.ts';
import type { FileOp } from '@idm-next/core';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const op = (n: number): FileOp => ({
  op: 'move',
  path: `/d/f${n}.part`,
  to: `/d/f${n}`,
  owner: 'dl-1',
  at: '2026-09-28T00:00:00.000Z',
});

describe('the file-operations log', () => {
  test('writes one JSON line per operation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idm-oplog-'));
    dirs.push(dir);
    const log = createOpLog({ dir });
    log(op(1));
    log(op(2));
    const lines = (await readFile(join(dir, 'fileops.log'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[1]!), op(2));
  });

  test('rotates at the size limit, not before', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idm-oplog-'));
    dirs.push(dir);
    const line = JSON.stringify(op(1)).length + 1;
    const log = createOpLog({ dir, maxBytes: line * 3, keep: 2 });

    for (let i = 0; i < 3; i++) log(op(i));
    assert.deepEqual(await readdir(dir), ['fileops.log'], 'three lines fit');

    log(op(3));
    assert.deepEqual((await readdir(dir)).sort(), ['fileops.log', 'fileops.log.1']);
  });

  test('keeps only as many old files as asked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idm-oplog-'));
    dirs.push(dir);
    const line = JSON.stringify(op(1)).length + 1;
    const log = createOpLog({ dir, maxBytes: line, keep: 2 });
    for (let i = 0; i < 10; i++) log(op(i));
    assert.deepEqual((await readdir(dir)).sort(), [
      'fileops.log',
      'fileops.log.1',
      'fileops.log.2',
    ]);
    // The newest entry is in the current file.
    assert.match(await readFile(join(dir, 'fileops.log'), 'utf8'), /f9\.part/);
  });
});
