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

`VideoEngine` instead demuxes the container, decodes every frame itself with a
WebCodecs `VideoDecoder`, and presents frames onto a canvas on a clock it owns.
Anything the host renders in sync with the video — a 3D overlay, an annotation
layer — reads the playhead from the same object that paints the pixels, so it
cannot drift from the frame on screen.

But WebCodecs is not always there, it cannot play every clip, and it has no
audio. So `NativeVideoEngine` plays through a real `<video>` element and
exposes the same members — and stays frame-exact anyway. Every clip this
library plays is first indexed into a table of per-frame presentation
timestamps, read straight out of the container without decoding anything
(MP4/MOV, WebM/MKV, fragmented MP4, Ogg, and AVI are all supported). Given that
table, the native path binary-searches `requestVideoFrameCallback`'s
`mediaTime` — the presented frame's exact timestamp — into an exact frame
index, even on variable-frame-rate clips where the usual constant-rate guess
quietly mismaps.

`createBestEngine()` picks the best combination available for a given clip and
browser:

| | Index from | Presentation | Frame index |
| --- | --- | --- | --- |
| 1. WebCodecs | container | engine-owned canvas | exact |
| 2. `<video>` + index | container | browser | exact |

There is no step 3. An engine that reports frame numbers it cannot stand
behind is worse than no engine, so every engine this library hands back has a
real per-frame timestamp table, and a clip that cannot get one — a container
we cannot parse, an indexing pass that blew its time or byte budget, a browser
that cannot say which frame is on screen — is refused with an
`UnplayableClipError` explaining why, rather than played with guessed frame
numbers.

## Quick start

```html
<!-- mp4box.js must be loaded first to index MP4s (it provides the MP4Box and
     DataStream globals). WebM/MKV, Ogg and AVI indexing are built in. -->
<script src="https://unpkg.com/mp4box@0.5.2/dist/mp4box.all.min.js"></script>
<!-- Pin an exact release tag; never reference a branch. -->
<script src="https://cdn.jsdelivr.net/gh/jasper-tms/exact-video-engine.js@v2.4.0/exact-video-engine.js"></script>

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

`demo.html` in this repository is a working page built on exactly this
pattern.

## Learning more

- **[agent-skills/user-guide/SKILL.md](agent-skills/user-guide/SKILL.md)** —
  integrating the engine into an app: installation from a bundler, the full
  API reference, `UnplayableClipError` handling, indexing budgets and progress
  reporting, playing while the index is still being built, and memory tuning.
- **[agent-skills/video-format-support-per-browser/SKILL.md](agent-skills/video-format-support-per-browser/SKILL.md)**
  — which codecs each backend (WebCodecs vs native `<video>`) can actually
  decode, per browser engine, from testing rather than from documentation.
- **[agent-skills/implementation-details/SKILL.md](agent-skills/implementation-details/SKILL.md)**
  — how the engine works inside: the per-container indexers, the
  engine-selection ladder and refusal taxonomy, the certified-prefix rules
  behind progressive indexing, the native tier's exactness machinery, the
  performance strategy, and what each test pins.
- **[DEVELOPING.md](DEVELOPING.md)** — building the shipped file from `src/`,
  running the tests, cutting a release, and setting up the git hooks.

## Consuming

Reference a pinned release tag through jsDelivr, as in the quick start.
Never reference `@main`: jsDelivr caches branch refs for hours, so consumers
would change behavior at unpredictable times with no commit anywhere. Tags are
immutable and cached forever; upgrading a consumer is a deliberate one-line
change.

Known consumers: [SportViewer](https://github.com/jasper-tms/SportViewer)
(viewer.movim.ai) and the [movim.ai](https://movim.ai) sessions app.

## License

MIT
