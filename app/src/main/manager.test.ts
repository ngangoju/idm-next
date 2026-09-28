/**
 * Manager tests: categorization, concurrency, persistence across a restart,
 * and the probe-before-takeover contract the extension depends on.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { once } from 'node:events';

import { Store } from './store.ts';
import { DownloadManager, isIntermediate } from './manager.ts';
import { categoryFor, humanizeError } from '../shared/protocol.ts';
import { startFixture, makeBody, sha256 } from '../../../core/test/fixture-server.ts';
import { hashFile } from '@idm-next/core';

const MB = 1024 * 1024;
const dirs: string[] = [];

async function freshManager(): Promise<{ manager: DownloadManager; dir: string; store: Store }> {
  const dir = await mkdtemp(join(tmpdir(), 'idm-mgr-'));
  dirs.push(dir);
  const store = await Store.open(join(dir, 'state.json'));
  store.update((s) => {
    s.settings.downloadDir = join(dir, 'dl');
  });
  const manager = new DownloadManager(store);
  await manager.init();
  return { manager, dir, store };
}

after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('categorization', () => {
  test('maps extensions to categories', () => {
    assert.equal(categoryFor('movie.mkv'), 'video');
    assert.equal(categoryFor('song.FLAC'), 'audio');
    assert.equal(categoryFor('paper.pdf'), 'documents');
    assert.equal(categoryFor('archive.tar.gz'), 'compressed');
    assert.equal(categoryFor('installer.dmg'), 'compressed');
    assert.equal(categoryFor('tool.exe'), 'programs');
    assert.equal(categoryFor('mystery.qqq'), 'other');
    assert.equal(categoryFor('noextension'), 'other');
  });

  test('files land in their category folder', async () => {
    const { manager, dir } = await freshManager();
    const rec = manager.add({ url: 'https://x.test/clip.mp4', startPaused: true });
    assert.equal(rec.category, 'video');
    assert.equal(rec.destDir, join(dir, 'dl', 'video'));
    await manager.shutdown();
  });
});

describe('naming a page download', () => {
  test('does not call every YouTube video "watch"', async () => {
    // The last path segment of a page URL is not a filename. It also put every
    // video in Other, because "watch" has no extension.
    const { manager } = await freshManager();
    const rec = manager.add({ url: 'https://www.youtube.com/watch?v=abc', startPaused: true });

    assert.notEqual(rec.filename, 'watch');
    assert.match(rec.filename, /youtube\.com/);
    assert.equal(rec.category, 'video');
    assert.equal(rec.useYtdlp, true);
    await manager.shutdown();
  });

  test('an explicit filename still wins', async () => {
    const { manager } = await freshManager();
    const rec = manager.add({
      url: 'https://www.youtube.com/watch?v=abc',
      filename: 'My Song.mp4',
      startPaused: true,
    });
    assert.equal(rec.filename, 'My Song.mp4');
    await manager.shutdown();
  });

  test('a direct file URL is unaffected', async () => {
    const { manager } = await freshManager();
    const rec = manager.add({ url: 'https://x.test/clip.mkv', startPaused: true });
    assert.equal(rec.filename, 'clip.mkv');
    assert.equal(rec.useYtdlp, false);
    await manager.shutdown();
  });
});

describe('humanizeError', () => {
  test('replaces the raw ENOENT the user was shown', () => {
    const raw =
      'ENOENT: no such file or directory, rename ' +
      "'/Users/x/Downloads/IDM-Next/other/.idm-staging-0a777b76/Some Video.webm' -> " +
      "'/Users/x/Downloads/IDM-Next/other/Some Video.webm'";
    const out = humanizeError(raw);
    assert.ok(!out.includes('/Users/'), 'must not leak an internal path');
    assert.ok(out.length < 80, `still too long: ${out}`);
    assert.match(out, /no usable file/i);
  });

  test('names the causes a user can act on', () => {
    assert.match(humanizeError('ffmpeg is unavailable, so video and audio...'), /ffmpeg/i);
    assert.match(humanizeError('ENOSPC: no space left on device'), /disk space/i);
    assert.match(humanizeError('connect ECONNREFUSED 127.0.0.1:9'), /refused/i);
    assert.match(humanizeError('HTTP 404'), /no longer there/i);
    assert.match(humanizeError('HTTP 429'), /rate-limit/i);
    assert.match(humanizeError('ERROR: Unsupported URL: https://x.test'), /not supported/i);
  });

  test('keeps an unknown message, trimmed to one line', () => {
    const out = humanizeError('Something odd happened\nstack line\nstack line');
    assert.equal(out, 'Something odd happened');
  });

  test('caps a very long unknown message', () => {
    assert.ok(humanizeError('x'.repeat(400)).length <= 120);
  });
});

describe('probe before takeover', () => {
  test('reports canTakeOver for a ranged server', async () => {
    const fx = await startFixture({ body: makeBody(1 * MB), etag: '"v1"' });
    const { manager } = await freshManager();
    try {
      const res = await manager.probeUrl(fx.url);
      assert.equal(res.ok, true);
      assert.equal(res.canTakeOver, true);
      assert.equal(res.totalSize, 1 * MB);
    } finally {
      await fx.close();
      await manager.shutdown();
    }
  });

  test('refuses takeover when the server ignores ranges', async () => {
    // The extension must leave the browser's own download alone here.
    const fx = await startFixture({ body: makeBody(64 * 1024), noRanges: true });
    const { manager } = await freshManager();
    try {
      const res = await manager.probeUrl(fx.url);
      assert.equal(res.canTakeOver, false);
      assert.match(res.reason ?? '', /ranged/i);
    } finally {
      await fx.close();
      await manager.shutdown();
    }
  });

  test('refuses takeover for an unreachable URL', async () => {
    const { manager } = await freshManager();
    const res = await manager.probeUrl('http://127.0.0.1:1/nothing');
    assert.equal(res.ok, false);
    assert.equal(res.canTakeOver, false);
    await manager.shutdown();
  });
});

describe('downloading', () => {
  test('runs a download to completion and records it', async () => {
    const body = makeBody(2 * MB);
    const fx = await startFixture({ body, etag: '"v1"' });
    const { manager } = await freshManager();
    try {
      const rec = manager.add({ url: fx.url });
      const [done] = await once(manager, 'done');
      assert.equal(done.id, rec.id);
      assert.equal(done.status, 'completed');
      assert.equal(await hashFile(done.filePath), sha256(body));
    } finally {
      await fx.close();
      await manager.shutdown();
    }
  });

  test('verifies a supplied checksum', async () => {
    const body = makeBody(512 * 1024);
    const fx = await startFixture({ body, etag: '"v1"' });
    const { manager } = await freshManager();
    try {
      manager.add({
        url: fx.url,
        checksum: { algorithm: 'sha256', value: sha256(body) },
      });
      const [done] = await once(manager, 'done');
      assert.equal(done.checksum?.verified, true);
    } finally {
      await fx.close();
      await manager.shutdown();
    }
  });

  test('flags a checksum mismatch rather than silently accepting it', async () => {
    const fx = await startFixture({ body: makeBody(512 * 1024), etag: '"v1"' });
    const { manager } = await freshManager();
    try {
      manager.add({ url: fx.url, checksum: { algorithm: 'sha256', value: 'deadbeef' } });
      const [done] = await once(manager, 'done');
      assert.equal(done.checksum?.verified, false);
    } finally {
      await fx.close();
      await manager.shutdown();
    }
  });

  test('records a failure instead of hanging', async () => {
    const { manager } = await freshManager();
    manager.add({ url: 'http://127.0.0.1:1/gone', connections: 2 });
    const [failure] = await once(manager, 'failed');
    assert.ok(failure.error.length > 0);
    assert.equal(manager.records[0]?.status, 'failed');
    await manager.shutdown();
  });
});

describe('repeat downloads of the same stream', () => {
  test('do not overwrite each other', async () => {
    // yt-dlp names the file itself, so without staging + uniquePath a second
    // download of the same URL silently replaces the first. This is exactly
    // what produced three identical rows pointing at one file.
    const { manager, dir } = await freshManager();
    const { mkdir, writeFile, readdir } = await import('node:fs/promises');
    const { uniquePath } = await import('@idm-next/core');
    const { join: j } = await import('node:path');

    const dest = j(dir, 'dl', 'video');
    await mkdir(dest, { recursive: true });

    // Stand in for three yt-dlp runs that each produce "stream.mp4".
    const paths: string[] = [];
    for (let i = 0; i < 3; i++) {
      const p = await uniquePath(j(dest, 'stream.mp4'));
      await writeFile(p, `run ${i}`);
      paths.push(p);
    }

    assert.equal(new Set(paths).size, 3, 'each run must get its own path');
    assert.deepEqual((await readdir(dest)).sort(), [
      'stream (1).mp4',
      'stream (2).mp4',
      'stream.mp4',
    ]);
    await manager.shutdown();
  });
});

describe("picking yt-dlp's output", () => {
  test('tells an intermediate stream from a merged result', () => {
    // yt-dlp writes NAME.f<id>.ext per stream and NAME.ext for the merge.
    // Confusing the two kept the audio track and deleted the finished video,
    // so a 1080p download completed as a .m4a.
    assert.equal(isIntermediate('Big Buck Bunny.f140.m4a'), true);
    assert.equal(isIntermediate('Big Buck Bunny.f278.webm'), true);
    assert.equal(isIntermediate('Big Buck Bunny.mp4'), false);
    assert.equal(isIntermediate('Big Buck Bunny.f140.mp4.mkv'), false);
    assert.equal(isIntermediate('report.pdf'), false);
    // A dot-heavy title must not be mistaken for a stream marker.
    assert.equal(isIntermediate('S01.E02.1080p.mkv'), false);
  });
});

describe('concurrency', () => {
  test('never runs more than maxConcurrentDownloads at once', async () => {
    const fx = await startFixture({
      body: makeBody(4 * MB),
      etag: '"v1"',
      slowRange: { from: 0, to: 4 * MB, bps: 2 * MB },
    });
    const { manager, store } = await freshManager();
    store.update((s) => {
      s.settings.maxConcurrentDownloads = 2;
    });
    try {
      for (let i = 0; i < 5; i++) manager.add({ url: `${fx.url}?n=${i}`, filename: `f${i}.bin` });

      // Sample repeatedly; a single check could miss a transient overshoot.
      for (let i = 0; i < 10; i++) {
        const active = manager.records.filter((d) => d.status === 'downloading').length;
        assert.ok(active <= 2, `${active} concurrent downloads, cap is 2`);
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      await fx.close();
      await manager.shutdown();
    }
  });
});

describe('persistence', () => {
  test('an interrupted download is paused, not silently restarted, on relaunch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idm-persist-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json');

    const store1 = await Store.open(statePath);
    const m1 = new DownloadManager(store1);
    await m1.init();
    m1.add({ url: 'https://x.test/big.iso', startPaused: true });
    // Simulate having been mid-flight when the app died.
    store1.update((s) => {
      s.downloads[0]!.status = 'downloading';
    });
    await store1.flush();
    await m1.shutdown();

    const store2 = await Store.open(statePath);
    const m2 = new DownloadManager(store2);
    await m2.init();

    assert.equal(m2.records.length, 1);
    assert.equal(
      m2.records[0]?.status,
      'paused',
      'relaunch should not saturate the connection unasked',
    );
    await m2.shutdown();
  });

  test('state survives a restart and is valid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idm-persist2-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json');

    const store1 = await Store.open(statePath);
    const m1 = new DownloadManager(store1);
    await m1.init();
    m1.add({ url: 'https://x.test/a.mp4', startPaused: true });
    m1.add({ url: 'https://x.test/b.pdf', startPaused: true });
    await m1.shutdown();

    JSON.parse(await readFile(statePath, 'utf8'));

    const store2 = await Store.open(statePath);
    const m2 = new DownloadManager(store2);
    await m2.init();
    assert.equal(m2.records.length, 2);
    assert.deepEqual(m2.records.map((d) => basename(d.filename)).sort(), ['a.mp4', 'b.pdf']);
    await m2.shutdown();
  });

  test('a corrupt state file falls back to defaults instead of refusing to launch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idm-corrupt-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(statePath, '{ this is not json');

    const store = await Store.open(statePath);
    assert.equal(store.data.downloads.length, 0);
    assert.ok(store.settings.defaultConnections > 0);
  });

  test('settings written by an older build are filled in, not left partial', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idm-partial-'));
    dirs.push(dir);
    const statePath = join(dir, 'state.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      statePath,
      JSON.stringify({ version: 1, downloads: [], queues: [], settings: { globalRateBps: 500 } }),
    );

    const store = await Store.open(statePath);
    assert.equal(store.settings.globalRateBps, 500, 'kept the stored value');
    assert.equal(typeof store.settings.defaultConnections, 'number', 'filled the missing one');
    assert.ok(store.data.queues.length > 0, 'restored the default queue');
  });
});
