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
  classify,
  looksOpaqueName,
  isUnfetchableStream,
  looksMediaAdjacent,
  shouldRecord,
  parseContentRangeTotal,
  parseClen,
  isRangedUrl,
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

/**
 * Regression suite built from the traffic a real YouTube watch page produces.
 *
 * The panel there showed three 1 KB JSON files and no video at all: subtitle
 * endpoints walked past the type check because they are served as attachments,
 * and every real stream was rejected for being "too small" because its
 * Content-Length describes one range, not the file.
 */
describe('YouTube watch page', () => {
  const VIDEO = 'https://rr6---sn-ug5o.googlevideo.com/videoplayback?expire=1738378606&itag=137&mime=video%2Fmp4&range=0-65535&rn=12&cpn=abc';
  const AUDIO = 'https://rr6---sn-ug5o.googlevideo.com/videoplayback?expire=1738378606&itag=140&mime=audio%2Fmp4&range=0-65535&rn=13&cpn=abc';
  const TIMEDTEXT = 'https://www.youtube.com/api/timedtext?v=pNrhAv1QC1Q&fmt=json3';
  const PLAYER_API = 'https://www.youtube.com/youtubei/v1/player?key=AIza';

  test('records a ranged video chunk using the total from Content-Range', () => {
    assert.equal(
      shouldRecord({
        url: VIDEO,
        contentType: 'video/mp4',
        // The file is 189 MB; this response carries 64 KB of it.
        size: parseContentRangeTotal('bytes 0-65535/189000000'),
      }),
      true,
    );
  });

  test('a ranged chunk judged by Content-Length alone would be rejected', () => {
    // Documents precisely why the Content-Range lookup exists: this is what
    // the old code passed in, and it is below the size floor.
    assert.equal(shouldRecord({ url: VIDEO, contentType: 'video/mp4', size: 65536 }), false);
  });

  test('records a ranged video chunk using clen when Content-Range is absent (200 OK)', () => {
    const VIDEO_CLEN = `${VIDEO}&clen=189000000`;
    const clenSize = parseClen(VIDEO_CLEN);
    assert.equal(clenSize, 189000000);
    assert.equal(shouldRecord({ url: VIDEO_CLEN, contentType: 'video/mp4', size: clenSize }), true);
  });

  test('records the audio rendition too', () => {
    assert.equal(
      shouldRecord({
        url: AUDIO,
        contentType: 'audio/mp4',
        size: parseContentRangeTotal('bytes 0-65535/3800000'),
      }),
      true,
    );
  });

  test('rejects the subtitle endpoint even though it is an attachment', () => {
    // Exactly the "timedtext, JSON file, 1 KB" rows.
    assert.equal(
      shouldRecord({
        url: TIMEDTEXT,
        contentType: 'application/json; charset=utf-8',
        size: 1024,
        contentDisposition: 'attachment',
      }),
      false,
    );
  });

  test('rejects the player API endpoint', () => {
    assert.equal(
      shouldRecord({ url: PLAYER_API, contentType: 'application/json', size: 240000 }),
      false,
    );
  });

  test('rejects telemetry beacons', () => {
    for (const url of [
      'https://www.youtube.com/api/stats/qoe?event=streamingstats',
      'https://www.youtube.com/generate_204',
      'https://www.youtube.com/ptracking?video_id=x',
      'https://googleads.g.doubleclick.net/pagead/id',
    ]) {
      assert.equal(shouldRecord({ url, contentType: 'application/json', size: 0 }), false, url);
    }
  });

  test('every chunk of one rendition collapses to a single entry', () => {
    // The player issues these continuously while the video plays.
    const chunks = [
      `${VIDEO}`,
      VIDEO.replace('range=0-65535', 'range=65536-131071').replace('rn=12', 'rn=14'),
      VIDEO.replace('range=0-65535', 'range=900000-999999').replace('rn=12', 'rn=57'),
    ];
    const keys = new Set(chunks.map(dedupeKey));
    assert.equal(keys.size, 1, `expected one entry, got ${[...keys].join(' | ')}`);
  });

  test('different renditions stay separate', () => {
    assert.notEqual(dedupeKey(VIDEO), dedupeKey(AUDIO));
    assert.notEqual(dedupeKey(VIDEO), dedupeKey(VIDEO.replace('itag=137', 'itag=22')));
  });
});

describe('parseContentRangeTotal', () => {
  test('reads the total, not the range', () => {
    assert.equal(parseContentRangeTotal('bytes 0-65535/189000000'), 189000000);
    assert.equal(parseContentRangeTotal('bytes 100-200/5000'), 5000);
  });

  test('returns null for an unknown or malformed total', () => {
    assert.equal(parseContentRangeTotal('bytes 0-99/*'), null);
    assert.equal(parseContentRangeTotal('nonsense'), null);
    assert.equal(parseContentRangeTotal(undefined), null);
    assert.equal(parseContentRangeTotal(null), null);
  });
});

describe('parseClen and isRangedUrl', () => {
  test('reads total bytes from clen query parameter', () => {
    assert.equal(parseClen('https://rr.googlevideo.com/videoplayback?clen=189000000&itag=137'), 189000000);
    assert.equal(parseClen('https://rr.googlevideo.com/videoplayback?clen=3800000&itag=140'), 3800000);
  });

  test('returns null when clen is missing or malformed', () => {
    assert.equal(parseClen('https://x.test/video.mp4'), null);
    assert.equal(parseClen('https://x.test/video.mp4?clen=abc'), null);
    assert.equal(parseClen('https://x.test/video.mp4?clen=-5'), null);
    assert.equal(parseClen('not a url'), null);
  });

  test('identifies ranged chunk requests', () => {
    assert.equal(isRangedUrl('https://x.test/video.mp4?range=0-65535'), true);
    assert.equal(isRangedUrl('https://x.test/video.mp4?bytestart=0'), true);
    assert.equal(isRangedUrl('https://x.test/video.mp4'), false);
    assert.equal(isRangedUrl('not a url'), false);
  });
});

describe('attachments still work for real downloads', () => {
  test('a CSV export is still offered', () => {
    // The attachment rule exists for this; it just must not admit JSON APIs.
    assert.equal(
      shouldRecord({
        url: 'https://app.example.com/export.csv',
        contentType: 'text/csv',
        size: 40,
        contentDisposition: 'attachment; filename="report.csv"',
      }),
      true,
    );
  });

  test('an API response dressed as an attachment is not', () => {
    // No filename to claim: this is an endpoint, not a file.
    assert.equal(
      shouldRecord({
        url: 'https://app.example.com/api/session',
        contentType: 'application/json',
        size: 900,
        contentDisposition: 'attachment',
      }),
      false,
    );
  });

  test('an attachment naming a web document is not', () => {
    assert.equal(
      shouldRecord({
        url: 'https://app.example.com/api/dump',
        contentType: 'application/json',
        size: 900,
        contentDisposition: 'attachment; filename="payload.json"',
      }),
      false,
    );
  });

  test('an unnamed attachment of a real media type still is', () => {
    assert.equal(
      shouldRecord({
        url: 'https://cdn.example.com/stream',
        contentType: 'video/mp4',
        size: 900,
        contentDisposition: 'attachment',
      }),
      true,
    );
  });

  test('an installer served as octet-stream is still offered', () => {
    assert.equal(
      shouldRecord({
        url: 'https://example.com/tool.dmg',
        contentType: 'application/octet-stream',
        size: 90 * 1024 * 1024,
      }),
      true,
    );
  });
});


describe('classify: explaining a rejection', () => {
  test('names SABR/UMP, which is why YouTube can look empty', () => {
    // Video and audio multiplexed into one POSTed stream: nothing to fetch by
    // URL, however long the video plays.
    const v = classify({
      url: 'https://rr6---sn-x.googlevideo.com/videoplayback?sabr=1',
      contentType: 'application/vnd.yt-ump',
      size: 500000,
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /SABR|UMP/i);
  });

  test('names the size floor when that is the cause', () => {
    const v = classify({ url: 'https://x.test/a.mp4', contentType: 'video/mp4', size: 9000 });
    assert.equal(v.ok, false);
    assert.match(v.reason, /size floor/i);
  });

  test('names telemetry endpoints', () => {
    const v = classify({
      url: 'https://www.youtube.com/api/timedtext?v=x',
      contentType: 'application/json',
      size: 1024,
      contentDisposition: 'attachment',
    });
    assert.equal(v.ok, false);
    assert.match(v.reason, /telemetry|subtitle/i);
  });

  test('accepts a real stream with no reason attached', () => {
    const v = classify({ url: 'https://x.test/a.mp4', contentType: 'video/mp4', size: 90_000_000 });
    assert.equal(v.ok, true);
    assert.equal(v.reason, '');
  });
});

describe('looksMediaAdjacent: what is worth reporting', () => {
  test('media types and media hosts are', () => {
    assert.equal(looksMediaAdjacent('https://x.test/a', 'video/mp4'), true);
    assert.equal(looksMediaAdjacent('https://x.test/a', 'audio/mp4'), true);
    assert.equal(looksMediaAdjacent('https://rr6---sn-x.googlevideo.com/videoplayback', null), true);
    assert.equal(looksMediaAdjacent('https://x.test/clip.mkv', null), true);
  });

  test('a stylesheet is not', () => {
    // A rejected stylesheet is noise; reporting it would bury the real clue.
    assert.equal(looksMediaAdjacent('https://x.test/app.css', 'text/css'), false);
  });
});

describe('isUnfetchableStream', () => {
  test('recognises the UMP content types', () => {
    assert.equal(isUnfetchableStream('application/vnd.yt-ump'), true);
    assert.equal(isUnfetchableStream('application/vnd.yt-ump; charset=utf-8'), true);
    assert.equal(isUnfetchableStream('video/mp4'), false);
    assert.equal(isUnfetchableStream(null), false);
  });
});


/**
 * Instagram serves every clip from a CDN path whose name is a signed opaque
 * token, with the rest of the identity in per-request parameters. The panel
 * listed thirty-seven rows of unreadable tokens, several of them the same
 * file, with nothing to choose between them.
 */
describe('Instagram reel page', () => {
  const BLOB = 'AQMOZ1cfHZuJEuODZ770FSIURCg9L7NMAYjQnJSRDfdCrj4lFYNqzU';
  const base = `https://instagram.fcmn1-1.fna.fbcdn.net/o1/v/t16/f2/m86/${BLOB}.mp4`;
  const withParams = (extra) =>
    `${base}?efg=eyJ2ZW5jIjoiSEVWQyJ9&_nc_cat=103&_nc_ht=instagram.fcmn1-1.fna.fbcdn.net` +
    `&_nc_gid=abc123&oh=00_AfMxyz&oe=68B12345${extra}`;

  test('every ranged request for one clip collapses to a single row', () => {
    // Items 1 and 4 in the report were the same file, twice.
    const requests = [
      withParams('&bytestart=0&byteend=65535'),
      withParams('&bytestart=65536&byteend=131071'),
      withParams('&bytestart=900000&byteend=999999&_nc_gid=different'),
      withParams('&oh=00_AfDifferentSignature&oe=68B99999'),
    ];
    const keys = new Set(requests.map(dedupeKey));
    assert.equal(keys.size, 1, `expected one row, got ${keys.size}`);
  });

  test('two different clips stay apart', () => {
    const other = base.replace(BLOB, 'AQOB6BKJRwmFudItVrh0vk0a1mV4Arh6M');
    assert.notEqual(dedupeKey(withParams('')), dedupeKey(`${other}?oh=00_Af`));
  });

  test('the CDN token is recognised as no name at all', () => {
    assert.equal(looksOpaqueName(`${BLOB}.mp4`), true);
    assert.equal(looksOpaqueName('AQOB6BKJRwmFudItVrh0vk0a1mV4Arh6M_psFVYjptiv475yADDLKslv'), true);
    assert.equal(looksOpaqueName('3f8a91c4b7e25d06a1f3c8b9e4d7a250'), true);
    assert.equal(looksOpaqueName('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), true);
  });

  test('a real filename is left alone', () => {
    // The page title must not replace a name that already means something.
    assert.equal(looksOpaqueName('Big Buck Bunny 1080p.mp4'), false);
    assert.equal(looksOpaqueName('annual-report-2026.pdf'), false);
    assert.equal(looksOpaqueName('ubuntu-24.04-desktop-amd64.iso'), false);
    assert.equal(looksOpaqueName('S01E02.mkv'), false);
    assert.equal(looksOpaqueName('song.mp3'), false);
  });

  test('shared endpoint names count as no name', () => {
    // Short enough to slip past the length checks, and every file on the site
    // shares them.
    for (const n of ['videoplayback', 'watch', 'index.m3u8', 'master.mpd', 'download']) {
      assert.equal(looksOpaqueName(n), true, n);
    }
  });
});
