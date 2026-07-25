# Sharp corners to fix

What's currently broken or unsupported from a user's point of view — phrased as
"someone tries to do X, and here's what goes wrong." Internal machinery left out
so these can be prioritized on impact alone.

## Things that visibly break

**ALREADY FIXED: 1. HDR / iPhone videos crash partway through playback.** 
A video shot on a recent iPhone (the default HDR / 10-bit format) can start
playing, then die a second or two in — on iPhones, and also in desktop Safari.
Whether the user recovers depends entirely on the app around it catching the
failure and reloading; on its own, the player just stops. This is the single
most common real-world "it worked on my laptop but broke on my phone" report.

**ALREADY FIXED: 2. Trimmed videos lose frame accuracy.**
If a clip has been trimmed so it starts partway in, the player refuses to guess
and drops to *approximate* frame numbers. So a trimmed clip can't be annotated
or seeked frame-accurately — the one thing this library exists to guarantee
quietly stops being guaranteed for that clip.

## Things that silently degrade (no crash, but wrong or fuzzy)

**FIXED: 3. WebM never gets the precise engine.**
A `.webm` clip only ever played through the plain browser player: frame-exact
(index or refuse), but with no owned clock and no way to hand back pixels for a
named frame. An `.mkv` was worse than inexact — on iPhone/Safari, which cannot
open Matroska at all, it simply would not play. Ogg is still in this boat.

**FIXED: 4. Big WebM files (or slow connections) time out into approximate mode.**
Opening a WebM means reading through the whole file. A large one, or a slow
link, blows the deadline — the user waits, watches a progress bar, and then gets
*degraded* frame accuracy as the reward. The bigger the file, the worse this
gets.

**FIXED: 5. Anything that isn't MP4/MOV or WebM is approximate only.**
Ogg, streaming formats (HLS), and other containers play, but with guessed frame
numbers. No error, just silently not frame-exact.

## Things you simply can't do

**6. You can't pull a specific frame's pixels unless you're on the precise engine.**
Thumbnail generation, "extract frames A–B," grabbing a still off an upload — all
only work on the precise path. That path now covers MP4, AVI, and WebM/MKV
(H.264, HEVC, VP8, VP9, AV1) wherever the browser's decoder can take the codec.
What is left out: Ogg, anything in a Matroska file we cannot build a decoder
configuration for, and any clip whose codec this browser decodes only in its
`<video>` element (10-bit HEVC on Safari, AV1 on Safari). (Trimmed clips no
longer belong on this list — they get the precise engine wherever it's available
— and unindexed clips no longer exist: they're refused outright.)

**7. The precise engine has no audio.**
Frame-exact playback is silent. Anything needing synced sound is stuck on the
plain browser player.

## Things that are slow / wasteful (work correctly, but cost the user time)

**FIXED: 8. Reopening the same clip re-does all the opening work.**
There's no memory of a clip you've already opened — reopen it and you pay the
full cost again, which for a large WebM means sitting through the whole scan a
second time.

**9. Non-web-optimized MP4s open slowly on high-latency connections.**
A clip that isn't laid out for streaming can take many back-and-forth round
trips before the first frame appears — seconds of blank pane on a phone or a
distant cloud bucket, even for a small file.

---

## Status

- [x] **1** — HDR / iPhone mid-playback crash — *fixed.* `createBestEngine` now
  recognizes WebKit + 10-bit HEVC from the container's codec string and routes
  straight to the native `<video>` element up front, so the crash never happens
  and the clip stays frame-exact via the index. The reactive fatal-error fallback
  remains the net for anything not yet in the table.
- [x] **2** — Trimmed videos lose frame accuracy — *fixed.* The index now honors
  a trimming edit list, numbering frames over just the presented window, so both
  engines play the trim frame-exact (Chromium/WebCodecs everywhere). Where a
  browser exposes the trimmed clip's `<video>` timeline inconsistently (WebKit),
  the native path refuses the clip rather than lie (the WebCodecs path plays the
  same trim frame-exact there).
- [x] **3** — WebM/MKV never gets the precise engine — *fixed.* The Matroska
  scan already walked past every block header on its way through the file, which
  is where a frame's byte range and keyframe flag are; it now records them, and
  reads the track's CodecID/CodecPrivate for a decoder configuration (H.264,
  HEVC, VP8, VP9, AV1). So a WebM/MKV reaches the WebCodecs engine — owned clock,
  `bitmapForFrame` — and an `.mkv` plays on Safari/iOS at all, which it did not
  before. A codec we cannot configure honestly keeps the frame-exact `<video>`
  tier it always had; nothing is guessed to widen the set. Ogg stays native-only
  (no browser's WebCodecs decodes Theora, so a sample table would have nothing to
  feed).
- [x] **4** — WebM timeouts degrade — *fixed (index or refuse).* A pass that
  blows its budget now refuses with a clear error instead of degrading to
  guessed frame numbers; the host can raise `indexTimeoutMilliseconds`, and the
  index cache (#8) makes a finished pass a once-per-clip cost.
- [x] **5** — Non-MP4/WebM containers are approximate only — *fixed (index or
  refuse).* There is no approximate mode at all anymore: every returned engine
  has a real per-frame timestamp table, and everything else throws a clear
  error. The frame-exact set also widened — fragmented MP4 is indexed by feeding
  every `moof` through mp4box, and Ogg/Theora by the engine's own page scan
  (`src/ogg.js`). HLS/segmented delivery, live streams, and raw elementary
  streams remain refused by design (no single indexable byte sequence exists).
  *Follow-ups left open:* an AVI `idx1` reader, or a whole-clip seek-stepping
  indexer for any short playable format, if either is ever worth it.
- [x] **8** — Reopening a clip re-does the work — *fixed.* Indexes that took
  longer than ~500 ms to build are cached in IndexedDB, keyed on proven content
  identity (`(name, size, lastModified)` for a File; URL + size + strong
  ETag/Last-Modified for a URL) and rebuilt on any doubt — a stale index would
  be a wrong index. Repeat opens of a big WebM/fMP4/Ogg are instant.
