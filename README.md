# exact-video-engine.js

Frame-perfect video playback for the browser, on WebCodecs where it is
available and on a `<video>` element where it is not — without giving up exact
frame indices in the fallback.

## Why

A native `<video>` element is not frame-accurate:

- Playing via `play()` stochastically drops a frame near the start (the
  browser's compositor swallows roughly one inter-frame interval while the
  media clock spins up).
- Its `currentTime` → frame-index mapping drifts on non-integer frame rates
  (29.97 fps) and is undefined on variable-frame-rate clips.
- After a programmatic seek, there is no reliable way to read back which frame
  is actually displayed.

`VideoEngine` instead demuxes the MP4 container with
[mp4box.js](https://github.com/gpac/mp4box.js), decodes every frame itself with
a WebCodecs `VideoDecoder`, and presents frames onto a canvas on a clock it
owns. Anything the host renders in sync with the video — a 3D overlay, an
annotation layer — reads the playhead from the same object that paints the
pixels, so it cannot drift from the frame on screen. The engine is
*authoritative*: it decides which frame is displayed.

But WebCodecs is not always there, it cannot play every clip, and it has no
audio. So there is a second engine.

## Two engines, one surface

`NativeVideoEngine` plays through a real `<video>` element and exposes the same
members, so a host can hold either engine in the same variable and never branch
on which it got. It is *observational*: the browser decides which frame is on
screen and the engine finds out afterwards, through
`requestVideoFrameCallback`.

Being observational costs you the guarantees in the "Why" section above — a
dropped startup frame stays dropped. What it does **not** have to cost you is
knowing *which* frame is on screen, and that is the part most fallbacks get
wrong.

The insight is that `requestVideoFrameCallback`'s `mediaTime` **is** the
presented frame's exact presentation timestamp. It is not an estimate. What a
`<video>` element withholds is not the timestamp but the *table* of every
frame's timestamp, without which a timestamp cannot be turned into a frame
*index* — so the usual fallback multiplies by an assumed constant frame rate and
quietly mismaps every variable-frame-rate clip.

That table can be read straight out of the container, with nothing decoded.
`ContainerIndex` builds it — from the `moov` for MP4 (mp4box.js, a few range
requests), by scanning the clusters for WebM/MKV, the `moof` fragments for
fragmented MP4, the pages for Ogg, and the `idx1` / OpenDML index for AVI (see
below) — and it is handed to
whichever engine ends up playing. Given it, the `<video>` path binary-searches
`mediaTime` into an exact frame index and is frame-exact on variable-frame-rate
clips.

`createBestEngine()` picks the best combination available for a given clip and
browser:

| | Index from | Presentation | Frame index |
| --- | --- | --- | --- |
| 1. WebCodecs | container (MP4, WebM/MKV, or AVI) | engine-owned canvas | exact |
| 2. `<video>` + index | container (MP4, WebM/MKV, or Ogg) | browser | exact |

Step 2 is the one that usually does not exist. It covers browsers without
WebCodecs (Safari before 16.4, older Firefox), codecs the platform decoder
rejects, Ogg (whose index carries timestamps but no sample table for WebCodecs to
decode from), and any host that needs audio or the battery-friendly hardware
overlay path — none of which have to settle for guessing at frame numbers.

There is no step 3. Every engine this library hands back has a real per-frame
timestamp table; a clip that cannot get one is refused with a clear error.

### Index or refuse

An engine that reports frame numbers it cannot stand behind is worse than no
engine, so there is exactly one rule: every clip we agree to analyze has a real
per-frame presentation-timestamp table, read from the container without
decoding a frame. `createBestEngine` throws — with an error message a host can
show — rather than play a clip it would have to guess about:

- **A container we cannot parse** (HLS/MPEG-TS or other segmented delivery, live
  streams, raw elementary streams, or anything else that is not MP4/MOV,
  WebM/MKV, Ogg, or AVI). No table can exist, so no engine is returned. (An AVI
  whose *codec* this browser cannot decode — uncompressed BI_RGB, MPEG-4 ASP — is
  refused here too: AVI has no native fallback, so an index it cannot decode from
  is useless.)
- **An indexing pass that ran out of its budget** (`indexTimeoutMilliseconds` /
  `indexMaxBytes`, see the WebM and MKV section) before naming a single frame. A
  partial table is a wrong table — unless every frame in it was *certified* as
  final before it was handed out, which is what "Playing while the index is still
  being built" below is about.
- **A browser without `requestVideoFrameCallback`, when the clip must play
  natively.** Even a perfect index cannot say which frame a `<video>` element is
  showing without the presented-frame clock, so the native path refuses rather
  than map frames from raw `currentTime` (which keeps advancing through decoder
  stalls while the picture is frozen). The clock has shipped everywhere current
  — Safari 15.4+, Firefox 132+, any recent Chromium — and the WebCodecs path
  owns its own clock, so this refusal only bites genuinely outdated browsers,
  and only for clips WebCodecs cannot take (Ogg, a Matroska codec we cannot
  configure, or a clip whose codec this browser's `VideoDecoder` rejects).
- **An element that loads the clip's metadata and then never presents a frame.**
  A browser that can demux a container but cannot decode what is inside it
  reports no error at all: it parses the metadata, goes quiet with every byte in
  hand, and simply never produces a picture (WebKit does this with AV1 in WebM).
  With no deadline that is an unbounded wait inside `load()` — a spinner that
  spins forever with nothing to show the user — so the native path gives up after
  ten seconds *of no progress at all*. Bytes still arriving keep rearming the
  deadline, so a slow download is never cut off by it.
- **A container whose table disagrees with what the element actually presents**
  (a trimming edit list the browser mis-times, a truncated file whose tail the
  scan never saw). Caught at load by comparing durations and calibrating the
  timeline, and refused rather than played with shifted numbers.

The same honesty applies after load: each frame the element presents during
playback is checked against the table, and if they sustainedly disagree the
engine latches `failed`, flips `frameIndexIsExact` to false, and emits a fatal
`errormessage` (`detail.inexact: true`) — it never silently degrades. (Post-seek
readbacks are exempt from that check: after a programmatic seek Firefox's
`requestVideoFrameCallback` echoes the seek target rather than the landed
frame's real timestamp, which says nothing about the table.)

### Codecs a browser accepts and then fails on

WebCodecs support tracks the browser *engine*, not the device, and its feature
detection is not always honest. WebKit (desktop Safari and every iOS browser)
answers `isConfigSupported()` = true for **10-bit HEVC** — the iPhone's own HDR
camera format — decodes the first keyframe, and then the decoder dies a second or
two into sustained playback. Both the support check and the frame-0 decode pass,
so the ladder's load-time fallback never sees it and the user gets a hard crash
mid-playback.

`createBestEngine` recognizes that combination up front and routes straight to
the `<video>` element, which decodes the same clip fine (it uses the platform's
own path, not WebCodecs). No crash, no flash, and the container index keeps the
native path frame-exact. This table is deliberately tight — a false positive
needlessly gives up the WebCodecs owned-clock path — so it names only the
combination confirmed to crash, and the `errormessage` `fatal` flag above remains
the reactive net for anything else. The pieces are exported for a host that wants
to make the same prediction itself (flagging an upload for server-side
transcoding, say): `detectBrowserEngine()`, `isTenBitHevc(codecString)`, and
`webCodecsMayFailMidStream(codecString, browserEngine)`.

### WebM and MKV

mp4box only speaks ISOBMFF, so WebM used to land on step 3 and get silently
wrong frame numbers on any clip that was not really constant-frame-rate. It does
not have to: Matroska stores every frame's presentation timestamp in plain sight
(a cluster's timestamp plus each block's signed 16-bit offset from it), so the
engine reads them itself, skipping every block's payload. No decoding, no
dependency.

That pass walks past every block *header*, and a block header is also where the
frame's byte range and its keyframe flag are — so it records those too, and reads
the track's `CodecID` and `CodecPrivate` for a decoder configuration. A WebM or
MKV therefore indexes into the same full decode table an MP4 does, and plays
through WebCodecs: the engine-owned clock, and `bitmapForFrame()` for named-frame
pixels, on containers that used to get neither. For an `.mkv` on Safari or iOS
this is the difference between playing and not: WebKit demuxes no Matroska at
all, so the clip used to be indexed perfectly and then refused by the only
element that could have shown it.

Five codecs get a configuration — H.264, HEVC, VP8, VP9 and AV1 — and the work is
not the sample table but the codec *string*, which must state the profile, level
and bit depth exactly. Each codec keeps them somewhere different (the
`avcC`/`hvcC`/`av1C` in `CodecPrivate`; for VP9, its own first keyframe's
uncompressed header, plus a level computed from the picture size and frame rate),
so every field is read rather than assumed — an over-claimed profile is the same
dishonest yes this library exists to avoid. Anything else in a Matroska file
(MPEG-4 ASP, a VFW-wrapped oddity) yields no configuration and keeps the
frame-exact `<video>` tier it always had. That is the difference from AVI, which
has no such tier and must therefore refuse what it cannot configure.

The catch is that Matroska keeps no central sample table — the timestamps live
next to the frames, and `Cues` indexes only keyframes — so there is no way to
build the table without a sequential pass over the whole file. That is disk-speed
for a local `File` and network-speed for a URL, so the pass takes a deadline:

```js
const engine = await createBestEngine(source, {
  canvas, video,
  indexTimeoutMilliseconds: 10000,   // default; Infinity to let it always finish
  indexMaxBytes: Infinity,           // refuse outsized files before reading them
});
```

A clip that blows through the budget is refused rather than making the host
wait forever or play with guessed frame numbers ("index or refuse" above); raise
or remove the budget to accept the wait, and the index cache below makes sure a
finished pass is only ever paid once per clip per machine. Neither option
affects a classic MP4, which is a handful of range reads however long the clip
is. The pass yields to the event loop as it goes, so it cannot freeze the page.

Because that pass is the one part of opening a clip whose cost grows with the
file, it can report progress. Pass an `onProgress` callback and it is called
about once per megabyte during the WebM scan, and once more at 100% when it
finishes:

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
MP4 emits no ticks — its index is instant — so drive a spinner's visibility off
the `createBestEngine` promise and let `onProgress` fill in the full-file
passes (WebM, fragmented MP4, Ogg).

### Playing while the index is still being built

A progress bar is still a bar. Set `playWhileIndexing` and the WebM pass hands
back a playable engine as soon as enough of the clip has been indexed to be worth
showing, and keeps indexing the rest underneath it:

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
  // The pass stopped early. What is here is final and correct; the rest of the
  // clip is not coming. engine.numFrames will not rise again.
});
```

The rule this keeps is not "index or refuse" relaxed, but restated at the level
it actually holds:

> **Every frame number this engine reports is exact and permanent. The set of
> frames it is willing to report grows.**

Display indices are append-only and immutable. If frame 412 ever came to mean a
different picture once more of the file had been read, a host that had already
written an annotation against 412 would have been handed exactly the silent
off-by-one this library exists to prevent. So a frame is published only once
**no frame still to be read can present before it** — the *certified* prefix.

How far ahead of the playhead that certification runs depends on the codec, and
on what the container proves rather than on what muxers usually do:

- **VP8 and VP9** do not reorder frames for presentation, so storage order *is*
  presentation order and a frame is certified the moment the next one is read.
  Effectively no lag; this is most real `.webm`.
- **H.264 and HEVC** say how far they reorder, in their own sequence parameter
  set, and that beats anything the container knows. H.264 writes
  `max_num_reorder_frames` in the VUI and HEVC writes `sps_max_num_reorder_pics`
  outright; both mean *the greatest number of frames that may precede a frame in
  decode order and follow it in presentation order*, and both are typically 0, 1
  or 2. Read that backwards and it is a watermark: once a frame has N + 1 frames
  at or after its own presentation time already in hand, an unread frame landing
  before it would have to displace all N + 1, which the stream is not allowed to
  do. So the lag is a *handful of frames* rather than a span of time. Where H.264
  writes no VUI at all, the specification's own inference applies — a conforming
  stream can never reorder past its level's decoded-picture-buffer capacity — so
  there is a bound either way.
- **AV1 in Matroska**, and anything whose setup record we cannot read, falls back
  to what the container proves: a block's timestamp is its cluster's plus a
  *signed 16-bit* offset, so the honest bound is that window — 32768 ticks, or
  32.8 seconds at the default 1 ms timestamp scale. A clip shorter than that — or
  one written as a single cluster — certifies nothing early and simply indexes in
  one pass, which is the correct conservative answer rather than a failure.

Both are proofs, so whichever is tighter is the one used. And a stream that
breaks its own declaration is not papered over: a frame arriving before one
already published means the numbers already handed out are wrong, so the clip is
refused outright rather than kept as a shorter index (`CertifiedPrefixViolationError`).

If the pass later dies (a budget, a dropped connection, a corrupt tail), the
frames already published *stay*: they were certified before they went out. The
index moves to `'truncated'`, `numFrames` stops rising, and the host is told.
Nothing is cached in that state — a network hiccup should not become a permanently
short table for that clip.

This works for a **fragmented MP4** as well as for WebM/MKV, and that is the case
it is worth the most for: fMP4 is what a recorder or a CMAF packager writes, so
"just uploaded, want it playing now" is its normal condition. There the reorder
declaration is the only bound available — nothing bounds an unread `moof` the way
the signed 16-bit block offset bounds an unread Matroska cluster — so an fMP4
publishes early exactly when its stream says how far it reorders (H.264 and HEVC,
which is nearly all of them) or cannot reorder at all (VP8, VP9). An AV1
fragmented clip, or an `avc3`/`hev1` track keeping its parameter sets in the
frames rather than in the `stsd`, indexes in one pass as before.

To size a scrubber against the whole clip rather than a track that stretches
under the cursor, use the index's `expectedDuration` — the length the container
*declares* (Matroska's `Info/Duration`), fixed from the first publish, `0` when
the file declares none. It is a claim, so it never names a frame; only the
scanned table does that.

Two things it deliberately does not do. It is **off by default**, because a
growing `numFrames` is not what existing callers expect. And it applies **only to
the WebCodecs tier**: a `<video>` element plays the whole clip whether or not we
have named its frames yet, so it would be asked within seconds which frame is on
screen for a part of the clip that has not been certified. The WebCodecs engine
can hold the playhead at the last indexed frame because it owns the clock — it
does exactly that, rather than looping — and the native path cannot, so it refuses
a growing index outright. Ogg, which has no WebCodecs tier, is unaffected for now.

### Fragmented MP4

A fragmented MP4 (fMP4/CMAF — the shape DASH packagers and some recorders
write) has no central sample table: an `mvex` box in the `moov` announces that
the samples live in `moof` fragments scattered through the file. The engine
detects that and feeds the whole file through mp4box so every fragment's
samples land in the table — still nothing decoded, but a full-file read, so it
takes the same budget, progress reporting, cache treatment, and
`playWhileIndexing` treatment as the WebM scan. A fragmented index is as complete
as a classic one (sample table, decoder configuration), so fragmented clips play
through WebCodecs wherever classic ones do.

### Ogg

Ogg (Theora video) is indexed by the engine's own page scan, `src/ogg.js`,
the same shape as the Matroska scan: a sequential full-file pass reading page
headers and counting frame packets, no decoding, budget and progress and cache
included. Unlike the Matroska scan it stops at the timestamps: an Ogg index
carries no sample table, so Ogg plays only through the `<video>` element — in
browsers that still ship a Theora decoder. There is nothing lost by that, since
no browser's WebCodecs decodes Theora either.

### AVI

AVI (`RIFF`/`AVI `) is indexed by the engine's own RIFF parser, `src/avi.js`,
and is the one container that is **WebCodecs-only, with no native fallback**:
Chromium and Firefox refuse AVI through a `<video>` element outright, and while
some builds of WebKit happen to play it, that is not something to rely on across
browsers. So AVI gets no tier 2, and an AVI index is useless unless it can drive
tier 1 — so an AVI whose codec WebCodecs cannot decode is refused, since there is
nothing to fall back to. (The Matroska scan builds the same shape of table, but
refuses nothing on those grounds: a Matroska codec we cannot configure still has
the `<video>` tier.)

Indexing an AVI does **not** read the whole file: its index (the legacy `idx1`
table, or the OpenDML `indx`/`ix##` hierarchical index that files over ~2 GB use)
enumerates every frame's byte range without touching a frame's payload, so the
parser reads only the header, the index, and the first keyframe (for the H.264
SPS). It still honors the same deadline, byte ceiling, progress reporting, and
cache treatment as the full-file scans, and refuses rather than hangs on a
malformed file — it simply spends far less of the budget in the normal case.

H.264 and Motion JPEG are supported. AVI stores H.264 as an Annex B bitstream,
but the engine does not feed WebCodecs that directly: WebKit's decoder answers
`isConfigSupported()` = true for an Annex-B (no-`description`) config and then
fails the actual decode — a dishonest yes. So the engine configures the decoder
in length-prefixed **AVCC** mode instead (an `avcC` description built from the
first keyframe's SPS/PPS) and converts each frame from Annex B to AVCC before
decoding. AVCC is the form every engine — Chromium, Firefox, and WebKit/Safari —
decodes, so this is the path that works everywhere without leaning on any native
AVI support. Motion JPEG takes the image-frame path below. Uncompressed
(`rawvideo`/BI_RGB) is intentionally out of scope and refused cleanly.

### Motion JPEG

A Motion JPEG clip is a run of complete JPEG images, one per frame — what
webcams, machine-vision and microscope cameras, and older camcorders write, and
much of what sits in a `.avi` on a lab drive.

No browser ships an MJPEG `VideoDecoder`, and none is needed. Every browser has
a JPEG decoder, the container index already gives each frame an exact byte range
and an exact presentation time, and `createImageBitmap` turns one frame's bytes
into something a `VideoFrame` can be built from. So
`src/image-frame-decoder.js` is a `VideoDecoder` in shape — same constructor,
same `configure`/`decode`/`flush`/`reset`/`close`, same `decodeQueueSize` and
`output` callback — and the engine's decode driver uses it without knowing the
difference. Which frames to decode, and when, is the same problem either way.

Two things follow from every frame being independent. `bitmapForFrame()` on
frame 40000 costs one frame's work rather than a whole group of pictures,
because there is no keyframe to walk forward from. And nothing reorders, so
`playWhileIndexing` certifies a frame as soon as it is read.

It works in both containers that carry MJPEG: the `MJPG` FourCC in AVI, and the
`jpeg` sample entry in QuickTime/MP4. (mp4box does not recognize `jpeg` as a
visual sample entry and files such a track under *metadata*, so the engine
recognizes that one case itself rather than accept "no video track in file" for
a file that plainly has one.) QuickTime's Motion JPEG A and B (`mjpa`, `mjpb`)
are deliberately **not** included: those wrap their fields in extra framing
rather than storing one plain JPEG per sample, so a JPEG decoder handed one
would fail or decode half a picture.

`engine.codecString` reports `mjpeg` for these clips. WebCodecs registers no
codec string for Motion JPEG — there is no `VideoDecoder` to name — so that is
this library's own marker, and it means exactly "each frame is a whole JPEG
image".

### The index cache

A full-file indexing pass (WebM, fragmented MP4, Ogg) is paid once per clip per
machine, not once per load: an index that took longer than ~500 ms to build is
kept in IndexedDB and reused when the *same* clip is opened again. Identity is
proven, never assumed — a stale cached index would be a wrong index, the exact
silent off-by-one this library exists to prevent — so an entry is reused only
when the source's identity fully matches:

- a local `File`: its `(name, size, lastModified)` triple;
- a URL: the address, the byte size, and the server's content validator (a
  strong `ETag`, else `Last-Modified`). No validator — including one hidden by
  CORS (`Access-Control-Expose-Headers`) — means the clip is simply rebuilt and
  never cached. Weak ETags (`W/…`) are ignored for the same reason: they
  promise semantic equivalence, and a byte-offset table needs byte identity.

Anything doubtful is a miss and a rebuild; a cache failure of any kind
(IndexedDB disabled, private browsing, quota) degrades to rebuilding, never to
guessing. A hit is instant and marks the returned index `fromCache = true`.
Cheap indexes (a classic MP4's few range reads) are never stored.

## Usage

```html
<!-- mp4box.js must be loaded first to index MP4s (it provides the MP4Box and
     DataStream globals). WebM/MKV, Ogg and AVI indexing are built in. -->
<script src="https://unpkg.com/mp4box@0.5.2/dist/mp4box.all.min.js"></script>
<!-- Pin an exact release tag; never reference a branch. -->
<script src="https://cdn.jsdelivr.net/gh/jasper-tms/exact-video-engine.js@v2.1.0/exact-video-engine.js"></script>

<div id="pane" style="width: 640px; height: 360px">
  <canvas id="video-canvas"></canvas>
  <video id="video-element" muted playsinline></video>
</div>

<script>
  const canvas = document.getElementById('video-canvas');
  const video = document.getElementById('video-element');

  // source: a URL string (the server must answer HTTP Range requests with 206)
  // or a File/Blob.
  const engine = await createBestEngine(source, { canvas, video });

  // Show whichever of the two elements the engine actually plays into.
  for (const element of [canvas, video]) {
    element.style.display = (element === engine.displayElement) ? '' : 'none';
  }

  // Drive the engine from your requestAnimationFrame loop. (NativeVideoEngine's
  // update() is a no-op — the element runs its own clock — so this is safe to
  // call unconditionally.)
  function tick(now) {
    engine.update(now);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  engine.play();
</script>
```

To use `VideoEngine` alone, construct it with the canvas and call `load(source)`
as before; nothing about that path has changed.

## API

Both engines expose the following. `VideoEngine` is constructed with the
`<canvas>` it presents into; `NativeVideoEngine` with the `<video>` element it
plays through.

| Member | Description |
| --- | --- |
| `load(source, {index})` | Load a URL string or File/Blob. `index` is an optional prebuilt `ContainerIndex`. |
| `play()` / `pause()` / `paused` | Transport. |
| `update(now)` | Call once per animation frame with the rAF timestamp. Advances the playhead and paints (`VideoEngine`); a no-op on `NativeVideoEngine`. |
| `loop` | Whether playback wraps at the end. |
| `playbackRate` | Playback speed multiplier. |
| `duration` | Clip duration in seconds. |
| `numFrames` | Frame count. Grows while `frameIndexState` is `growing` — see "Playing while the index is still being built". |
| `currentFrame` | Integer display frame index on screen. |
| `currentFrameFloat` | Continuous playhead in frame units (index + fraction of the frame's display interval) — drive synchronized/interpolated overlays from this, never from `currentTime * frameRate`. |
| `currentTime` | Playhead in seconds (get/set), with display frame 0 at t = 0 in both engines. |
| `seekToFrame(n)` | Land on display frame `n`. |
| `frameAtTime(t)` | Display frame index on screen at time `t`. |
| `ensureFrame(n)` | Async: resolves once frame `n` is decoded (`VideoEngine`) or once the element has settled on it (`NativeVideoEngine`). |
| `videoWidth` / `videoHeight` | Upright display dimensions (rotation applied). Annotate in this coordinate space. |
| `rotation` | The track's display rotation in degrees: 0, 90, 180, or 270. Informational — both engines already present upright. |
| `displayElement` | The canvas or `<video>` the engine presents into. |
| `tier` | What this engine got, e.g. `webcodecs` or `native (container index, presented clock)`. Useful for a dev label. |
| `frameIndexIsExact` | True on every engine `createBestEngine` returns (a clip that could not be indexed is refused instead). Goes false only if the runtime watcher later catches the table disagreeing with the frames actually presented, alongside a fatal `errormessage`. True in all three `frameIndexState`s: a growing index has *fewer* frames than the clip, not less exact ones. |
| `frameIndexState` | `complete` (the ordinary case), `growing` (the index is still being built and `numFrames` is still rising), or `truncated` (the pass stopped early; what is here is final, the rest of the clip is not coming). `VideoEngine` only — the native path refuses a growing index. |
| `waitingForIndex` | True while playback is pinned at the last indexed frame waiting for the index to catch up. A stall on the indexer, not on the decoder — and not the end of the clip, so `loop` does not fire. |
| events `indexextended` / `indexcomplete` / `indextruncated` | The index published more frames, finished, or stopped early. `indextruncated` also emits a fatal `errormessage`. |
| `codecString` | The clip's codec string as the container declares it (e.g. `hvc1.2.4.L123.b0`), or null when the index carries no decoder configuration (Ogg, or a Matroska codec we do not configure). Lets a host predict format trouble — flagging 10-bit profiles for server-side conversion, say. |
| `failed` | True once the engine can no longer stand behind its output: an unrecoverable `VideoDecoder` error (`VideoEngine`), or the container index caught disagreeing with the presented frames during playback (`NativeVideoEngine`). Both also emit a fatal `errormessage`. |
| `destroy()` | Release resources when done (decoders are a limited browser resource). |
| `resizeCanvas()` | Re-size the canvas backing store to its parent and repaint (`VideoEngine`); a no-op on `NativeVideoEngine`, where CSS `object-fit` handles it. `update()` already does this every tick, so you rarely need to call it — a pane that gains its size *after* the clip loads (a host that reveals the player only once it is ready) is handled without you having to get the timing right. |
| event `loaded` | Fired when `load()` completes. |
| event `errormessage` | `detail.message`: human-readable error string, or null to clear. When the `VideoDecoder` dies mid-stream the detail also carries `fatal: true` plus diagnostics (`errorName`, `codec`, `frame`). A fatal error means this engine will never produce another frame for the clip — some decoders pass `isConfigSupported()` and decode frame 0 but die once sustained decoding starts (WebKit with 10-bit HEVC), which is after `load()` resolved and therefore past `createBestEngine`'s load-time fallback. A host that can fall back should respond by rebuilding with `createBestEngine(source, { prefer: 'native' })`; the `<video>` element typically plays the same clip fine. **`createBestEngine` now heads the best-known case off before it happens** — see below — so this event is the net for combinations not yet in that table. |

`VideoEngine` additionally has `bitmapForFrame(n)`, the decoded `ImageBitmap`
for a frame (coded orientation, possibly downscaled for display — apply
`rotation` yourself). `NativeVideoEngine` has no equivalent: a `<video>` element
cannot hand back a frame you can name. Hosts that need pixels should check
`tier` first — the WebCodecs engine is what has them, and which clips reach it
depends on the browser as well as the container.

This is also how you use `VideoEngine` with no UI at all — to pull a thumbnail
out of a video someone is uploading, say. Hand it a canvas that is not in the
document; with no pane to size itself to, it leaves the canvas alone and paints
nothing, and you take frames from `bitmapForFrame(n)` after `ensureFrame(n)`.
(Before v1.2.1 a canvas with no parent element threw out of `load()`, which
`createBestEngine` reported as an unplayable clip and fell back to `<video>`
for.)

### Opening a clip

Opening a clip is a chain of *dependent* reads — learn the size, sniff the
container, find the moov, read the frame — so they cannot be issued in parallel
and their latencies add up. Against a bucket a few hundred milliseconds away
(Firebase Storage, Cloud Storage), those round trips are the load time, whatever
few bytes they carry.

So the first read is speculative and generous: one 256 KB range read answers the
file's size (every `206` names it in `Content-Range`), its magic number, and — for
a faststart MP4 — its whole `moov`. And a clip small enough to be worth having
outright (under 8 MB) is fetched outright rather than groped through one range at
a time, since anything scrubbing it will read most of it anyway. Opening a
typical few-MB clip costs **two** requests; a large one, two or three.

### Read-ahead

`VideoEngine` decodes a window around the playhead so that playback and short
seeks come out of memory. The frame you actually asked for is never held up by
it: `load()` and `ensureFrame(n)` fetch what that one frame needs and resolve,
and the window fills behind them.

A host that only ever holds still — an offscreen thumbnail grab, a page that
shows one frame — is paying for read-ahead it will never look at, and can turn
it down:

```js
const engine = await createBestEngine(source, { canvas, video, windowAhead: 0 });
new VideoEngine(canvas, { windowAhead: 0 });   // same option, engine directly
```

The default (56 frames, about two seconds) is what you want for anything that
plays. `windowAhead: 0` still decodes the frame you asked for; it just stops
there.

### Memory

A decoded frame costs width × height × 4 bytes, so a window counted in *frames*
costs whatever the clip's resolution decides — the same 56-frame read-ahead is
tens of megabytes of 360p and hundreds of megabytes of 1080p. That is not merely
wasteful on a phone: iOS decodes into a bounded pool of surfaces, and an engine
holding hundreds of megabytes of decoded frames exhausts it, at which point
WebKit kills the decode session outright (`VideoDecoder` reports *"Decoder
failure"*, a second or two into playback, on big clips only).

So the ceiling is **bytes**, and the window is whatever fits under it:

```js
new VideoEngine(canvas, { cacheBytes: 32 << 20 });   // default: 96 MB
```

At the default, a 360p clip keeps the full 56-frame read-ahead, while a 1080p
clip holds about a dozen frames — enough to play without stalling, and far
enough under the ceiling to leave the decoder its surfaces. Frames cached for
display are also downscaled to 1920 on the long side, so a 4K clip costs the
same per frame as a 1080p one (`bitmapForFrame()` hands back that bitmap, in
coded orientation — see the API note above).

Lowering `cacheBytes` shrinks read-ahead first and history second; it never
changes which frames are *available*, only how many are held in memory at once.

Also exported: `ContainerIndex` (`ContainerIndex.fromSource(source, {timeoutMilliseconds,
maxBytes})` builds the frame table on its own, for hosts that want the timestamps
without an engine — it sniffs MP4 vs Matroska vs Ogg vs AVI from the bytes, and reports
which it found in `containerFormat` and whether the result is rich enough to
decode from in `supportsWebCodecs`), and `UrlRangeReader` / `FileRangeReader`,
the random-access byte readers.

### Notes on the fallback's exactness

Two things are load-bearing, and both are tested:

- **The element's timeline is not always the container's.** A clip carrying an
  edit list presents its first frame at a nonzero `mediaTime`. The engine
  calibrates the offset at load by anchoring on the first presented frame, whose
  identity it knows.
- **A trimming edit list is honored, not guessed at.** A clip trimmed to start
  and end partway in — the container still holds every source frame, but the edit
  list presents only a window of them — is numbered over just that presented
  window, so display frame 0 is the first frame the viewer sees and both engines
  play the trim frame-exact. (The decoder still runs the frames before the trim
  point; it needs them to reconstruct the first presented one, but they are never
  shown.) Where a browser mishandles such a clip's `<video>` timeline, the
  native path refuses the clip rather than report frame numbers the element is
  not actually showing: WebKit runs `currentTime` on the media timeline yet
  reports the shorter edited duration (leaving the tail frames unreachable, which
  the calibration detects), and Gecko presents the untrimmed frames outright — a
  whole-frame shift no runtime check can see, so it is refused up front. The
  WebCodecs path is frame-exact on the trim everywhere, and it is what the auto
  ladder picks for these clips anyway. The same honesty applies at runtime: if
  the presented frames stop landing on the table, the engine latches `failed`
  and says so fatally instead of degrading silently.

## Consuming

Reference a pinned release tag through jsDelivr, as in the usage snippet.
Never reference `@main`: jsDelivr caches branch refs for hours, so consumers
would change behavior at unpredictable times with no commit anywhere. Tags are
immutable and cached forever; upgrading a consumer is a deliberate one-line
change.

Known consumers: [SportViewer](https://github.com/jasper-tms/SportViewer)
(viewer.movim.ai) and the [movim.ai](https://movim.ai) sessions app.

## Developing

The engine's source lives in `src/` as ES modules — one per concern (the range
readers, the Matroska scan, `ContainerIndex`, the two engines, the ladder) — so
each piece can be read, edited, and tested in isolation (the parsers import
into plain Node, no browser required). `exact-video-engine.js` at the repo root
is *generated* from them:

```sh
node build.mjs           # rewrite exact-video-engine.js from src/
node build.mjs --check   # verify it is in step; pre-commit and CI both run this
```

The build only drops the module import/export syntax and concatenates in
dependency order — no minification, no renaming — so the shipped file reads
line for line like the source. Edit `src/`, run the build, and commit both
together; the pre-commit hook refuses a commit that lets them drift, and the
release workflow re-checks before tagging.

## Releasing

`VERSION` holds the version and nothing else. Editing it on `main` is the whole
release: a [workflow](.github/workflows/release.yml) tags that commit `vX.Y.Z`
and cuts a GitHub release from it.

The pinned jsDelivr URLs in `demo.html` and this README's usage snippet are
*derived* from `VERSION` by `.githooks/sync_version.sh`, which
`.githooks/pre-commit` runs for you, so they land in the same commit that
changes `VERSION`. A release is then:

```sh
echo 1.3.0 > VERSION
git commit -am "Release v1.3.0"   # the hook repoints the pins, in this commit
git push                          # the workflow tags v1.3.0 and releases it
```

The hook only wakes up for a commit that touches `VERSION`, and it refuses to
run if `demo.html` or `README.md` have unstaged changes, rather than quietly
sweeping them into the release commit.

### Getting the hook to run

Git never runs hooks out of the working tree. They live in `.git/hooks`, which
is not part of the repository and is not cloned — deliberately, so that cloning
a repo cannot make it execute code on your next commit. A checked-in
`.githooks/pre-commit` therefore does nothing on its own, and needs one of:

- **Nothing**, if you use the [shell-configs](https://github.com/jasper-tms/shell-configs)
  global hook dispatcher *and* this repo's `origin` is an account you listed in
  its `git-hooks/trusted-remotes`. The dispatcher finds `.githooks/<hook-name>`
  by itself.
- **One command**, if you use that dispatcher but this repo is not one of yours
  (you cloned or forked it, so `jasper-tms` is not in your trusted list). The
  dispatcher will otherwise skip the hook and say so on stderr:

  ```sh
  git config hooks.allowRepoHooks true
  ```

- **A symlink**, if you do not use that dispatcher at all:

  ```sh
  ln -s ../../.githooks/pre-commit .git/hooks/pre-commit
  ```

Do **not** point `core.hooksPath` at `.githooks`. It would work, but only by
shadowing whatever global hooks you already have, silently and everywhere in
this repo — which is exactly the failure the dispatcher exists to avoid.

If the hook never runs, nothing breaks — it only gets noisier. The release
workflow re-derives the pins with `.githooks/sync_version.sh --check` and
refuses to tag a commit that disagrees with `VERSION`, so the failure mode is a
red CI run rather than a published tag whose demo page loads the previous
release. (Tags are immutable and jsDelivr caches them forever, which is why that
check exists at all.) To recover: run `.githooks/sync_version.sh`, commit, push.

## Tests

`test/` needs `ffmpeg` on the PATH and Playwright (`npm install playwright`):

```sh
bash test/run-tests.sh
```

**Rotation** renders clips with 0/90/180/270° rotation metadata through both the
engine and a native `<video>` element and compares where an asymmetric marker
lands.

**Frame index** walks every frame of the counter clips through each engine and
checks that asking for frame `n` both puts frame `n` on screen and reports
frame `n` back. Ground truth is the pixels: each frame identifies itself by the
position of a white bar in its **bottom half**, so nothing is taken on trust
from a clock. Each frame's **top half** carries the same number in large plain
digits — nothing in the suite reads it, and it is there so a person can open any
of these clips in a player, in `demo.html`, or in the app being debugged and see
at a glance which frame is on screen instead of counting bar positions. Both
halves are drawn by `test/make-counter-frames.py`, and every counter fixture
below is encoded from the same bytes, so two of them differing in container or
codec really do differ in nothing else.

Each case also pins which *tier* the ladder landed on, because a case that
checked only frames would pass just as happily on the fallback — which is exactly
what the WebM cases used to do. The clips are chosen to make the index's
exactness falsifiable:

- `counter-vfr.mp4` is variable-frame-rate: no assumed constant rate maps it
  correctly, so all 30 frames landing right proves the real timestamp table is
  in charge.
- `counter-vfr.webm` is the same 30 frames in a container mp4box cannot parse,
  so it exercises the engine's own Matroska scan — on both tiers, since that scan
  now feeds WebCodecs as well.
- `counter-vfr.mkv` is those frames as H.264 in Matroska: playable *only* through
  WebCodecs on WebKit, which demuxes no Matroska at all, so it fails outright if
  the Matroska sample table regresses.
- `counter-vp8.webm` and `counter-av1.webm` cover the other codec strings the
  Matroska path derives. AV1 is also the suite's one asserted *refusal*: WebKit
  decodes it in neither WebCodecs nor `<video>`, and the engine must say so
  promptly rather than wait on an element that reports no error and never
  presents a frame.
- `counter-vfr-fragmented.mp4` is the same 30 frames with the sample table
  scattered across `moof` fragments, so it exercises the fragmented-MP4 pass.
- `counter-cfr.ogv` exercises the Ogg page scan, in browsers that still decode
  Theora (`ogg-table-test.mjs` pins the parser itself, browser-independently).
- `counter-elst.mp4` carries an edit list, so its first frame presents at
  `mediaTime` 0.133 rather than 0. It passes only if the timeline calibration is
  genuinely finding that offset instead of getting away with a zero one.
- `counter-idx1.avi` and `counter-opendml.avi` are the same frames as H.264 in
  AVI, carrying the legacy `idx1` index and the OpenDML hierarchical index
  respectively — the only container here with no native tier to fall back to.
- `counter-mjpeg.avi` and `counter-mjpeg.mov` are those frames as Motion JPEG,
  which decodes through the browser's JPEG decoder rather than a `VideoDecoder`
  (see "Motion JPEG" above). Two containers, because the path belongs to
  neither.

**Matroska table** (plain Node) checks the half of that index a browser walk
cannot see: that every frame's recorded byte range lies inside the file, that no
two overlap, that length-prefixed samples tile exactly into NAL units (a range
off by one byte cannot), and that each codec string comes out exactly right —
`vp09.00.10.08`, `hvc1.1.6.L30.90`, `av01.0.00M.08`. A subtly wrong sample table
can still decode into right-looking frames, which is why this is not left to the
pixel walk. It is also where HEVC-in-Matroska is covered at all: Playwright's
Chromium ships no HEVC decoder and its WebKit fails 8-bit HEVC identically in MP4
and MKV, so a browser case would pin a property of the test browsers rather than
of this engine.

The refusal side — a WebM given no indexing time must be refused with a clear
error, not approximated — is pinned by **robustness**, and the **index cache**
test pins that a cache hit returns identical tables while any doubtful identity
(changed `lastModified`, an identity-less `Blob`, a wrong schema version) is a
miss and a rebuild.

**Display** checks that the frame actually reaches the screen, which the frame
index test cannot: it asserts only on frame *numbers*, and would pass just the
same if the canvas were painting nothing. So this one loads a clip into a pane
that is still `display: none` — a host that reveals its player only once the
clip is ready — then reveals it and looks at the pixels: the backing store must
match the pane, the image must have real spread (a flat wash has none), and the
frame on screen must be the one that was asked for. Neither case calls
`resizeCanvas()` after the reveal, on purpose; doing so would paper over a
backing store that was mis-sized while the pane had no box, and the case would
pass whether or not the bug was there.

**Offscreen** runs a clip through a canvas that is not in the document, the way
a thumbnail grab does, and asserts on the tier as well as the pixels: falling
back to `<video>` still produces a correct-looking thumbnail, so a test that only
looked at the image would not notice the WebCodecs path having quietly broken.

**Startup** counts what opening a clip costs, in the two currencies that are not
frame numbers.

*Bytes and seconds*, over a throttled link, against a 37 MB fixture: the frames
were exactly right while the engine was blocking the first one on a 4 MB read,
which is invisible on localhost and seconds of blank pane on a phone. It also
pins `windowAhead: 0` down to an absolute byte budget, since an engine that
ignores the option entirely can still be caught out "using less than the default"
by timing luck.

*Round trips*, which no byte budget can see and which localhost charges nothing
for. A 2.6 MB clip served from a cloud bucket took eight serialized range requests
to open — the first asking for 1 byte, the second for 4 — and at 400 ms of
round-trip time that was four seconds of empty pane while every byte budget
passed. The test counts requests rather than timing them, because latency is the
point and a stopwatch against localhost would only measure the machine.

**Memory** plays a 1080p clip and watches the high-water mark of decoded frames
held in the cache. This is a third currency again: bytes off the network are not
bytes held in memory, and the frames are correct at any window size, so every
other test above passed while a frame-counted cache was holding **649 MB** of a
1080p clip — enough to exhaust an iPhone's decoder surfaces and take the decode
session down mid-playback. It needs a big-framed fixture to mean anything (the
suite's other clips are 360p and smaller, where the old budget stayed under the
new ceiling by accident), and it checks the ceiling in both directions: small
frames must still get the full read-ahead, and a host that lowers `cacheBytes`
must actually see it shrink.

## License

MIT
