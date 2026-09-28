---
name: vid-engine-user-guide
description: Load when helping someone install, integrate, or use exact-video-engine.js in an app — setting up playback with createBestEngine, calling any engine API member, handling UnplayableClipError, showing indexing progress, or tuning indexing/memory options. Covers usage from the outside, not the engine's internals.
---

# Using exact-video-engine.js

This library plays video in the browser with exact frame indices. It hands
back one of two engines behind the same interface: `VideoEngine` (WebCodecs —
decodes every frame itself, paints onto a canvas it owns) or
`NativeVideoEngine` (a real `<video>` element, kept frame-exact by a per-frame
timestamp table read from the container). `createBestEngine()` picks per clip
and browser; hosts hold either engine in the same variable and never branch on
which they got.

The one rule to keep in mind throughout: **every frame number the engine
reports is exact, and a clip whose frames cannot be named exactly is refused
with a clear error.** There is no approximate mode.

## Installation

### From a `<script>` tag

```html
<!-- mp4box.js must be loaded first to index MP4s (it provides the MP4Box and
     DataStream globals). WebM/MKV, Ogg and AVI indexing are built in. -->
<script src="https://unpkg.com/mp4box@0.5.2/dist/mp4box.all.min.js"></script>
<!-- Pin an exact release tag; never reference a branch (jsDelivr caches
     branch refs for hours, so @main changes behavior unpredictably). -->
<script src="https://cdn.jsdelivr.net/gh/jasper-tms/exact-video-engine.js@v2.8.0/exact-video-engine.js"></script>
```

`exact-video-engine.js` is a classic script: it defines globals
(`createBestEngine`, `VideoEngine`, `NativeVideoEngine`, `ContainerIndex`, …)
and exports nothing.

### From a bundler

```sh
npm install exact-video-engine.js mp4box
```

```js
// mp4box is a PEER dependency, and installing it is necessary but not
// sufficient: this engine reads it off the global scope, so put it there
// before indexing any MP4 or MOV. WebM/MKV, AVI and Ogg need none of this.
import * as MP4Box from 'mp4box';
globalThis.MP4Box = MP4Box;
globalThis.DataStream = MP4Box.DataStream;

import { createBestEngine } from 'exact-video-engine.js';
```

`index.mjs` re-exports `createBestEngine`, both engines, `ContainerIndex`, the
range readers (`UrlRangeReader`, `FileRangeReader`), `formatProgress`, the
decode-support predicates (`detectBrowserEngine`, `isTenBitHevc`,
`webCodecsMayFailMidStream`, `describeCodec`), and the error classes a host
branches on (`UnplayableClipError`, `UNPLAYABLE_REASONS`,
`IndexBudgetExceededError`, `CertifiedPrefixViolationError`). Everything after
installation is identical on both paths.

## Basic playback

Give `createBestEngine` both a `<canvas>` and a `<video>` element, then show
whichever one the returned engine actually presents into:

```js
const engine = await createBestEngine(source, { canvas, video });

for (const element of [canvas, video]) {
  element.style.display = (element === engine.displayElement) ? '' : 'none';
}

// Drive the engine from your requestAnimationFrame loop. NativeVideoEngine's
// update() is a no-op (the element runs its own clock), so call it
// unconditionally.
function tick(now) {
  engine.update(now);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

engine.play();
```

`source` is either a URL string — the server must answer HTTP Range requests
with `206` — or a `File`/`Blob`.

The loop above keeps calling `update()` while paused, which is the common
setup and the one that gets everything. If instead you stop ticking when
paused, playback and seeking are unaffected — a seek reads what it needs on the
spot — but one small optimization goes quiet: when the playhead has sat still
for half a second, `VideoEngine` reads the next block ahead in the background so
the next `play()` starts from bytes already in hand. A host that parks its rAF
loop while paused simply skips that head start and fetches on `play()` instead.

To use `VideoEngine` alone (no fallback), construct it with the canvas and
call `load(source)`. `NativeVideoEngine` likewise takes the `<video>` element.

## Handling refusals: `UnplayableClipError`

`createBestEngine` throws rather than play a clip it would have to guess
about. The error is a plain `Error` (so `catch (error) {
show(error.message) }` works unchanged) carrying machine-readable fields:

```js
try {
  engine = await createBestEngine(file, { canvas, video });
} catch (error) {
  if (error.reason === 'codec-not-decodable') {
    offerReEncode(error.codecName, error.suggestion);   // "MPEG-4 Part 2", an ffmpeg line
  } else {
    show(error.message);
  }
}
```

`reason` is one of `UNPLAYABLE_REASONS`:

- `container-not-indexable` — not MP4/MOV, WebM/MKV, Ogg, or AVI (HLS/MPEG-TS,
  live streams, raw elementary streams), or an indexing pass that ran out of
  its budget before naming a single frame.
- `codec-not-decodable` — the container indexed fine but nothing in this
  browser can decode the codec (for example MPEG-4 Part 2 outside Safari, or
  an AVI codec WebCodecs rejects — AVI has no native `<video>` fallback).
- `no-fallback-element` — the clip needed the native path but no `<video>`
  element was provided.
- `no-presented-frame-clock` — the clip must play natively but the browser
  lacks `requestVideoFrameCallback` (only genuinely outdated browsers).
- `timeline-unmappable` — the container's table disagrees with what the
  element actually presents (a trimming edit list the browser mis-times, a
  truncated file), caught at load.

Alongside `reason`, whichever of these are known: `codec`, `codecName`,
`containerFormat`, `numFrames`, `triedWebCodecs`, `webCodecsMessage`,
`nativeErrorCode`, `nativeErrorMessage`, and `suggestion`. A field that is not
known is absent rather than null, so `'codec' in error` means what it says.
`error.message` is composed by the library and is the same for the same file
in every browser — show it; log `nativeErrorMessage` (the browser's own text)
rather than showing or parsing it. `describeCodec()` is exported for a host
writing its own wording.

## API reference

Both engines expose the following.

| Member | Description |
| --- | --- |
| `load(source, {index})` | Load a URL string or File/Blob. `index` is an optional prebuilt `ContainerIndex`. |
| `play()` / `pause()` / `paused` | Transport. |
| `update(now)` | Call once per animation frame with the rAF timestamp. Advances the playhead and paints (`VideoEngine`); a no-op on `NativeVideoEngine`. |
| `loop` | Whether playback wraps at the end. |
| `loopStartFrame` / `loopEndFrame` | Optional inclusive frame bounds of a **loop region** — the span looping playback repeats instead of the whole clip. `loopEndFrame` is the last frame played before wrapping; the wrap lands on `loopStartFrame`. `null` (the default) means the clip's own first/last frame. See "Looping a sub-range" below. |
| `playbackRate` | Playback speed multiplier. |
| `duration` | Clip duration in seconds. While `frameIndexState` is `growing` this is the length indexed *so far*, rising with `numFrames`. |
| `expectedDuration` | The whole clip's length in seconds as the container *declares* it; `0` when the container declares none. What to size a scrubber against while the index grows. A claim, never a mapping input — it names no frame. |
| `numFrames` | Frame count. Grows while `frameIndexState` is `growing`. |
| `currentFrame` | Integer playhead frame index: where `seekToFrame`/playback has aimed the playhead. On `NativeVideoEngine` this is already clamped to what has been presented; on `VideoEngine` it lands the instant you seek, ahead of the decode — use `presentedFrame` to know what is actually on screen right now. |
| `presentedFrame` | Integer frame index actually painted onto the canvas/element right now. `-1` until a first frame has presented. Diverges from `currentFrame` on `VideoEngine` for as long as a seek's target frame is still decoding. Compare against the frame you asked for to know whether a seek has landed on screen. |
| `currentFrameFloat` | Continuous playhead in frame units (index + fraction of the frame's display interval) — drive synchronized/interpolated overlays from this, never from `currentTime * frameRate`. |
| `currentTime` | Playhead in seconds (get/set), with display frame 0 at t = 0 in both engines. |
| `seekToFrame(n)` | Land on display frame `n`. |
| `frameAtTime(t)` | Display frame index on screen at time `t`. |
| `ensureFrame(n)` | Async: resolves once frame `n` is decoded (`VideoEngine`) or once the element has settled on it (`NativeVideoEngine`). |
| `videoWidth` / `videoHeight` | Upright dimensions in **stored** pixels (rotation applied), the same on both tiers. Annotate in this coordinate space. For an anamorphic clip this is not the shape it is shown at; see `pixelAspectRatio`. |
| `pixelAspectRatio` | Width ÷ height of one upright stored pixel: 1 for ordinary square-pixel video, otherwise the container's declared pixel shape (see "Anamorphic clips" below). The picture is meant to be seen `videoWidth × pixelAspectRatio` wide by `videoHeight` tall. |
| `rotation` | The track's display rotation in degrees: 0, 90, 180, or 270. Informational — both engines already present upright. |
| `displayElement` | The canvas or `<video>` the engine presents into. |
| `tier` | What this engine got, e.g. `webcodecs` or `native (container index, presented clock)`. Useful for a dev label. |
| `frameIndexIsExact` | True on every engine `createBestEngine` returns. Goes false only if the runtime watcher later catches the table disagreeing with the frames actually presented, alongside a fatal `errormessage`. |
| `frameIndexState` | `complete` (the ordinary case), `growing` (the index is still being built and `numFrames` is still rising), or `truncated` (the pass stopped early; what is here is final, the rest of the clip is not coming). `VideoEngine` only — the native path refuses a growing index. |
| `waitingForIndex` | True while playback is pinned at the last indexed frame waiting for the index to catch up. A stall on the indexer, not the end of the clip, so `loop` does not fire. |
| `rebuffering` | True while playback is buffering — the picture held on the last frame, `playing` still true, resuming on its own once enough is buffered ahead. Bind a spinner to it. On `VideoEngine` the engine holds its own clock (see `rebufferSeconds`); on `NativeVideoEngine` it observes the `<video>` element's own buffering. Distinct from `waitingForIndex` (pinned on the indexer) and `paused` (the host stopped playback). |
| events `indexextended` / `indexcomplete` / `indextruncated` | The index published more frames, finished, or stopped early. `indextruncated` also emits a fatal `errormessage`. |
| `codecString` | The clip's codec string as the container declares it (e.g. `hvc1.2.4.L123.b0`), or null when the index carries no decoder configuration (Ogg, or a Matroska codec the engine does not configure). Lets a host predict format trouble — flagging 10-bit profiles for server-side conversion, say. `mjpeg` is this library's own marker for Motion JPEG clips (WebCodecs registers no string for it). |
| `failed` | True once the engine can no longer stand behind its output: an unrecoverable `VideoDecoder` error (`VideoEngine`), the container index caught disagreeing with the presented frames during playback (`NativeVideoEngine`), or the source's bytes no longer readable (either engine; see "When the source disappears"). Each also emits a fatal `errormessage`. |
| `destroy()` | Release resources when done (decoders are a limited browser resource). |
| `resizeCanvas()` | Re-size the canvas backing store to its parent and repaint (`VideoEngine`); a no-op on `NativeVideoEngine`, where CSS `object-fit` handles it. `update()` already does this every tick, so you rarely need to call it — a pane that gains its size *after* the clip loads is handled without you having to get the timing right. |
| event `loaded` | Fired when `load()` completes. |
| event `errormessage` | `detail.message`: human-readable error string, or null to clear. See "When the decoder dies mid-playback" and "When the source disappears" below for the `fatal: true` cases. |

### Looping a sub-range: `loopStartFrame` / `loopEndFrame`

To loop part of a clip rather than all of it, name the region's bounds:

```js
engine.loopStartFrame = 1457;   // wraps land here
engine.loopEndFrame   = 2004;   // last frame played before wrapping
engine.loop = true;
engine.seekToFrame(1457);       // the engine does not seek for you
```

Frames, not seconds: a frame index names exactly one frame and a timestamp does
not. A host holding a time converts with `frameAtTime(t)`.

Three rules make the region behave the way a viewer expects:

- **Only while `loop` is true.** With looping off the bounds are inert and
  playback runs to the end of the clip, so a loop toggle keeps working as a
  plain loop toggle.
- **Seeking is never bounded by it.** `seekToFrame` outside the region is
  honored — the region says where playback *repeats*, not where it is allowed.
- **A seek past `loopEndFrame` plays on to the end of the clip**, and the wrap
  from there lands on `loopStartFrame`. Only a playhead that reaches the
  region's end by playing forward wraps early, so clicking into the tail of a
  clip does not yank you back the instant you land.

Setting neither (the default) is ordinary whole-clip looping.

**The wrap is frame-exact on `VideoEngine` only.** On `NativeVideoEngine` the
frame it lands on can be one late on Chromium and Firefox — those browsers
resume a mid-interval seek on the frame *after* the target, which the library
cannot override from outside the element. WebKit lands exactly, which is the
tier that matters most in practice: the native engine is the fallback for
browsers with no `VideoDecoder` (pre-16.4 iOS Safari). A host that needs the
region's bounds honored to the frame should check `tier`.

### Anamorphic clips: `pixelAspectRatio`

Some clips store pixels that are meant to be shown non-square. HandBrake's
automatic anamorphic output, DV and some broadcast masters do this. For
example, a HandBrake encode may store 1472 × 1080 with pixels 0.544 as wide as
they are tall, so it is meant to be seen at about 801 × 1080. The engine
reads the pixel shape from the container (MP4 `pasp`, Matroska
DisplayWidth/DisplayHeight, Theora's header) and keeps two things apart:

- `videoWidth` / `videoHeight` count the **stored** pixels (1472 × 1080), on
  both tiers. Coordinates in this space name real pixels of the file, the same
  ones Python or ffmpeg decode.
- `pixelAspectRatio` (0.544 here) says how to show them.

Both tiers *present* the clip at its display shape by default, the way any
player does. A host that composites the engine's canvas into its own
`videoWidth × videoHeight` rectangle and applies the pixel shape itself, such
as an annotation tool whose stage is in stored pixels, passes
`applyPixelAspectRatio: false` to `createBestEngine` (or the `VideoEngine`
constructor). The canvas is then letterboxed at the stored shape, so a pane
sized `videoWidth × videoHeight` is filled one stored pixel per pane pixel. The
`<video>` tier always shows the display shape; drawing that element with
`drawImage(video, x, y, videoWidth, videoHeight)` gives the stored shape
either way.

### Named-frame pixels: `bitmapForFrame(n)`

`VideoEngine` additionally has `bitmapForFrame(n)`, the decoded `ImageBitmap`
for a frame (coded orientation, stored pixels one for one even for an
anamorphic clip, possibly downscaled to 1920 on the long side — apply
`rotation` and `pixelAspectRatio` yourself). `NativeVideoEngine` has no equivalent: a `<video>`
element cannot hand back a frame you can name. Hosts that need pixels should
check `tier` first — which clips reach the WebCodecs engine depends on the
browser as well as the container.

This is also how you use `VideoEngine` with no UI at all — to pull a thumbnail
out of a video someone is uploading, say. Hand it a canvas that is not in the
document; with no pane to size itself to, it leaves the canvas alone and
paints nothing, and you take frames from `bitmapForFrame(n)` after
`ensureFrame(n)`.

## Indexing budgets and progress

A classic MP4 indexes from a handful of range reads, instantly, however long
the clip. WebM/MKV, fragmented MP4, and Ogg require a sequential pass over the
whole file (their timestamps live next to the frames), so that pass takes a
deadline and an optional byte ceiling:

```js
const engine = await createBestEngine(source, {
  canvas, video,
  indexTimeoutMilliseconds: 10000,   // default; Infinity to let it always finish
  indexMaxBytes: Infinity,           // refuse outsized files before reading them
});
```

A clip that blows through the budget is refused rather than making the host
wait forever or play with guessed frame numbers; raise or remove the budget to
accept the wait. A finished pass is cached in IndexedDB per clip per machine
(identity is proven from `(name, size, lastModified)` for a `File`, or URL +
size + strong validator for a URL; anything doubtful is a rebuild), so the
cost is paid once. The pass yields to the event loop as it goes, so it cannot
freeze the page.

The full-file pass can report progress. Pass an `onProgress` callback and it
is called about once per megabyte, and once more at 100% when it finishes:

```js
const engine = await createBestEngine(source, {
  canvas, video,
  onProgress: (p) => {
    // p = { bytesRead, totalBytes, fraction, elapsedMs, etaMs, framesFound }
    bar.style.width = `${p.fraction * 100}%`;
    label.textContent = formatProgress(p);   // "Indexing… 42% (~8s left)"
  },
});
```

`etaMs` is estimated from the average rate so far (0 at the very start and the
end, so hide the ETA until a few percent in if you like). A throw from the
callback is swallowed, so a broken indicator can never abort a load. A classic
MP4 emits no ticks — drive a spinner's visibility off the `createBestEngine`
promise and let `onProgress` fill in the full-file passes.

## Playing while the index is still being built

Set `playWhileIndexing` and the full-file pass hands back a playable engine as
soon as enough of the clip has been indexed to be worth showing, and keeps
indexing the rest underneath it:

```js
const engine = await createBestEngine(source, {
  canvas, video,
  playWhileIndexing: true,
  minimumIndexedFramesBeforePlayback: 30,   // default
});

engine.frameIndexState;   // 'growing' | 'complete' | 'truncated'
engine.numFrames;         // rises as the pass goes on
engine.addEventListener('indexextended', () => scrubber.value = engine.numFrames - 1);
engine.addEventListener('indexcomplete', () => scrubber.classList.remove('partial'));
engine.addEventListener('indextruncated', () => {
  // The pass stopped early. What is here is final and correct; the rest of
  // the clip is not coming. engine.numFrames will not rise again.
});
```

The guarantee: **every frame number the engine reports is exact and
permanent; the set of frames it is willing to report grows.** A frame is
published only once no frame still to be read can present before it, so an
annotation written against frame 412 can never come to mean a different
picture. If the pass later dies (a budget, a dropped connection, a corrupt
tail), the frames already published stay, the index moves to `'truncated'`,
and the host is told.

To size a scrubber against the whole clip rather than a track that stretches
under the cursor, use `engine.expectedDuration` — the length the container
declares. Scale it into frames by the mean rate of the part already indexed if
the scrubber counts frames, and clamp seeks to `numFrames`: the projection is
geometry, and the frames it implies are not named yet.

Two deliberate limits. It is **off by default**, because a growing
`numFrames` is not what existing callers expect. And it applies **only to the
WebCodecs tier** — the native path refuses a growing index, because a
`<video>` element plays the whole clip whether or not its frames are named
yet. The WebCodecs engine instead holds the playhead at the last indexed frame
(`waitingForIndex` true) until the index catches up.

## Tuning read-ahead and memory

`VideoEngine` decodes a window around the playhead so that playback and short
seeks come out of memory. The frame you actually asked for is never held up by
it: `load()` and `ensureFrame(n)` fetch what that one frame needs and resolve,
and the window fills behind them.

- **A host that only ever holds still** — an offscreen thumbnail grab, a page
  that shows one frame — can turn read-ahead off: `windowAhead: 0` (as a
  `createBestEngine` option or a `VideoEngine` constructor option). The frame
  you ask for is still decoded; the engine just stops there. The default (56
  frames, about two seconds) is what you want for anything that plays. At the
  other extreme, `windowAhead: Infinity` reads as far ahead as `cacheBytes`
  allows, so the byte ceiling becomes the only limit.
- **History behind the playhead** is `windowBack` (default 18 frames), the
  mirror of `windowAhead`: frames kept resident so a backward scrub finds them
  decoded instead of re-decoding from a keyframe. `Infinity` likewise means
  "hold as much history as `cacheBytes` allows".
- **The memory ceiling is bytes, not frames**: `cacheBytes` (default 96 MB).
  At the default, a 360p clip keeps the full 56-frame read-ahead while a 1080p
  clip holds about a dozen frames — far enough under the ceiling to leave the
  decoder its surfaces (iOS kills the decode session outright if decoded frames
  exhaust its surface pool). A dozen frames is only a fraction of a second of
  cover, so it is not what absorbs network latency: the *encoded* bytes are
  read ahead separately, in 4 MB blocks with the next block always in flight
  during playback, on a budget of their own that `cacheBytes` does not touch.
  Lowering it shrinks read-ahead first and history second; it never changes
  which frames are *available*, only how many are held in memory at once.
  `engine.setCacheBytes(bytes)` changes the ceiling at runtime (a no-op on the
  native tier, which has no addressable frame cache) — turn it down on a
  low-memory warning and back up when there is room.
- **Buffering instead of dropping frames**: when a frame is not decoded in time,
  `VideoEngine` holds its clock on the last frame and waits — the buffering pause
  of an ordinary online player — rather than running the clock on and dropping
  frames. It resumes once `rebufferSeconds` (default 0.3 s) of upcoming content
  is buffered ahead of the playhead, and `rebuffering` is true meanwhile (bind a
  spinner to it). `rebufferSeconds: 0` turns the hold off, so the clock never
  waits for the decoder. A machine that simply cannot decode the clip in real
  time would buffer endlessly, so after a few holds in a row it concedes and
  plays on at real time, dropping frames, until decode has kept up again. The
  option is `VideoEngine`-only — the native `<video>` tier buffers on its own.

```js
const engine = await createBestEngine(source, { canvas, video, windowAhead: 0 });
new VideoEngine(canvas, { cacheBytes: 32 << 20, rebufferSeconds: 0.5 });
```

## When the decoder dies mid-playback

Some decoders pass `isConfigSupported()`, decode frame 0, and then die once
sustained decoding starts — after `load()` resolved, so past
`createBestEngine`'s load-time fallback. When that happens the engine emits an
`errormessage` event whose detail carries `fatal: true` plus diagnostics
(`errorName`, `codec`, `frame`), and will never produce another frame for the
clip. A host that can fall back should respond by rebuilding:

```js
engine.addEventListener('errormessage', ({ detail }) => {
  if (!detail.fatal || detail.incomplete || detail.sourceUnavailable) return;
  rebuildWith(createBestEngine(source, { canvas, video, prefer: 'native' }));
});
```

A fatal event with `incomplete: true` (an index that stopped early) or
`sourceUnavailable: true` (below) is not a dead decoder, and rebuilding does
not help it.

The best-known such combination (10-bit HEVC on WebKit) is headed off before
it happens — `createBestEngine` routes it straight to the `<video>` element —
so this event is the net for combinations not yet in that table. For which
codecs decode where, load the **vid-engine-format-support-per-browser** skill next
to this one.

## When the source disappears

A clip's bytes are read on demand for as long as it plays, so a local file
moved, renamed, deleted, or modified after it was picked — or a URL that stops
answering — breaks playback partway through. Either engine then sets `failed`
and emits one `errormessage` with `fatal: true` and `sourceUnavailable: true`,
and stops reading. A File fails on the first failed read. A URL is retried
with backoff for about seven seconds first, so a network blip recovers on its
own. Alongside `message` and `frame`, the detail carries `errorName` and
`sourceErrorMessage` when the failing read supplied them (`NotFoundError` for
a moved file, for example), or `nativeErrorCode` / `nativeErrorMessage` when
the `<video>` element reported the failure.

Rebuilding the engine on the same source would only fail again. Ask the person
to open the file again, and load that instead:

```js
engine.addEventListener('errormessage', ({ detail }) => {
  if (detail.sourceUnavailable) offerToReopen(detail.message);
});
```

## Building an index without an engine

`ContainerIndex.fromSource(source, {timeoutMilliseconds, maxBytes})` builds
the frame table on its own, for hosts that want the timestamps without an
engine. It sniffs MP4 vs Matroska vs Ogg vs AVI from the bytes, and reports
which it found in `containerFormat` and whether the result is rich enough to
decode from in `supportsWebCodecs`. A prebuilt index can be handed to either
engine via `load(source, {index})`.
