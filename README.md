# IDM-Next

A cross-platform download manager with a Chrome/Brave extension that spots audio,
video and downloadable files on any page and offers to grab them.

IDM's value is narrow and specific: **multi-connection segmented transfer**,
**pause/resume that survives a crash**, **browser integration that takes over
downloads and sniffs media**, and **queues**. This implements those, on
macOS/Windows/Linux, with the parts that are genuinely hard done carefully.

```
idm-next/
  core/        the download engine — no UI, no server, tested standalone
  app/         Electron: main process (tray, clipboard, local server) + React UI
  extension/   MV3 — one build, loads in both Chrome and Brave
```

## Running it

```bash
npm install
npm test           # 179 tests across core, app and extension
npm start          # build and launch the desktop app
npm run dist       # package a .dmg / .nsis / .AppImage
npm run bench -w core   # measure download throughput
```

`yt-dlp` and `ffmpeg` are optional — without them direct file downloads work
fine, and only page/stream downloads are unavailable. Settings tells you which
it found.

### Loading the extension

1. Start the desktop app first — the extension talks to it on `127.0.0.1:47591`.
2. Open `chrome://extensions` (or `brave://extensions`), enable **Developer mode**.
3. **Load unpacked** → select the `extension/` folder.

The extension ID is pinned by a `key` in the manifest, so Chrome and Brave both
derive `nillkncbloeeggoephkkfnafgdnknmel` and the app's origin allowlist works
without any configuration.

## What it does

**Segmented downloading with work stealing.** N connections, each owning a byte
range. A worker that finishes takes half of the segment with the worst
*estimated time to completion* — not the one with the most bytes left. That
distinction is the whole point: a fast connection with 8 MiB remaining finishes
before a stalled one with 2 MiB, so a bytes-based rule keeps splitting the
healthy connection while the stalled segment holds the download hostage.

**Resume that actually resumes.** A sidecar journal records per-segment cursors,
fsynced before it is written so it can never claim bytes that are not on disk.
On resume the server is re-probed and the ETag compared; a mismatch is surfaced
rather than silently splicing two versions of a file together.

**The floating panel.** A bar pinned over the player — "Download this video" —
that opens a list of every variant found on the page, with "Download all" at the
top, the way IDM's does. One click on the bar takes the highest quality; the
caret opens the full list. Pages whose downloads are documents or archives get
the same panel in the page corner instead.

Quality labels are derived from whatever the page actually exposes: the
`<video>` element's own height, a resolution in the URL, or — on YouTube, where
every rendition comes from the same host — the `itag`, without which the list
reads "MP4 file" five times over.

**Media detection.** The extension watches response headers for video, audio,
HLS and DASH content types and scans the DOM for `<video>`/`<audio>`.

Two details decide whether this works at all on a streaming site. A player
fetches media in small ranged chunks, so `Content-Length` describes the chunk
and not the file — the size floor has to read the total from `Content-Range` or
it rejects every real video for being too small. And an attachment only counts
as a download if it actually names a file: subtitle and telemetry endpoints are
served with `Content-Disposition: attachment` and would otherwise fill the panel
with 1 KB JSON while the video went missing.

**Knowing when sniffing has nothing to offer.** A sniffed entry is worth
listing only if it has a name, a size or a quality. On a CDN-backed site it
often has none of the three: the name is a signed token, the page title is just
"Instagram", and the size is unknowable because the player requests byte ranges
as query parameters, so no `Content-Range` ever arrives. Rather than present
ten identical rows as a choice, the panel shows the quality list from page
extraction — which has all three — and keeps the raw files behind one line.

**Naming what it found.** CDNs name media with signed opaque tokens —
Instagram's look like `AQMOZ1cfHZuJEuODZ770FSIURCg9L7NMAYjQnJSRDfdCrj4lFYNqzU`
— so the panel falls back to the page's own title whenever the filename would
tell the user nothing. Deduplication keeps only the parameters that identify
*which* file is being requested and discards the rest, because a CDN URL is
mostly signature and routing: one Instagram clip arrived as thirty-seven
requests differing only in `oh`, `oe` and a byte range.

**Picking a quality.** The panel lists one complete choice per resolution —
1080p, 720p, 480p — with its size, and every one plays with sound. That is not
free: above 720p YouTube publishes video and audio as separate formats, so a
list built straight from yt-dlp's `formats` offers "1080p" entries that download
silent. Each choice pairs a video rendition with the best audio track and asks
for the merge.

**When sniffing cannot work.** Modern streaming transports — YouTube's
SABR/UMP above all — multiplex video and audio into one stream requested with a
signed body, so no URL on the page is downloadable on its own. Watching response
headers finds nothing there however long the video plays, and that is by design,
not a bug to fix. The panel says so and offers page-level extraction through
yt-dlp instead, which is the route that works. When a response is turned down
for any other reason, the popup lists what arrived and why, because "nothing
detected" is not a diagnosis.

**Download takeover that cannot lose a download.** `chrome.downloads.cancel()`
is irreversible, and a signed or one-time URL 403s when replayed. So the
extension asks the app to probe first and only cancels once the app has proven
it can fetch the file. Otherwise Chrome keeps the download — the correct
outcome, not a failure.

**The rest of the IDM surface:** queues with concurrency limits, category
auto-sorting, global and per-download speed caps, proxy support, cookie/referer
passthrough, clipboard monitoring, checksum verification, a post-download
command hook, and shutdown-when-the-queue-finishes.

**The detail window.** Click any download — or let it open itself as a
transfer starts, the way IDM does — for size, rate, time left, resume
capability, and a table of every connection with its own progress. That last
part is the thing a single progress bar cannot express: each row is one HTTP
connection working its own byte range, and because segments are split by work
stealing the list grows and the shares move while you watch.

## Speed

Multi-connection transfer is the whole point, and it scales close to linearly
against a server that caps each connection — which is what real servers and CDNs
do. Measured with `npm run bench -w core` on a 96 MB file, 6 MB/s per connection:

| Connections | Throughput | vs 1 connection |
|---|---|---|
| 1 | 5.7 MB/s | 1.00× |
| 4 | 22.6 MB/s | 3.92× |
| 8 | 43.9 MB/s | 7.64× |
| 16 | 75.8 MB/s | 13.2× |
| 32 | 139.3 MB/s | 24.2× |

Against an *unthrottled* server the engine sustains roughly 1 GB/s regardless of
connection count, so its own overhead is far below any real network — the
connection count is the lever, not the code.

The default is 16, adjustable per download and in settings, with a ceiling of
32. More is not always better: a server that objects returns `429`, and backing
off one segment would not reduce the pressure while the other connections stay
open. So a `429` or `503` also stops finished workers from opening new
connections for a cooldown, letting concurrency shrink on its own and recover.

## Security

The local control server is not "just localhost":

| Check | Stops |
|---|---|
| Bound to `127.0.0.1` | Anything off-host |
| `Origin` allowlist | Any website you visit driving your downloader |
| Renderer token over IPC | `Origin: null` (file:// **and** sandboxed iframes) |
| `Host` must be loopback verbatim | DNS rebinding |
| POST-only mutations | `<img src>` triggering actions |
| Bounded body drain → 413 | Memory exhaustion, and keep-alive desync |
| Preflight answered, never trusted | A permissive OPTIONS that authorizes nothing |

Cookies captured for a download are held in memory for that download only and
never written to disk.

## Not supported, deliberately

No DRM circumvention (Widevine, PlayReady, FairPlay) and no paywall bypass.
Standard AES-128 HLS, where the key is served in the clear per the spec, is
ordinary playback and works normally.

`yt-dlp` and `ffmpeg` are invoked as external processes, never bundled or
linked, which keeps their GPL out of this project's licensing.

## Tests

```bash
npm test
```

The engine is tested against a deliberately misbehaving HTTP server that can
refuse ranges, lie about `Content-Length`, drop connections mid-stream, return
`429`, throttle one chosen worker to a crawl, and change its ETag between
requests. Assertions are on the finished bytes — SHA-256 against the source —
because that is the only claim that matters.
