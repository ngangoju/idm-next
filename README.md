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
npm test           # 124 tests across core, app and extension
npm start          # build and launch the desktop app
npm run dist       # package a .dmg / .nsis / .AppImage
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

**Media detection.** The extension watches response headers for video, audio,
HLS and DASH content types, scans the DOM for `<video>`/`<audio>`, and puts a
"Download this video" button on the player. Detections are deduplicated (a
seeking player fires dozens of near-identical requests) and filtered by a size
floor so ad beacons don't fill the list.

**Download takeover that cannot lose a download.** `chrome.downloads.cancel()`
is irreversible, and a signed or one-time URL 403s when replayed. So the
extension asks the app to probe first and only cancels once the app has proven
it can fetch the file. Otherwise Chrome keeps the download — the correct
outcome, not a failure.

**The rest of the IDM surface:** queues with concurrency limits, category
auto-sorting, global and per-download speed caps, proxy support, cookie/referer
passthrough, clipboard monitoring, checksum verification, a post-download
command hook, and shutdown-when-the-queue-finishes.

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
