/**
 * When a download opens its own progress window.
 *
 * The window existed for a while and never appeared once, for two reasons that
 * both live here: nothing in the main process raised it, and the record was
 * announced as `paused` even when it had already started — so every "is this
 * one actually starting?" test said no. Both are asserted below.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

import { Store } from './store.ts';
import { DownloadManager } from './manager.ts';
import { shouldAutoOpen, MAX_AUTO_WINDOWS } from './detail.ts';
import { startFixture, makeBody } from '../../../core/test/fixture-server.ts';
import type { DownloadRecord } from '../shared/protocol.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('shouldAutoOpen', () => {
  const on = { autoOpenDetails: true };
  const off = { autoOpenDetails: false };

  test('opens for a download that is starting', () => {
    assert.equal(shouldAutoOpen({ status: 'downloading' }, on, 0), true);
    assert.equal(shouldAutoOpen({ status: 'probing' }, on, 0), true);
  });

  test('stays out of the way for one that is only queued', () => {
    assert.equal(shouldAutoOpen({ status: 'paused' }, on, 0), false);
  });

  test('respects the setting', () => {
    assert.equal(shouldAutoOpen({ status: 'downloading' }, off, 0), false);
  });

  test('stops stacking windows once a few are open', () => {
    // "Download all" adds a page's worth at once; a window each would bury the
    // browser the user is still reading.
    assert.equal(shouldAutoOpen({ status: 'downloading' }, on, MAX_AUTO_WINDOWS - 1), true);
    assert.equal(shouldAutoOpen({ status: 'downloading' }, on, MAX_AUTO_WINDOWS), false);
  });
});

describe('the added event', () => {
  test('describes a started download as started, not as paused', async () => {
    // add() builds the record `paused` and only then starts it. Announcing at
    // that point makes every listener — the auto-open decision included — see a
    // queued download where a running one is meant.
    const dir = await mkdtemp(join(tmpdir(), 'idm-detail-'));
    dirs.push(dir);
    const store = await Store.open(join(dir, 'state.json'));
    store.update((s) => {
      s.settings.downloadDir = join(dir, 'dl');
    });
    const manager = new DownloadManager(store);
    await manager.init();

    const fixture = await startFixture({ body: makeBody(64 * 1024) });
    try {
      // Snapshot inside the listener, which is what actually matters: the
      // server serializes the record there and then, and a listener that reads
      // it later sees the object already mutated by resume() — so awaiting the
      // event would let this bug through.
      const announced: DownloadRecord[] = [];
      manager.on('added', (r) => announced.push({ ...r }));

      const finished = once(manager, 'done');
      manager.add({ url: `${fixture.url}/file.bin` });

      const first = announced[0];
      assert.ok(first, 'nothing was announced');
      assert.notEqual(first.status, 'paused');
      assert.equal(shouldAutoOpen(first, { autoOpenDetails: true }, 0), true);

      // Let it land before tearing the fixture down, so nothing is left
      // half-open behind the assertions.
      await finished;
    } finally {
      await manager.shutdown();
      await fixture.close();
    }
  });

  test('still describes an explicitly paused download as paused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idm-detail-'));
    dirs.push(dir);
    const store = await Store.open(join(dir, 'state.json'));
    store.update((s) => {
      s.settings.downloadDir = join(dir, 'dl');
    });
    const manager = new DownloadManager(store);
    await manager.init();

    try {
      const announced: DownloadRecord[] = [];
      manager.on('added', (r) => announced.push({ ...r }));
      manager.add({ url: 'https://example.invalid/file.bin', startPaused: true });

      const first = announced[0];
      assert.ok(first, 'nothing was announced');
      assert.equal(first.status, 'paused');
      assert.equal(shouldAutoOpen(first, { autoOpenDetails: true }, 0), false);
    } finally {
      await manager.shutdown();
    }
  });
});
