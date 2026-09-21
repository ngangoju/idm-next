/**
 * yt-dlp layer.
 *
 * The parsing tests use fixtures so they don't need the network. The binary
 * tests exercise the real yt-dlp that is installed, because the whole point of
 * --progress-template is that we stop guessing at its output format — and a
 * guess that is never checked against the real thing is just a slower regex.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  YtDlp,
  parseProgressLine,
  parseExtraction,
  isProgressive,
  remuxIfMislabelled,
} from './ytdlp.ts';
import { looksLikePage } from './manager.ts';

describe('parseProgressLine', () => {
  test('reads a downloading tick', () => {
    const p = parseProgressLine(
      '{"status":"downloading","downloaded_bytes":1048576,"total_bytes":10485760,"speed":524288.5,"eta":18}',
    );
    assert.deepEqual(p, {
      status: 'downloading',
      downloaded: 1048576,
      total: 10485760,
      speed: 524288.5,
      eta: 18,
    });
  });

  test('falls back to total_bytes_estimate for adaptive streams', () => {
    // HLS and DASH never report an exact total until the end.
    const p = parseProgressLine(
      '{"status":"downloading","downloaded_bytes":100,"total_bytes":null,"total_bytes_estimate":98765.4}',
    );
    assert.equal(p?.total, 98765.4);
  });

  test('tolerates nulls in every numeric field', () => {
    const p = parseProgressLine(
      '{"status":"downloading","downloaded_bytes":0,"total_bytes":null,"speed":null,"eta":null}',
    );
    assert.deepEqual(p, { status: 'downloading', downloaded: 0, total: null, speed: null, eta: null });
  });

  test('ignores yt-dlp chatter that is not progress JSON', () => {
    for (const line of [
      '[download] Destination: video.mp4',
      'WARNING: something happened',
      '[info] Available formats:',
      '',
      '   ',
      '/Users/x/Downloads/video.mp4',
    ]) {
      assert.equal(parseProgressLine(line), null, line);
    }
  });

  test('ignores malformed JSON and unknown statuses', () => {
    assert.equal(parseProgressLine('{"status":"downloading"'), null);
    assert.equal(parseProgressLine('{"status":"processing"}'), null);
  });

  test('recognises the finished tick', () => {
    const p = parseProgressLine('{"status":"finished","downloaded_bytes":500,"total_bytes":500}');
    assert.equal(p?.status, 'finished');
  });
});

describe('parseExtraction', () => {
  const sample = JSON.stringify({
    title: 'Some Talk',
    duration: 3600,
    thumbnail: 'https://x.test/t.jpg',
    formats: [
      { format_id: '18', ext: 'mp4', width: 640, height: 360, protocol: 'https', url: 'https://x.test/360.mp4', vcodec: 'avc1', acodec: 'mp4a', filesize: 1000 },
      { format_id: '137', ext: 'mp4', width: 1920, height: 1080, protocol: 'https', url: 'https://x.test/1080.mp4', vcodec: 'avc1', acodec: 'none', filesize_approx: 5000, fps: 30 },
      { format_id: 'hls-720', ext: 'mp4', height: 720, protocol: 'm3u8_native', url: 'https://x.test/m.m3u8', vcodec: 'avc1', acodec: 'mp4a' },
    ],
  });

  test('extracts title and formats, best first', () => {
    const e = parseExtraction(sample);
    assert.equal(e.title, 'Some Talk');
    assert.equal(e.duration, 3600);
    assert.equal(e.formats.length, 3);
    // yt-dlp lists worst-to-best; we reverse so the UI shows best first.
    assert.equal(e.formats[0]?.id, 'hls-720');
    assert.equal(e.formats.at(-1)?.id, '18');
  });

  test('reports no resolution rather than guessing "audio only"', () => {
    // A bare HLS media playlist carries no dimensions. Calling that "audio
    // only" mislabelled a 720p video in the picker.
    const e = parseExtraction(
      JSON.stringify({ formats: [{ format_id: 'x', protocol: 'm3u8_native', url: 'https://x/a.m3u8' }] }),
    );
    assert.equal(e.formats[0]?.resolution, null);
  });

  test('normalizes resolution and treats "none" codecs as absent', () => {
    const e = parseExtraction(sample);
    const f1080 = e.formats.find((f) => f.id === '137');
    assert.equal(f1080?.resolution, '1920x1080');
    assert.equal(f1080?.acodec, null, 'video-only format should report no audio codec');
    assert.equal(f1080?.filesize, 5000, 'filesize_approx should be used when filesize is absent');
  });

  test('unwraps a playlist to its first entry', () => {
    const playlist = JSON.stringify({
      _type: 'playlist',
      entries: [{ title: 'First', formats: [{ format_id: 'a', protocol: 'https', url: 'https://x/1' }] }],
    });
    const e = parseExtraction(playlist);
    assert.equal(e.isPlaylist, true);
    assert.equal(e.title, 'First');
  });

  test('survives an entry with no formats', () => {
    const e = parseExtraction(JSON.stringify({ title: 'Nothing' }));
    assert.deepEqual(e.formats, []);
  });
});

describe('routing', () => {
  test('progressive formats go to our engine', () => {
    const e = parseExtraction(
      JSON.stringify({
        formats: [
          { format_id: 'a', protocol: 'https', url: 'https://x/a.mp4' },
          { format_id: 'b', protocol: 'm3u8_native', url: 'https://x/b.m3u8' },
          { format_id: 'c', protocol: 'http_dash_segments', url: 'https://x/c' },
          { format_id: 'd', protocol: 'https' },
        ],
      }),
    );
    const byId = Object.fromEntries(e.formats.map((f) => [f.id, isProgressive(f)]));
    assert.equal(byId['a'], true, 'plain https with a url');
    assert.equal(byId['b'], false, 'HLS must stay inside yt-dlp');
    assert.equal(byId['c'], false, 'DASH must stay inside yt-dlp');
    assert.equal(byId['d'], false, 'no url means nothing to range over');
  });

  test('looksLikePage sends pages and manifests down the yt-dlp path', () => {
    for (const url of [
      'https://x.test/watch',
      'https://x.test/video/12345',
      'https://x.test/page.html',
      'https://x.test/master.m3u8',
      'https://x.test/manifest.mpd',
    ]) {
      assert.equal(looksLikePage(url), true, url);
    }
  });

  test('looksLikePage leaves direct files on the fast path', () => {
    for (const url of [
      'https://x.test/movie.mp4',
      'https://x.test/album.zip',
      'https://x.test/paper.pdf',
      'https://x.test/a/b/installer.dmg',
    ]) {
      assert.equal(looksLikePage(url), false, url);
    }
  });
});

/* ------------------------- against the real binary ------------------------- */

const hasYtDlp = await (async () => {
  try {
    const child = spawn('yt-dlp', ['--version'], { stdio: 'ignore' });
    const [code] = (await once(child, 'close')) as [number];
    return code === 0;
  } catch {
    return false;
  }
})();

describe('the installed yt-dlp', { skip: hasYtDlp ? false : 'yt-dlp not installed' }, () => {
  test('is found and reports a version', async () => {
    const status = await new YtDlp().available();
    assert.equal(status.ok, true);
    assert.match(status.version ?? '', /\d{4}\.\d{2}\.\d{2}/);
  });

  test('reports a clear error for a missing binary instead of throwing', async () => {
    const status = await new YtDlp('definitely-not-a-real-binary-xyz').available();
    assert.equal(status.ok, false);
    assert.match(status.error ?? '', /not found/i);
  });

  test('still supports the flags we depend on', async () => {
    // If a future yt-dlp drops these, progress parsing silently degrades to
    // nothing. Better to fail here than in the field.
    const child = spawn('yt-dlp', ['--help'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let help = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (help += c));
    await once(child, 'close');

    for (const flag of ['--progress-template', '--progress-delta', '--concurrent-fragments', '-J', '--print']) {
      assert.ok(help.includes(flag), `yt-dlp no longer documents ${flag}`);
    }
  });
});

const hasFfmpeg = await (async () => {
  try {
    const child = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    const [code] = (await once(child, 'close')) as [number];
    return code === 0;
  } catch {
    return false;
  }
})();

describe('remuxIfMislabelled', { skip: hasFfmpeg ? false : 'ffmpeg not installed' }, () => {
  async function probeContainer(file: string): Promise<string> {
    const child = spawn(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=format_name', '-of', 'csv=p=0', file],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    await once(child, 'close');
    return out.trim();
  }

  async function makeTs(dir: string, name: string): Promise<string> {
    const file = join(dir, name);
    const child = spawn(
      'ffmpeg',
      ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
       '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'mpegts', file],
      { stdio: 'ignore' },
    );
    await once(child, 'close');
    return file;
  }

  test('rewrites MPEG-TS that is masquerading as .mp4', async () => {
    // Exactly what yt-dlp's native HLS downloader produces: TS bytes, .mp4
    // name. VLC copes; Safari, QuickTime and browsers do not.
    const dir = await mkdtemp(join(tmpdir(), 'idm-remux-'));
    try {
      const file = await makeTs(dir, 'clip.mp4');
      assert.match(await probeContainer(file), /mpegts/, 'fixture precondition');

      const result = await remuxIfMislabelled(file);
      assert.equal(result.remuxed, true);
      assert.match(await probeContainer(file), /mp4/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('leaves a genuine .ts file alone', async () => {
    // The extension is honest here, so there is nothing to fix.
    const dir = await mkdtemp(join(tmpdir(), 'idm-remux2-'));
    try {
      const file = await makeTs(dir, 'clip.ts');
      const result = await remuxIfMislabelled(file);
      assert.equal(result.remuxed, false);
      assert.match(await probeContainer(file), /mpegts/, 'file must not be touched');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('is a no-op on a file that is already a real mp4', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idm-remux3-'));
    try {
      const file = join(dir, 'real.mp4');
      const child = spawn(
        'ffmpeg',
        ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1',
         '-c:v', 'libx264', '-preset', 'ultrafast', file],
        { stdio: 'ignore' },
      );
      await once(child, 'close');

      const result = await remuxIfMislabelled(file);
      assert.equal(result.remuxed, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('keeps the original when ffmpeg is missing rather than losing the download', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idm-remux4-'));
    try {
      const file = await makeTs(dir, 'clip.mp4');
      const result = await remuxIfMislabelled(file, 'no-such-ffmpeg-xyz', 'no-such-ffprobe-xyz');
      assert.equal(result.remuxed, false);
      await access(file); // still there, still playable
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
