/**
 * Detection heuristics.
 *
 * These are pure functions precisely so they can be tested here rather than by
 * clicking around a streaming site. The false-positive cases matter as much as
 * the positives: a popup full of ad beacons is worse than no popup.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldRecord,
  dedupeKey,
  kindOf,
  isManifest,
  extensionOf,
  filenameOf,
  MIN_MEDIA_BYTES,
} from './shared.js';

const BIG = MIN_MEDIA_BYTES * 10;

describe('shouldRecord: what we offer', () => {
  test('a real video response', () => {
    assert.equal(
      shouldRecord({ url: 'https://x.test/movie.mp4', contentType: 'video/mp4', size: BIG }),
      true,
    );
  });

  test('audio', () => {
    assert.equal(
      shouldRecord({ url: 'https://x.test/song.mp3', contentType: 'audio/mpeg', size: BIG }),
      true,
    );
  });

  test('an HLS manifest despite being tiny', () => {
    // The size floor must never apply here: manifests are a few hundred bytes
    // and they are the most valuable thing we can find on a streaming page.
    assert.equal(
      shouldRecord({
        url: 'https://x.test/master.m3u8',
        contentType: 'application/vnd.apple.mpegurl',
        size: 812,
      }),
      true,
    );
  });

  test('a DASH manifest', () => {
    assert.equal(
      shouldRecord({ url: 'https://x.test/m.mpd', contentType: 'application/dash+xml', size: 500 }),
      true,
    );
  });

  test('an octet-stream with a media extension', () => {
    // Plenty of CDNs serve video as application/octet-stream.
    assert.equal(
      shouldRecord({
        url: 'https://x.test/clip.mkv',
        contentType: 'application/octet-stream',
        size: BIG,
      }),
      true,
    );
  });

  test('an attachment regardless of size or type', () => {
    assert.equal(
      shouldRecord({
        url: 'https://x.test/export',
        contentType: 'text/csv',
        size: 40,
        contentDisposition: 'attachment; filename="report.csv"',
      }),
      true,
    );
  });

  test('a response with no Content-Length', () => {
    // Chunked responses give us nothing to compare; err toward offering.
    assert.equal(
      shouldRecord({ url: 'https://x.test/live.mp4', contentType: 'video/mp4', size: null }),
      true,
    );
  });

  test('archives and installers', () => {
    for (const name of ['app.dmg', 'tool.zip', 'os.iso', 'book.pdf', 'app.apk']) {
      assert.equal(
        shouldRecord({ url: `https://x.test/${name}`, contentType: null, size: BIG }),
        true,
        name,
      );
    }
  });
});

describe('shouldRecord: what we ignore', () => {
  test('an HTML page', () => {
    assert.equal(
      shouldRecord({ url: 'https://x.test/watch', contentType: 'text/html', size: BIG }),
      false,
    );
  });

  test('scripts, styles and JSON', () => {
    for (const [url, ct] of [
      ['https://x.test/app.js', 'application/javascript'],
      ['https://x.test/app.css', 'text/css'],
      ['https://x.test/api/data', 'application/json'],
    ]) {
      assert.equal(shouldRecord({ url, contentType: ct, size: BIG }), false, url);
    }
  });

  test('a tiny audio ad beacon', () => {
    // The exact case the size floor exists for.
    assert.equal(
      shouldRecord({ url: 'https://ads.test/beacon.mp3', contentType: 'audio/mpeg', size: 1200 }),
      false,
    );
  });

  test('a thumbnail-sized video sprite', () => {
    assert.equal(
      shouldRecord({ url: 'https://x.test/preview.mp4', contentType: 'video/mp4', size: 9000 }),
      false,
    );
  });

  test('a content type with parameters is still matched', () => {
    assert.equal(
      shouldRecord({ url: 'https://x.test/a.mp4', contentType: 'video/mp4; codecs="avc1"', size: BIG }),
      true,
    );
  });
});

describe('dedupeKey', () => {
  test('collapses range and timestamp churn into one entry', () => {
    // A seeking player fires these constantly; without this the popup shows
    // fifty copies of one video.
    const a = dedupeKey('https://x.test/v.mp4?range=0-100&id=7');
    const b = dedupeKey('https://x.test/v.mp4?range=900-1000&id=7');
    const c = dedupeKey('https://x.test/v.mp4?id=7&t=88');
    assert.equal(a, b);
    assert.equal(b, c);
  });

  test('keeps genuinely different files apart', () => {
    assert.notEqual(
      dedupeKey('https://x.test/720p.mp4'),
      dedupeKey('https://x.test/1080p.mp4'),
    );
  });

  test('keeps meaningful query parameters', () => {
    assert.notEqual(
      dedupeKey('https://x.test/v.mp4?quality=720'),
      dedupeKey('https://x.test/v.mp4?quality=1080'),
    );
  });

  test('survives a malformed URL', () => {
    assert.equal(dedupeKey('not a url'), 'not a url');
  });
});

describe('classification', () => {
  test('kindOf uses content type first, extension second', () => {
    assert.equal(kindOf('https://x.test/a', 'video/mp4'), 'video');
    assert.equal(kindOf('https://x.test/a', 'audio/flac'), 'audio');
    assert.equal(kindOf('https://x.test/a.mkv', null), 'video');
    assert.equal(kindOf('https://x.test/a.flac', null), 'audio');
    assert.equal(kindOf('https://x.test/a.zip', null), 'file');
  });

  test('a manifest is a stream, not a video', () => {
    // It routes down the yt-dlp path rather than the segmented engine.
    assert.equal(kindOf('https://x.test/master.m3u8', null), 'stream');
    assert.equal(kindOf('https://x.test/x', 'application/dash+xml'), 'stream');
  });

  test('isManifest recognises both extension and content type', () => {
    assert.equal(isManifest('https://x.test/a.m3u8', null), true);
    assert.equal(isManifest('https://x.test/a.mpd', null), true);
    assert.equal(isManifest('https://x.test/a', 'application/x-mpegURL'), true);
    assert.equal(isManifest('https://x.test/a.mp4', 'video/mp4'), false);
  });
});

describe('url parsing', () => {
  test('extensionOf ignores the query string', () => {
    assert.equal(extensionOf('https://x.test/a/b/v.mp4?token=abc.def'), 'mp4');
  });

  test('extensionOf returns empty for an extensionless path', () => {
    assert.equal(extensionOf('https://x.test/watch'), '');
  });

  test('filenameOf decodes percent-encoding', () => {
    assert.equal(filenameOf('https://x.test/my%20movie.mp4'), 'my movie.mp4');
  });

  test('filenameOf falls back for a bare origin', () => {
    assert.equal(filenameOf('https://x.test/'), 'download');
  });
});
