# exact-video-engine.js

A frame-perfect video player for the browser, built on WebCodecs.

## Why

A native `<video>` element is not frame-accurate:

- Playing via `play()` stochastically drops a frame near the start (the
  browser's compositor swallows roughly one inter-frame interval while the
  media clock spins up).
- Its `currentTime` → frame-index mapping drifts on non-integer frame rates
  (29.97 fps) and is undefined on variable-frame-rate clips.
- After a programmatic seek, there is no reliable way to read back which frame
  is actually displayed.

`VideoEngine` (this project) instead demuxes the MP4 container with
[mp4box.js](https://github.com/gpac/mp4box.js), decodes every frame itself
with a WebCodecs `VideoDecoder`, and presents frames onto a canvas on a clock
it owns. The integer frame index is the source of truth throughout: per-frame
presentation timestamps come from the container (B-frame safe, variable frame
rate safe), never from an assumed constant fps. Anything the host renders in
sync with the video — a 3D overlay, an annotation layer — reads the playhead
from the same object that paints the pixels, so it cannot drift from the frame
on screen.

Decoding is windowed by GOP (group of pictures) with an eviction policy biased
for forward playback, so memory stays flat regardless of clip length. Frames
are fetched with HTTP Range requests (or `File.slice` for local files), so a
long video is never downloaded whole just to show one frame.

The track's display rotation metadata (0/90/180/270 — ubiquitous in phone
recordings, which are often coded landscape with a 90° rotation matrix) is
read from the container and applied at presentation, matching how a `<video>`
element would display the clip.

## Usage

```html
<!-- mp4box.js must be loaded first (provides the MP4Box/DataStream globals). -->
<script src="https://unpkg.com/mp4box@0.5.2/dist/mp4box.all.min.js"></script>
<!-- Pin an exact release tag; never reference a branch. -->
<script src="https://cdn.jsdelivr.net/gh/jasper-tms/exact-video-engine.js@v1.0.0/exact-video-engine.js"></script>

<div id="pane" style="width: 640px; height: 360px">
  <canvas id="video-canvas"></canvas>
</div>

<script>
  const engine = new VideoEngine(document.getElementById('video-canvas'));
  engine.addEventListener('errormessage', (event) => {
    // event.detail.message is a human-readable string, or null to clear a
    // previously shown error. Rendering it is the host page's job.
  });

  // source: a URL string (the server must answer HTTP Range requests with
  // 206) or a File/Blob.
  await engine.load(source);

  // Drive the engine from your requestAnimationFrame loop:
  function tick(now) {
    engine.update(now);   // advances the playhead (if playing) + paints
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  engine.play();
</script>
```

## API

Constructed with the `<canvas>` it presents into. The canvas backing store is
sized to its parent element by `resizeCanvas()` (call it from your resize
handler); frames are letterboxed inside it, centered, aspect preserved.

| Member | Description |
| --- | --- |
| `load(source)` | Load a URL string or File/Blob. Resolves once frame 0 is decoded and painted. |
| `play()` / `pause()` / `paused` | Transport. The playhead only advances inside `update()`. |
| `update(now)` | Call once per animation frame with the rAF timestamp. Advances the playhead, steers decoding, paints. |
| `loop` | Whether playback wraps at the end (default true). |
| `playbackRate` | Playback speed multiplier. |
| `duration` | Clip duration in seconds (sum of real frame durations). |
| `numFrames` | Exact frame count. |
| `currentFrame` | Integer display frame index at the playhead. |
| `currentFrameFloat` | Continuous playhead in frame units (index + fraction of the frame's display interval) — drive synchronized/interpolated overlays from this. |
| `currentTime` | Playhead in seconds (get/set). |
| `seekToFrame(n)` | Land the playhead exactly on display frame `n`. |
| `frameAtTime(t)` | Display frame index on screen at time `t` (binary search of the real PTS table). |
| `ensureFrame(n)` | Async: resolves once frame `n` is decoded and cached. |
| `bitmapForFrame(n)` | The cached `ImageBitmap` for frame `n` (call `ensureFrame` first). NOTE: coded orientation, possibly downscaled for display — apply `rotation` yourself and treat coordinates as relative. |
| `videoWidth` / `videoHeight` | Upright display dimensions (rotation applied). Annotate in this coordinate space. |
| `rotation` | The track's display rotation in degrees: 0, 90, 180, or 270. |
| `displayElement` | The canvas passed to the constructor. |
| `resizeCanvas()` | Re-size the canvas backing store to its parent (device pixels) and repaint. |
| event `loaded` | Fired when `load()` completes. |
| event `errormessage` | `detail.message`: human-readable error string, or null to clear. |

Also exported: `UrlRangeReader` and `FileRangeReader`, the random-access byte
readers the engine uses (over HTTP Range and `File.slice` respectively).

## Consuming

Reference a pinned release tag through jsDelivr, as in the usage snippet.
Never reference `@main`: jsDelivr caches branch refs for hours, so consumers
would change behavior at unpredictable times with no commit anywhere. Tags are
immutable and cached forever; upgrading a consumer is a deliberate one-line
change.

Known consumers: [SportViewer](https://github.com/jasper-tms/SportViewer)
(viewer.movim.ai) and the [movim.ai](https://movim.ai) sessions app.

## Tests

`test/` contains a rotation-correctness test that renders clips with 0/90/180/
270° rotation metadata through both the engine and a native `<video>` element
and compares where an asymmetric marker lands. It needs `ffmpeg` on the PATH
and Playwright (`npm install playwright`):

```sh
bash test/run-tests.sh
```

## License

MIT
