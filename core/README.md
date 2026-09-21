# @idm-next/core

The download engine. No UI, no server, no Electron — it runs under plain Node and
is tested on its own.

## What it does

- **Segmented transfer with work stealing.** N connections, each owning a byte
  range. A worker that finishes takes half of the segment with the worst
  *estimated time to completion* — not the one with the most bytes left. A fast
  connection with 8 MiB remaining finishes before a stalled one with 2 MiB, so a
  bytes-based rule keeps splitting the healthy connection while the stalled
  segment holds the download hostage.
- **Crash-safe resume.** A sidecar journal records per-segment cursors. On
  resume the server is re-probed and the ETag / Last-Modified / size compared;
  a mismatch raises `StaleResumeError` rather than silently splicing two
  different versions of a file together.
- **Graceful degradation.** Range support is only believed when the server
  proves it with a `206` plus a parseable `Content-Range`. Anything less falls
  back to a single stream.
- **Rate limiting** via hierarchical token buckets (one global, one per
  download), and **retry** with jittered exponential backoff that honours
  `Retry-After`.
- **Path safety.** Server-supplied filenames are sanitized for traversal,
  control characters, Windows reserved names, and length before they become a
  path.

## Usage

```ts
import { Download } from '@idm-next/core';

const dl = new Download({ url, destDir: '~/Downloads', connections: 8 });
dl.on('progress', (p) => console.log(p.downloaded, '/', p.totalSize));
dl.on('done', ({ filePath }) => console.log('saved', filePath));
await dl.start();

await dl.pause();   // idempotent; resolves once the pause is durable on disk
```

`status` flips to `paused` immediately so workers stop, but the pause is not on
disk until the promise resolves — await it when durability matters, such as on
app quit.

## Tests

```bash
npm test
```

The suite runs against a deliberately misbehaving fixture server that can refuse
ranges, lie about `Content-Length`, drop connections mid-stream, return `429`,
throttle a chosen worker to a crawl, and change its ETag between requests.
Assertions are on the finished bytes (SHA-256 against the source), because that
is the only claim that matters.
