# What each test pins, and why the fixtures are shaped this way

Run with `bash test/run-tests.sh` (needs `ffmpeg` on the PATH and Playwright
via `npm install`). This file records the *design* of the suite: what each
case pins, and what would silently pass without it. Read it before adding or
modifying tests, so a new case actually falsifies something.

## The counter clips

Ground truth is the pixels: each frame identifies itself by the position of a
white bar in its **bottom half**, so nothing is taken on trust from a clock.
Each frame's **top half** carries the same number in large plain digits —
nothing in the suite reads it; it is there so a person can open any of these
clips in a player, in `demo.html`, or in the app being debugged and see at a
glance which frame is on screen. Both halves are drawn by
`test/make-counter-frames.py`, and every counter fixture is encoded from the
same frames, so two fixtures differing in container or codec really do differ
in nothing else.

## Rotation

Renders clips with 0/90/180/270° rotation metadata through both the engine
and a native `<video>` element and compares where an asymmetric marker lands.

## Frame index

Walks every frame of the counter clips through each engine and checks that
asking for frame `n` both puts frame `n` on screen and reports frame `n`
back. On the WebCodecs tier every case also checks that `load()` leaves the
playhead on display frame 0's presentation time — 0 for an ordinary clip, the
gap for a leading empty edit — so playback begins on the first visible frame,
never in the void ahead of the media. Each case also pins which *tier* the
ladder landed on, because a case
that checked only frames would pass just as happily on the fallback — which
is exactly what the WebM cases once did. The clips are chosen to make the
index's exactness falsifiable:

- `counter-vfr.mp4` is variable-frame-rate: no assumed constant rate maps it
  correctly, so all 30 frames landing right proves the real timestamp table
  is in charge.
- `counter-vfr.webm` is the same 30 frames in a container mp4box cannot
  parse, so it exercises the engine's own Matroska scan — on both tiers,
  since that scan feeds WebCodecs as well.
- `counter-vfr.mkv` is those frames as H.264 in Matroska: playable *only*
  through WebCodecs on WebKit, which demuxes no Matroska at all, so it fails
  outright if the Matroska sample table regresses.
- `counter-vp8.webm` and `counter-av1.webm` cover the other codec strings the
  Matroska path derives. AV1 is also the suite's one asserted *refusal*:
  WebKit decodes it in neither WebCodecs nor `<video>`, and the engine must
  say so promptly rather than wait on an element that reports no error and
  never presents a frame.
- `counter-vfr-fragmented.mp4` scatters the sample table across `moof`
  fragments, exercising the fragmented-MP4 pass.
- `counter-cfr.ogv` exercises the Ogg page scan, in browsers that still
  decode Theora (`ogg-table-test.mjs` pins the parser itself,
  browser-independently).
- `counter-elst.mp4` carries a leading empty edit (a 0.133s gap, `media_time
  -1`) and a head cut, so its first frame is source frame 10 (bar at x = 50),
  reported 0.133s into the composition timeline rather than at 0. It passes only
  if the container-to-element mapping honors the gap. It also has no audio track,
  so on Firefox the `<video>` element's duration omits the leading black while
  `index.duration` includes it — the case that pins `_indexDescribesElement`'s
  two-sided span check (see native-engine-exactness.md), without which the clip is
  wrongly refused there.
- `counter-leading-gap-elst.mp4` is `counter-cfr` copied frame for frame behind a
  deliberate 3-second empty edit (no head cut), so its frame 0 IS source frame 0
  (bar at x = 0) but is reported at 3.00s, not 0.00. Where counter-elst's small
  gap could pass for rounding, this one cannot: the frame-index test pins
  `firstFrameTime` across all three browsers — the reported-time shift a
  frame-number walk cannot see. It is also the clip that anchors the
  playhead-at-load check: the engine's clock must read 3.00s the instant it
  loads, not 0.00. Its 4s audio track makes the element's duration span the whole
  gap, so `index.duration` matches it directly on every browser.
- `counter-idx1.avi` and `counter-opendml.avi` are the same frames as H.264
  in AVI, carrying the legacy `idx1` index and the OpenDML hierarchical index
  respectively — the only container with no native tier to fall back to.
- `counter-mjpeg.avi` and `counter-mjpeg.mov` are those frames as Motion
  JPEG, which decodes through the browser's JPEG decoder rather than a
  `VideoDecoder`. Two containers, because the path belongs to neither.
- `counter-mp4v.mp4` is those frames as MPEG-4 Part 2, the one case whose
  expectation is inverted: only WebKit decodes this codec, so it asserts a
  frame-exact walk there and a clean *refusal* on Chromium and Firefox. Both
  halves matter — the walk proves the rescued `mp4v` sample entry produced a
  real index, and the refusal proves an undecodable clip fails fast instead
  of hanging or being played with guessed frame numbers.

## Matroska table (plain Node)

Checks the half of the index a browser walk cannot see: that every frame's
recorded byte range lies inside the file, that no two overlap, that
length-prefixed samples tile exactly into NAL units (a range off by one byte
cannot), and that each codec string comes out exactly right —
`vp09.00.10.08`, `hvc1.1.6.L30.90`, `av01.0.00M.08`. A subtly wrong sample
table can still decode into right-looking frames, which is why this is not
left to the pixel walk. It is also where HEVC-in-Matroska is covered at all:
Playwright's Chromium ships no HEVC decoder and its WebKit fails 8-bit HEVC
identically in MP4 and MKV, so a browser case would pin a property of the
test browsers rather than of this engine.

## MPEG-4 Part 2 sample entry (plain Node)

Pins the `mp4v` entry parser past its result: the entry bytes and the `esds`
descriptor tree inside them, checked against real output from two
libavformat versions plus synthetic entries for what neither happens to
contain — an `ES_Descriptor` carrying its three optional fields, a non-video
object type that must be *refused* rather than passed on as video, and the
malformed inputs an untrusted file can present, which must answer null rather
than throw.

## Unplayable clip (plain Node)

Pins the refusal surface itself: that an `UnplayableClipError` is still an
`Error` and still carries its message, so the fields are an addition and not
a migration; that every `reason` string thrown anywhere in `src/` appears in
the exported `UNPLAYABLE_REASONS` (it greps the sources rather than trusting
the list to have been maintained); and that codec naming survives the profile
suffixes real files carry, `avc1.42E01E` and `avc3.64001f` alike.

## Robustness, and the index cache

Robustness pins that a WebM given no indexing time is refused with a clear
error, not approximated — and that the refusal arrives machine-readable
(`errorName`, `reason`), not merely readable. The index cache test pins that
a cache hit returns identical tables while any doubtful identity (changed
`lastModified`, an identity-less `Blob`, a wrong schema version) is a miss
and a rebuild.

## Display

Checks that the frame actually reaches the screen, which the frame index
test cannot: it asserts only on frame *numbers*, and would pass just the
same if the canvas were painting nothing. So this one loads a clip into a
pane that is still `display: none` — a host that reveals its player only once
the clip is ready — then reveals it and looks at the pixels: the backing
store must match the pane, the image must have real spread (a flat wash has
none), and the frame on screen must be the one that was asked for. Neither
case calls `resizeCanvas()` after the reveal, on purpose; doing so would
paper over a backing store that was mis-sized while the pane had no box, and
the case would pass whether or not the bug was there.

## Offscreen

Runs a clip through a canvas that is not in the document, the way a thumbnail
grab does, and asserts on the tier as well as the pixels: falling back to
`<video>` still produces a correct-looking thumbnail, so a test that only
looked at the image would not notice the WebCodecs path having quietly
broken.

## Startup

Counts what opening a clip costs, in the two network currencies that are not
frame numbers (see performance.md):

- *Bytes and seconds*, over a throttled link, against a 37 MB fixture —
  because a first frame blocked on a multi-megabyte read is invisible on
  localhost and seconds of blank pane on a phone. It also pins
  `windowAhead: 0` down to an absolute byte budget, since an engine that
  ignores the option entirely can still be caught "using less than the
  default" by timing luck.
- *Round trips*, which no byte budget can see and which localhost charges
  nothing for: serialized range requests at a few hundred milliseconds each
  are seconds of empty pane while every byte budget passes. The test counts
  requests rather than timing them, because latency is the point and a
  stopwatch against localhost would only measure the machine.

## Memory

Plays a 1080p clip and watches the high-water mark of decoded frames held in
the cache — a third currency again: bytes off the network are not bytes held
in memory, and the frames are correct at any window size, so every other
test above once passed while a frame-counted cache held 649 MB of a 1080p
clip — enough to exhaust an iPhone's decoder surfaces and take the decode
session down mid-playback. It needs a big-framed fixture to mean anything
(the suite's other clips are 360p and smaller, where an oversized budget
stays under the ceiling by accident), and it checks the ceiling in both
directions: small frames must still get the full read-ahead, and a host that
lowers `cacheBytes` must actually see it shrink.
