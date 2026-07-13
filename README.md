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

That table can be built from the container's `moov` alone: no decoding, no
`VideoDecoder`, a few range requests. `ContainerIndex` builds it, and it is
handed to whichever engine ends up playing. Given it, the `<video>` path
binary-searches `mediaTime` into an exact frame index and is frame-exact on
variable-frame-rate clips.

`createBestEngine()` picks the best combination available for a given clip and
browser:

| | Index from | Presentation | Frame index |
| --- | --- | --- | --- |
| 1. WebCodecs | container | engine-owned canvas | exact |
| 2. `<video>` + index | container | browser | exact |
| 3. `<video>` + declared rate | assumed frame rate | browser | exact only if constant-frame-rate |
| 4. no `requestVideoFrameCallback` | assumed frame rate | browser | `currentTime * frameRate`; last resort |

Step 2 is the one that usually does not exist. It covers browsers without
WebCodecs (Safari before 16.4, older Firefox), codecs the platform decoder
rejects, and any host that needs audio or the battery-friendly hardware overlay
path — none of which now have to settle for guessing at frame numbers.

Step 3 is where a container mp4box cannot parse lands (WebM, Ogg, HLS): the
element still plays it, and `frameIndexIsExact` tells you the indices are only
as good as the frame rate you declared.

## Usage

```html
<!-- mp4box.js must be loaded first (provides the MP4Box/DataStream globals). -->
<script src="https://unpkg.com/mp4box@0.5.2/dist/mp4box.all.min.js"></script>
<!-- Pin an exact release tag; never reference a branch. -->
<script src="https://cdn.jsdelivr.net/gh/jasper-tms/exact-video-engine.js@v1.2.0/exact-video-engine.js"></script>

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
| `numFrames` | Frame count. |
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
| `frameIndexIsExact` | Whether frame numbers are exact, or only as good as an assumed constant frame rate. A tool that must not mislabel a frame should check this and say so. |
| `destroy()` | Release resources when done (decoders are a limited browser resource). |
| `resizeCanvas()` | Re-size the canvas backing store to its parent and repaint (`VideoEngine`); a no-op on `NativeVideoEngine`, where CSS `object-fit` handles it. `update()` already does this every tick, so you rarely need to call it — a pane that gains its size *after* the clip loads (a host that reveals the player only once it is ready) is handled without you having to get the timing right. |
| event `loaded` | Fired when `load()` completes. |
| event `errormessage` | `detail.message`: human-readable error string, or null to clear. |

`VideoEngine` additionally has `bitmapForFrame(n)`, the decoded `ImageBitmap`
for a frame (coded orientation, possibly downscaled for display — apply
`rotation` yourself). `NativeVideoEngine` has no equivalent: a `<video>` element
cannot hand back a frame you can name. Hosts that need pixels should check
`frameIndexIsExact` first.

`NativeVideoEngine` additionally has `setFrameRate(framesPerSecond, numFrames)`,
for hosts that know the clip's rate from elsewhere (a sidecar file, say) when no
container index is available. It is ignored when an index is present, which is
strictly better.

Also exported: `ContainerIndex` (`ContainerIndex.fromSource(source)` builds the
frame table on its own, for hosts that want the timestamps without an engine),
and `UrlRangeReader` / `FileRangeReader`, the random-access byte readers.

### Notes on the fallback's exactness

Two things are load-bearing, and both are tested:

- **The element's timeline is not always the container's.** A clip carrying an
  edit list presents its first frame at a nonzero `mediaTime`. The engine
  calibrates the offset at load by anchoring on the first presented frame, whose
  identity it knows.
- **A trimming edit list is refused, not guessed at.** If the container's frame
  table spans more than the element will present, the table describes frames the
  element never shows and every index would be shifted. The engine detects this
  and drops to the declared frame rate rather than report confidently wrong
  frame numbers. It also drops if the presented frames stop landing on the table
  at runtime.

## Consuming

Reference a pinned release tag through jsDelivr, as in the usage snippet.
Never reference `@main`: jsDelivr caches branch refs for hours, so consumers
would change behavior at unpredictable times with no commit anywhere. Tags are
immutable and cached forever; upgrading a consumer is a deliberate one-line
change.

Known consumers: [SportViewer](https://github.com/jasper-tms/SportViewer)
(viewer.movim.ai) and the [movim.ai](https://movim.ai) sessions app.

## Tests

`test/` needs `ffmpeg` on the PATH and Playwright (`npm install playwright`):

```sh
bash test/run-tests.sh
```

**Rotation** renders clips with 0/90/180/270° rotation metadata through both the
engine and a native `<video>` element and compares where an asymmetric marker
lands.

**Frame index** walks every frame of three clips through each engine and checks
that asking for frame `n` both puts frame `n` on screen and reports frame `n`
back. Ground truth is the pixels: each frame identifies itself by the position
of a white bar, so nothing is taken on trust from a clock. The clips are chosen
to make the fallback's exactness falsifiable:

- `counter-vfr.mp4` is variable-frame-rate. The `<video>` path mismaps 25 of its
  30 frames when it can only assume a constant frame rate — and, worse, keeps
  reporting the frame you asked for while showing a different one. With the
  container index it gets all 30 right.
- `counter-elst.mp4` carries an edit list, so its first frame presents at
  `mediaTime` 0.133 rather than 0. It passes only if the timeline calibration is
  genuinely finding that offset instead of getting away with a zero one.

## License

MIT
