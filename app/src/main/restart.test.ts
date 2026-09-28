/**
 * Downloading again, and the list knowing what is actually on disk.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { Store } from './store.ts';
import { DownloadManager, routeFor } from './manager.ts';
import { startFixture, makeBody, sha256 } from '../../../core/test/fixture-server.ts';
import type { DownloadRecord } from '../shared/protocol.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function freshManager(): Promise<DownloadManager> {
  const dir = await mkdtemp(join(tmpdir(), 'idm-restart-'));
  dirs.push(dir);
  const store = await Store.open(join(dir, 'state.json'));
  store.update((s) => {
    s.settings.downloadDir = join(dir, 'dl');
  });
  const manager = new DownloadManager(store);
  await manager.init();
  return manager;
}

const exists = (p: string): Promise<boolean> =>
  access(p).then(
    () => true,
    () => false,
  );

function waitFor(manager: DownloadManager, id: string, event: 'done' | 'failed'): Promise<void> {
  return new Promise((resolve) => {
    const on = (r: DownloadRecord | { id: string }): void => {
      if (r.id !== id) return;
      manager.off(event, on);
      resolve();
    };
    manager.on(event, on);
  });
}

describe('download again', () => {
  test('recovers a download whose file changed on the server', async () => {
    // The case resume can never get past: the journal describes a file that no
    // longer exists, so every resume fails the same way.
    const body = makeBody(4 * 1024 * 1024);
    const fx = await startFixture({
      body,
      etag: '"v1"',
      slowRange: { from: 0, to: body.length, bps: 512 * 1024 },
    });
    const manager = await freshManager();
    try {
      const record = manager.add({ url: fx.url, connections: 4 });
      await new Promise((r) => setTimeout(r, 400));
      await manager.pause(record.id);
      assert.ok(record.downloaded > 0, 'expected a partial download to pause');

      fx.options.etag = '"v2"';
      delete fx.options.slowRange;

      const failed = waitFor(manager, record.id, 'failed');
      manager.resume(record.id);
      await failed;
      assert.match(record.error ?? '', /changed/i);

      const done = waitFor(manager, record.id, 'done');
      await manager.restart(record.id);
      await done;

      const final = manager.records.find((d) => d.id === record.id)!;
      assert.equal(final.status, 'completed');
      assert.equal(final.error, undefined);
      // The partial was thrown away rather than sitting beside the new copy.
      assert.equal(basename(final.filePath), 'file.bin');
      assert.equal(sha256(await readFile(final.filePath)), sha256(body));
    } finally {
      await manager.shutdown();
      await fx.close();
    }
  });

  test('never overwrites a finished file that is still there', async () => {
    const body = makeBody(300_000);
    const fx = await startFixture({ body });
    const manager = await freshManager();
    try {
      const record = manager.add({ url: fx.url });
      await waitFor(manager, record.id, 'done');
      const first = manager.records.find((d) => d.id === record.id)!.filePath;

      const again = waitFor(manager, record.id, 'done');
      await manager.restart(record.id);
      await again;

      const second = manager.records.find((d) => d.id === record.id)!.filePath;
      assert.notEqual(second, first);
      assert.equal(basename(second), 'file (1).bin');
      assert.ok(await exists(first), 'the original must survive');
      assert.equal(sha256(await readFile(second)), sha256(body));
    } finally {
      await manager.shutdown();
      await fx.close();
    }
  });

  test('re-fetches a finished file that was deleted, under its own name', async () => {
    const body = makeBody(300_000);
    const fx = await startFixture({ body });
    const manager = await freshManager();
    try {
      const record = manager.add({ url: fx.url });
      await waitFor(manager, record.id, 'done');
      const path = manager.records.find((d) => d.id === record.id)!.filePath;
      await rm(path);

      const again = waitFor(manager, record.id, 'done');
      await manager.restart(record.id);
      await again;

      assert.equal(manager.records.find((d) => d.id === record.id)!.filePath, path);
      assert.equal(sha256(await readFile(path)), sha256(body));
    } finally {
      await manager.shutdown();
      await fx.close();
    }
  });

  test('announces itself, so a progress window can open for it', async () => {
    const fx = await startFixture({ body: makeBody(100_000) });
    const manager = await freshManager();
    try {
      const record = manager.add({ url: fx.url });
      await waitFor(manager, record.id, 'done');

      const announced: DownloadRecord[] = [];
      manager.on('restarted', (r) => announced.push({ ...r }));
      const again = waitFor(manager, record.id, 'done');
      await manager.restart(record.id);

      assert.equal(announced.length, 1);
      assert.notEqual(announced[0]!.status, 'completed');
      await again;
    } finally {
      await manager.shutdown();
      await fx.close();
    }
  });

  test('is a no-op for an unknown id', async () => {
    const manager = await freshManager();
    try {
      assert.equal(await manager.restart('nope'), null);
    } finally {
      await manager.shutdown();
    }
  });
});

describe('the list snapshot', () => {
  test('marks a finished download whose file is gone, without storing it', async () => {
    const fx = await startFixture({ body: makeBody(100_000) });
    const manager = await freshManager();
    try {
      const record = manager.add({ url: fx.url });
      await waitFor(manager, record.id, 'done');
      assert.equal(manager.snapshot().find((d) => d.id === record.id)!.fileMissing, undefined);

      await rm(manager.records.find((d) => d.id === record.id)!.filePath);
      assert.equal(manager.snapshot().find((d) => d.id === record.id)!.fileMissing, true);
      // Derived, never persisted: it would be stale the moment the file came back.
      assert.equal(manager.records.find((d) => d.id === record.id)!.fileMissing, undefined);
    } finally {
      await manager.shutdown();
      await fx.close();
    }
  });
});

describe('the name in the list', () => {
  test('follows the name the file was actually written under', async () => {
    // An X image: no extension in the path. The engine now adds one from the
    // Content-Type, and the list has to show that name, not the guess.
    const body = makeBody(100_000);
    const fx = await startFixture({ body, contentType: 'image/jpeg' });
    const manager = await freshManager();
    try {
      const url = fx.url.replace('/file.bin', '/media/GiQ4vJ2XIAAxm6v?format=jpg&name=large');
      const record = manager.add({ url });
      await waitFor(manager, record.id, 'done');

      const final = manager.records.find((d) => d.id === record.id)!;
      // Not handed to yt-dlp as a "page", which saved it as .unknown_video.
      assert.equal(final.useYtdlp, false);
      assert.equal(final.routeUnverified, undefined);
      assert.equal(final.filename, 'GiQ4vJ2XIAAxm6v.jpg');
      assert.equal(basename(final.filePath), 'GiQ4vJ2XIAAxm6v.jpg');
      // Filed as what it is, not in the video folder the page guess picked.
      assert.notEqual(final.category, 'video');
      assert.equal(final.filePath, join(manager.destDirFor(final.category), 'GiQ4vJ2XIAAxm6v.jpg'));
      assert.equal(sha256(await readFile(final.filePath)), sha256(body));
    } finally {
      await manager.shutdown();
      await fx.close();
    }
  });
});

describe('routeFor', () => {
  test('sends pages and stream manifests to yt-dlp', () => {
    assert.equal(routeFor('text/html; charset=utf-8'), 'ytdlp');
    assert.equal(routeFor('application/vnd.apple.mpegurl'), 'ytdlp');
    assert.equal(routeFor('application/x-mpegURL'), 'ytdlp');
    assert.equal(routeFor('application/dash+xml'), 'ytdlp');
    // Nothing to go on: keep the page guess.
    assert.equal(routeFor(null), 'ytdlp');
  });

  test('keeps files on the engine', () => {
    assert.equal(routeFor('image/jpeg'), 'engine');
    assert.equal(routeFor('video/mp4'), 'engine');
    assert.equal(routeFor('application/octet-stream'), 'engine');
    assert.equal(routeFor('application/pdf'), 'engine');
  });
});
