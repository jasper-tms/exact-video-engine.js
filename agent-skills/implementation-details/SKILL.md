---
name: implementation-details
description: Load before reading, explaining, or modifying any of exact-video-engine.js's internals — container indexing, engine selection and refusals, progressive indexing, native-tier frame exactness, performance strategy, or the test suite's design. Answer "how does the engine do X" from here, not from code inspection alone. Routes to one topic file per subject.
---

# exact-video-engine.js implementation details

The engine hands back one of two players behind one interface: `VideoEngine`
(WebCodecs — demuxes and decodes every frame itself, paints onto a canvas on a
clock it owns; *authoritative*) and `NativeVideoEngine` (a real `<video>`
element; *observational* — the browser decides which frame is on screen and
the engine finds out through `requestVideoFrameCallback`). Both are kept
frame-exact by the same `ContainerIndex`: a table of every frame's
presentation timestamp, read from the container without decoding anything.
`createBestEngine()` picks per clip and browser, and refuses (with
`UnplayableClipError`) any clip it cannot be exact about.

Source layout, one module per concern: `src/range-readers.js` (random-access
byte reading), `src/container-index.js` (the table; MP4 via mp4box),
`src/matroska.js`, `src/ogg.js`, `src/avi.js` (the built-in container scans),
`src/image-frame-decoder.js` (Motion JPEG), `src/frame-reorder-bound.js` and
`src/certified-prefix.js` (progressive indexing), `src/index-cache.js`
(IndexedDB), `src/video-engine.js`, `src/native-video-engine.js`,
`src/create-best-engine.js` (the ladder), `src/decode-support.js`,
`src/unplayable-clip.js`. The root `exact-video-engine.js` is generated from
these — edit `src/`, never the root file (see DEVELOPING.md at the repo root).

Open the topic file for the subject you are working on:

- **[indexing.md](indexing.md)** — how each container format (MP4, fragmented
  MP4, WebM/MKV, Ogg, AVI) is turned into the frame table; codec-string
  derivation; the rescued `jpeg` and `mp4v` sample entries; Motion JPEG
  decoding; the IndexedDB index cache and its identity rules.
- **[decode-ladder.md](decode-ladder.md)** — how `createBestEngine` chooses an
  engine, the full refusal taxonomy behind "index or refuse", how
  `UnplayableClipError` messages are composed, and the 10-bit-HEVC-on-WebKit
  pre-routing.
- **[progressive-indexing.md](progressive-indexing.md)** — `playWhileIndexing`:
  the certified-prefix rule, the per-codec frame-reorder bounds that prove a
  frame's index is final, and why the feature is WebCodecs-only.
- **[native-engine-exactness.md](native-engine-exactness.md)** — how the
  `<video>` fallback stays frame-exact: `mediaTime` → index mapping, timeline
  calibration, edit-list handling, and the runtime disagreement watcher.
- **[performance.md](performance.md)** — the startup read strategy (round
  trips, speculative first read), the decode read-ahead window, and the
  bytes-not-frames memory ceiling.
- **[testing.md](testing.md)** — what each test pins, why the fixture clips
  are shaped the way they are, and what would silently pass without each case.

For which codecs each backend can actually decode per browser (tested, not
inferred), load the sibling **video-format-support-per-browser** skill instead of
answering from code.
