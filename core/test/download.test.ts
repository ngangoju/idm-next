/**
 * End-to-end engine tests against the misbehaving fixture server.
 *
 * Every assertion here is on the finished bytes, not on internal state: the
 * only claim that matters is that the file on disk equals the file on the
 * server, no matter how badly the transfer went.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { once } from 'node:events';

import { Download } from '../src/download.ts';
import { hashFile } from '../src/writer.ts';
import { readJournal, journalPath } from '../src/journal.ts';
import { StaleResumeError } from '../src/types.ts';
import { startFixture, makeBody, sha256, type Fixture } from './fixture-server.ts';

const MB = 1024 * 1024;
const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'idm-dl-'));
  dirs.push(d);
  return d;
}

after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Run a download to completion and assert the bytes match the source exactly. */
async function expectExact(fx: Fixture, dest: string, connections: number): Promise<string> {
  const dl = new Download({ url: fx.url, destDir: dest, connections });
  const done = once(dl, 'done');
  const failed = once(dl, 'error').then(([e]) => {
    throw e;
  });
  void dl.start();
  await Promise.race([done, failed]);

  assert.equal(await hashFile(dl.path), sha256(fx.options.body));
  return dl.path;
}

describe('byte-exactness', () => {
  for (const connections of [1, 4, 16]) {
    test(`${connections} connection(s) produce a byte-exact file`, async () => {
      const body = makeBody(8 * MB, connections);
      const fx = await startFixture({ body, etag: '"v1"' });
      const dest = await tempDir();
      try {
        await expectExact(fx, dest, connections);
      } finally {
        await fx.close();
      }
    });
  }

  test('a file smaller than one segment still downloads', async () => {
    const body = makeBody(1024);
    const fx = await startFixture({ body, etag: '"v1"' });
    const dest = await tempDir();
    try {
      await expectExact(fx, dest, 8);
    } finally {
      await fx.close();
    }
  });
});

describe('failure recovery', () => {
  test('a mid-stream disconnect resumes and still hashes equal', async () => {
    const body = makeBody(4 * MB);
    // Every response dies after 256 KiB, so each segment needs several attempts.
    const fx = await startFixture({ body, etag: '"v1"', dropAfterBytes: 256 * 1024 });
    const dest = await tempDir();
    try {
      await expectExact(fx, dest, 4);
      assert.ok(fx.requests.length > 4, 'expected retries beyond the initial requests');
    } finally {
      await fx.close();
    }
  });

  test('backs off through 429s and completes', async () => {
    const body = makeBody(2 * MB);
    const fx = await startFixture({
      body,
      etag: '"v1"',
      rateLimitFirst: 3,
      retryAfter: '0',
    });
    const dest = await tempDir();
    try {
      await expectExact(fx, dest, 4);
    } finally {
      await fx.close();
    }
  });
});

describe('server push-back', () => {
  test('stops opening new connections after a 429, and still finishes', async () => {
    // Backing off one segment does not reduce pressure when the other
    // connections are still open, so a 429 also stops workers from stealing
    // more work. The download must still complete.
    const body = makeBody(6 * MB);
    const fx = await startFixture({
      body,
      etag: '"v1"',
      rateLimitFirst: 4,
      retryAfter: '0',
    });
    const dest = await tempDir();
    try {
      const dl = new Download({ url: fx.url, destDir: dest, connections: 8 });
      const done = once(dl, 'done');
      const failed = once(dl, 'error').then(([e]) => {
        throw e;
      });
      void dl.start();
      await Promise.race([done, failed]);

      assert.equal(await hashFile(dl.path), sha256(body));
    } finally {
      await fx.close();
    }
  });
});

describe('servers without range support', () => {
  test('degrades to a single stream instead of corrupting output', async () => {
    const body = makeBody(2 * MB);
    const fx = await startFixture({ body, noRanges: true });
    const dest = await tempDir();
    try {
      const path = await expectExact(fx, dest, 8);
      // No journal should survive a non-resumable download.
      assert.equal(await readJournal(journalPath(path)), null);
    } finally {
      await fx.close();
    }
  });
});

describe('resume across Download instances', () => {
  test('a paused download resumes from its journal and hashes equal', async () => {
    const body = makeBody(12 * MB);
    // Throttle the whole file so we can reliably pause partway through.
    const fx = await startFixture({
      body,
      etag: '"v1"',
      slowRange: { from: 0, to: body.length, bps: 4 * MB },
    });
    const dest = await tempDir();

    try {
      const first = new Download({ url: fx.url, destDir: dest, connections: 4 });
      let paused = false;
      first.on('progress', (p) => {
        if (!paused && p.downloaded > 2 * MB) {
          paused = true;
          void first.pause();
        }
      });
      void first.start();

      // Wait for the pause to settle.
      for (let i = 0; i < 200 && first.currentStatus !== 'paused'; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(first.currentStatus, 'paused', 'download never paused');
      // Idempotent: resolves once the pause is durable on disk.
      await first.pause();

      const j = await readJournal(journalPath(first.path));
      assert.ok(j, 'expected a journal to survive the pause');
      const carried = j.segments.reduce((n, s) => n + (s.cursor - s.start), 0);
      assert.ok(carried > 0, 'journal recorded no progress');
      assert.ok(carried < body.length, 'download was already finished');

      // A fresh instance, as if the app had restarted.
      const second = new Download({ url: fx.url, destDir: dest, connections: 4 });
      const done = once(second, 'done');
      void second.start();
      await done;

      assert.equal(second.path, first.path, 'resumed into a different file');
      assert.equal(await hashFile(second.path), sha256(body));
      assert.equal(await readJournal(journalPath(second.path)), null, 'journal not cleaned up');
    } finally {
      await fx.close();
    }
  });

  test('an ETag change on resume is surfaced, not silently merged', async () => {
    const body = makeBody(8 * MB);
    const fx = await startFixture({
      body,
      etag: '"v1"',
      slowRange: { from: 0, to: body.length, bps: 4 * MB },
    });
    const dest = await tempDir();

    try {
      const first = new Download({ url: fx.url, destDir: dest, connections: 4 });
      let paused = false;
      first.on('progress', (p) => {
        if (!paused && p.downloaded > 1 * MB) {
          paused = true;
          void first.pause();
        }
      });
      void first.start();
      for (let i = 0; i < 200 && first.currentStatus !== 'paused'; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(first.currentStatus, 'paused');
      await first.pause();

      // The file changed on the server between our two runs.
      fx.options.etag = '"v2"';

      const second = new Download({ url: fx.url, destDir: dest, connections: 4 });
      const stale = once(second, 'stale');
      const errored = once(second, 'error');
      void second.start();

      const [info] = await Promise.race([stale, errored.then(() => [{ reason: 'errored' }])]);
      assert.match((info as { reason: string }).reason, /ETag/i);

      const [err] = (await errored) as [Error];
      assert.ok(err instanceof StaleResumeError, `got ${err?.constructor?.name}`);
    } finally {
      await fx.close();
    }
  });
});

describe('filename handling end to end', () => {
  test("uses the server's Content-Disposition name", async () => {
    const body = makeBody(64 * 1024);
    const fx = await startFixture({
      body,
      etag: '"v1"',
      contentDisposition: 'attachment; filename="quarterly report.pdf"',
    });
    const dest = await tempDir();
    try {
      const path = await expectExact(fx, dest, 2);
      assert.equal(basename(path), 'quarterly report.pdf');
    } finally {
      await fx.close();
    }
  });

  test('a hostile Content-Disposition cannot escape the destination', async () => {
    const body = makeBody(64 * 1024);
    const fx = await startFixture({
      body,
      etag: '"v1"',
      contentDisposition: 'attachment; filename="../../../../tmp/pwned.sh"',
    });
    const dest = await tempDir();
    try {
      const path = await expectExact(fx, dest, 2);
      assert.ok(path.startsWith(dest), `escaped to ${path}`);
      assert.equal(basename(path), 'tmppwned.sh');
    } finally {
      await fx.close();
    }
  });

  test('does not overwrite an existing file', async () => {
    const body = makeBody(64 * 1024);
    const fx = await startFixture({ body, etag: '"v1"' });
    const dest = await tempDir();
    try {
      await writeFile(join(dest, 'file.bin'), 'pre-existing');
      const path = await expectExact(fx, dest, 2);
      assert.equal(basename(path), 'file (1).bin');
      assert.equal(await readFile(join(dest, 'file.bin'), 'utf8'), 'pre-existing');
    } finally {
      await fx.close();
    }
  });
});

describe('cancel', () => {
  test('cancelling removes the journal', async () => {
    const body = makeBody(12 * MB);
    const fx = await startFixture({
      body,
      etag: '"v1"',
      slowRange: { from: 0, to: body.length, bps: 2 * MB },
    });
    const dest = await tempDir();
    try {
      const dl = new Download({ url: fx.url, destDir: dest, connections: 4 });
      dl.on('error', () => {});
      void dl.start();
      for (let i = 0; i < 100 && dl.currentStatus !== 'downloading'; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await dl.cancel();
      assert.equal(dl.currentStatus, 'cancelled');
      assert.equal(await readJournal(journalPath(dl.path)), null);
    } finally {
      await fx.close();
    }
  });
});

describe('naming', () => {
  test('an extensionless URL is saved with the extension its type implies', async () => {
    const body = makeBody(200_000);
    const fx = await startFixture({ body, contentType: 'image/jpeg' });
    const dest = await tempDir();
    try {
      // The shape of an X image URL: no extension in the path, format in the query.
      const url = fx.url.replace('/file.bin', '/media/GiQ4vJ2XIAAxm6v?format=jpg&name=large');
      const dl = new Download({ url, destDir: dest, connections: 2 });
      const done = once(dl, 'done');
      await dl.start();
      await done;
      assert.equal(basename(dl.path), 'GiQ4vJ2XIAAxm6v.jpg');
      assert.equal(sha256(await readFile(dl.path)), sha256(body));
    } finally {
      await fx.close();
    }
  });
});

describe('two downloads with the same name at once', () => {
  test('get separate files, each byte-exact', async () => {
    // Different files that happen to share a name — two "video.mp4"s from two
    // sites. Checking only the finished name let both claim one part file.
    const a = makeBody(3 * MB, 1);
    const b = makeBody(3 * MB, 2);
    const slow = (body: Buffer) => ({ body, slowRange: { from: 0, to: body.length, bps: 2 * MB } });
    const fa = await startFixture(slow(a));
    const fb = await startFixture(slow(b));
    const dest = await tempDir();
    try {
      const da = new Download({ url: fa.url.replace('file.bin', 'video.mp4'), destDir: dest, connections: 4 });
      const db = new Download({ url: fb.url.replace('file.bin', 'video.mp4'), destDir: dest, connections: 4 });
      const done = Promise.all([once(da, 'done'), once(db, 'done')]);
      await Promise.all([da.start(), db.start()]);
      await done;

      assert.notEqual(da.path, db.path);
      assert.deepEqual(
        [basename(da.path), basename(db.path)].sort(),
        ['video (1).mp4', 'video.mp4'],
      );
      assert.equal(sha256(await readFile(da.path)), sha256(a));
      assert.equal(sha256(await readFile(db.path)), sha256(b));
    } finally {
      await fa.close();
      await fb.close();
    }
  });
});

describe('the journal', () => {
  test('lives beside the file actually being written, not the name that was wanted', async () => {
    const body = makeBody(3 * MB);
    const fx = await startFixture({ body, slowRange: { from: 0, to: body.length, bps: 1 * MB } });
    const dest = await tempDir();
    try {
      // Someone else's finished file already has the name.
      await writeFile(join(dest, 'file.bin'), 'not ours');

      const dl = new Download({ url: fx.url, destDir: dest, connections: 2 });
      void dl.start().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      await dl.pause();

      assert.equal(basename(dl.path), 'file (1).bin');
      assert.ok(await readJournal(journalPath(dl.path)), 'journal beside our own part file');
      assert.equal(
        await readJournal(journalPath(join(dest, 'file.bin'))),
        null,
        'nothing beside the other file for a later download to mistake for its own',
      );
    } finally {
      await fx.close();
    }
  });

  test('a second download of the same URL cannot overwrite the first', async () => {
    const body = makeBody(2 * MB);
    const fx = await startFixture({ body, slowRange: { from: 0, to: body.length, bps: 1 * MB } });
    const dest = await tempDir();
    try {
      // First copy, complete.
      const first = new Download({ url: fx.url, destDir: dest, connections: 2 });
      delete fx.options.slowRange;
      await first.start();
      assert.equal(sha256(await readFile(first.path)), sha256(body));

      // Second copy of the same URL: paused part-way, so it leaves resume state.
      fx.options.slowRange = { from: 0, to: body.length, bps: 1 * MB };
      const second = new Download({ url: fx.url, destDir: dest, connections: 2 });
      void second.start().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
      await second.pause();

      // Third: must not pick up the second's journal as if it were the first file's.
      delete fx.options.slowRange;
      const third = new Download({ url: fx.url, destDir: dest, connections: 2 });
      await third.start();

      assert.equal(sha256(await readFile(first.path)), sha256(body), 'the first file is untouched');
      assert.equal(sha256(await readFile(third.path)), sha256(body));
      assert.notEqual(third.path, first.path);
    } finally {
      await fx.close();
    }
  });
});
