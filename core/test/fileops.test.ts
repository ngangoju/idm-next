/**
 * The file-safety rules, tested directly.
 *
 * Two bugs already damaged finished files (a shared .part; a journal left
 * under the wrong name). These rules make that class impossible rather than
 * fixing instances of it, so each rule is checked here on its own.
 */
import { test, describe, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import {
  moveNoClobber,
  removeWorkingFile,
  replaceWorkingFile,
  isWorkingFile,
  retryWhileBusy,
  setFileOpLogger,
  fsOps,
  type FileOp,
} from '../src/fileops.ts';

const dirs: string[] = [];
const real = { ...fsOps };

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'idm-fileops-'));
  dirs.push(d);
  return d;
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

afterEach(() => {
  Object.assign(fsOps, real);
  setFileOpLogger(null);
});

after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('moveNoClobber', () => {
  test('puts the file in place and removes the part', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'movie.mp4.part'), 'new');
    const to = await moveNoClobber(join(dir, 'movie.mp4.part'), join(dir, 'movie.mp4'));
    assert.equal(basename(to), 'movie.mp4');
    assert.equal(await readFile(to, 'utf8'), 'new');
    assert.deepEqual(await readdir(dir), ['movie.mp4']);
  });

  test('never replaces a file that already has the name', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'movie.mp4'), 'the user’s file');
    await writeFile(join(dir, 'movie.mp4.part'), 'new');

    const to = await moveNoClobber(join(dir, 'movie.mp4.part'), join(dir, 'movie.mp4'));

    assert.equal(basename(to), 'movie (1).mp4');
    assert.equal(await readFile(join(dir, 'movie.mp4'), 'utf8'), 'the user’s file');
    assert.equal(await readFile(to, 'utf8'), 'new');
  });

  test('keeps counting past names that are taken', async () => {
    const dir = await tempDir();
    for (const n of ['a.bin', 'a (1).bin', 'a (2).bin']) await writeFile(join(dir, n), n);
    await writeFile(join(dir, 'a.bin.part'), 'new');
    const to = await moveNoClobber(join(dir, 'a.bin.part'), join(dir, 'a.bin'));
    assert.equal(basename(to), 'a (3).bin');
    for (const n of ['a.bin', 'a (1).bin', 'a (2).bin']) {
      assert.equal(await readFile(join(dir, n), 'utf8'), n);
    }
  });

  test('a name differing only in case does not replace the file either', async () => {
    // macOS and Windows filesystems are case-insensitive by default: a
    // rename to "movie.mp4" would replace "Movie.mp4". Whatever this disk
    // is, the original must survive.
    const dir = await tempDir();
    await writeFile(join(dir, 'Movie.mp4'), 'original');
    await writeFile(join(dir, 'x.part'), 'new');
    const to = await moveNoClobber(join(dir, 'x.part'), join(dir, 'movie.mp4'));
    assert.equal(await readFile(join(dir, 'Movie.mp4'), 'utf8'), 'original');
    assert.equal(await readFile(to, 'utf8'), 'new');
  });

  test('on a filesystem without hard links, copies — with the same guarantee', async () => {
    // FAT/exFAT USB drives and some network shares cannot link.
    fsOps.link = async () => {
      throw errno('ENOTSUP');
    };
    const ops: FileOp[] = [];
    setFileOpLogger((op) => ops.push(op));

    const dir = await tempDir();
    await writeFile(join(dir, 'movie.mp4'), 'the user’s file');
    await writeFile(join(dir, 'movie.mp4.part'), 'new');
    const to = await moveNoClobber(join(dir, 'movie.mp4.part'), join(dir, 'movie.mp4'));

    assert.equal(basename(to), 'movie (1).mp4');
    assert.equal(await readFile(join(dir, 'movie.mp4'), 'utf8'), 'the user’s file');
    assert.equal(await readFile(to, 'utf8'), 'new');
    assert.equal(await exists(join(dir, 'movie.mp4.part')), false);
    assert.equal(ops.at(-1)?.via, 'copy');
  });

  test('waits out a file briefly locked by antivirus', async () => {
    // Windows: Defender and the indexer lock a freshly written file for a
    // moment. The first failed unlink must not fail a finished download.
    let failures = 2;
    fsOps.unlink = async (p) => {
      if (failures-- > 0) throw errno('EBUSY');
      return real.unlink(p);
    };
    const dir = await tempDir();
    await writeFile(join(dir, 'f.part'), 'x');
    const to = await moveNoClobber(join(dir, 'f.part'), join(dir, 'f'));
    assert.equal(await readFile(to, 'utf8'), 'x');
    assert.equal(await exists(join(dir, 'f.part')), false);
  });

  test('is logged, with the download responsible', async () => {
    const ops: FileOp[] = [];
    setFileOpLogger((op) => ops.push(op));
    const dir = await tempDir();
    await writeFile(join(dir, 'f.part'), 'x');
    await moveNoClobber(join(dir, 'f.part'), join(dir, 'f'), 'download-42');
    assert.equal(ops.length, 1);
    assert.equal(ops[0]!.op, 'move');
    assert.equal(ops[0]!.owner, 'download-42');
    assert.equal(ops[0]!.via, 'link');
    assert.ok(ops[0]!.at);
  });
});

describe('removeWorkingFile', () => {
  test('refuses anything that is not one of our working files', async () => {
    const dir = await tempDir();
    for (const name of ['movie.mp4', 'report.pdf', 'notes.part.txt']) {
      await writeFile(join(dir, name), 'keep me');
      await assert.rejects(removeWorkingFile(join(dir, name)), /Refusing to delete/);
      assert.equal(await readFile(join(dir, name), 'utf8'), 'keep me');
    }
  });

  test('removes part files, journals and staging directories', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'a.mp4.part'), '');
    await writeFile(join(dir, 'a.mp4.idmpart.json'), '{}');
    await mkdir(join(dir, '.idm-staging-abc'));
    await writeFile(join(dir, '.idm-staging-abc', 'video.f137.mp4'), '');

    await removeWorkingFile(join(dir, 'a.mp4.part'));
    await removeWorkingFile(join(dir, 'a.mp4.idmpart.json'));
    await removeWorkingFile(join(dir, '.idm-staging-abc'));
    assert.deepEqual(await readdir(dir), []);
  });

  test('a missing file is not an error', async () => {
    const dir = await tempDir();
    await removeWorkingFile(join(dir, 'gone.part'));
  });
});

describe('replaceWorkingFile', () => {
  test('refuses to replace a file that is not ours', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'movie.mp4'), 'keep me');
    await writeFile(join(dir, 'x.idmpart.json.tmp'), '{}');
    await assert.rejects(
      replaceWorkingFile(join(dir, 'x.idmpart.json.tmp'), join(dir, 'movie.mp4')),
      /Refusing to replace/,
    );
    assert.equal(await readFile(join(dir, 'movie.mp4'), 'utf8'), 'keep me');
  });
});

describe('isWorkingFile', () => {
  test('knows our files from the user’s', () => {
    for (const p of [
      '/d/a.mp4.part',
      '/d/a.mp4.idmpart.json',
      '/d/a.mp4.idmpart.json.tmp',
      '/d/.idm-staging-1/clip.mp4',
      'C:\\d\\.idm-staging-1\\clip.mp4',
      '/d/.idm-staging-1/clip.mp4.remux.mp4',
    ]) {
      assert.equal(isWorkingFile(p), true, p);
    }
    for (const p of ['/d/a.mp4', '/d/part', '/d/a.partial', '/d/idm-staging/a.mp4', '/d/a.json']) {
      assert.equal(isWorkingFile(p), false, p);
    }
  });
});

describe('retryWhileBusy', () => {
  test('retries a busy file, then succeeds', async () => {
    let n = 0;
    const out = await retryWhileBusy(async () => {
      if (++n < 3) throw errno('EBUSY');
      return 'ok';
    });
    assert.equal(out, 'ok');
    assert.equal(n, 3);
  });

  test('does not retry a real error', async () => {
    let n = 0;
    await assert.rejects(
      retryWhileBusy(async () => {
        n++;
        throw errno('ENOSPC');
      }),
      /ENOSPC/,
    );
    assert.equal(n, 1);
  });

  test('gives up eventually', async () => {
    let n = 0;
    await assert.rejects(
      retryWhileBusy(async () => {
        n++;
        throw errno('EPERM');
      }, 3),
    );
    assert.equal(n, 3);
  });
});
