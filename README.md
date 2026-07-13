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
requests), and by scanning the clusters for WebM (see below) — and it is handed
to whichever engine ends up playing. Given it, the `<video>` path binary-searches
`mediaTime` into an exact frame index and is frame-exact on variable-frame-rate
clips.

`createBestEngine()` picks the best combination available for a given clip and
browser:

| | Index from | Presentation | Frame index |
| --- | --- | --- | --- |
| 1. WebCodecs | container (MP4) | engine-owned canvas | exact |
| 2. `<video>` + index | container (MP4 or WebM) | browser | exact |
| 3. `<video>` + declared rate | assumed frame rate | browser | exact only if constant-frame-rate |
| 4. no `requestVideoFrameCallback` | assumed frame rate | browser | `currentTime * frameRate`; last resort |

Step 2 is the one that usually does not exist. It covers browsers without
WebCodecs (Safari before 16.4, older Firefox), codecs the platform decoder
rejects, WebM (whose index carries timestamps but no sample table for WebCodecs
to decode from), and any host that needs audio or the battery-friendly hardware
overlay path — none of which now have to settle for guessing at frame numbers.

Step 3 is where a container we cannot index lands (Ogg, HLS, or a WebM whose
indexing pass ran out of time): the element still plays it, and
`frameIndexIsExact` tells you the indices are only as good as the frame rate you
declared.

### WebM

mp4box only speaks ISOBMFF, so WebM used to land on step 3 and get silently
wrong frame numbers on any clip that was not really constant-frame-rate. It does
not have to: Matroska stores every frame's presentation timestamp in plain sight
(a cluster's timestamp plus each block's signed 16-bit offset from it), so the
engine reads them itself, skipping every block's payload. No decoding, no
dependency.

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

A clip that blows through the budget falls back to the declared frame rate
(step 3) rather than making the host wait — `frameIndexIsExact` goes false and
says so. Neither option affects MP4, which is a handful of range reads however
long the clip is. The pass yields to the event loop as it goes, so it cannot
freeze the page.

## Usage

```html
<!-- mp4box.js must be loaded first to index MP4s (it provides the MP4Box and
     DataStream globals). WebM indexing is built in and needs nothing. -->
<script src="https://unpkg.com/mp4box@0.5.2/dist/mp4box.all.min.js"></script>
<!-- Pin an exact release tag; never reference a branch. -->
<script src="https://cdn.jsdelivr.net/gh/jasper-tms/exact-video-engine.js@v1.6.1/exact-video-engine.js"></script>

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

`NativeVideoEngine` additionally has `setFrameRate(framesPerSecond, numFrames)`,
for hosts that know the clip's rate from elsewhere (a sidecar file, say) when no
container index is available. It is ignored when an index is present, which is
strictly better.

Also exported: `ContainerIndex` (`ContainerIndex.fromSource(source, {timeoutMilliseconds,
maxBytes})` builds the frame table on its own, for hosts that want the timestamps
without an engine — it sniffs MP4 vs WebM from the bytes, and reports which it
found in `containerFormat` and whether the result is rich enough to decode from
in `supportsWebCodecs`), and `UrlRangeReader` / `FileRangeReader`, the
random-access byte readers.

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

**Frame index** walks every frame of five clips through each engine and checks
that asking for frame `n` both puts frame `n` on screen and reports frame `n`
back. Ground truth is the pixels: each frame identifies itself by the position
of a white bar, so nothing is taken on trust from a clock. The clips are chosen
to make the fallback's exactness falsifiable:

- `counter-vfr.mp4` is variable-frame-rate. The `<video>` path mismaps 25 of its
  30 frames when it can only assume a constant frame rate — and, worse, keeps
  reporting the frame you asked for while showing a different one. With the
  container index it gets all 30 right.
- `counter-vfr.webm` is the same 30 frames in a container mp4box cannot parse, so
  it exercises the engine's own Matroska scan: mismapped 25 of 30 by an assumed
  frame rate, exact once the cluster timestamps are read. Running it with
  `indexTimeoutMilliseconds: 0` also pins the bail-out — no time to index means
  falling back to the declared rate, not failing.
- `counter-elst.mp4` carries an edit list, so its first frame presents at
  `mediaTime` 0.133 rather than 0. It passes only if the timeline calibration is
  genuinely finding that offset instead of getting away with a zero one.

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
