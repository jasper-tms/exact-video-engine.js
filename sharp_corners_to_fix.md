# Sharp corners to fix

What's currently broken or unsupported from a user's point of view — phrased as
"someone tries to do X, and here's what goes wrong." Internal machinery left out
so these can be prioritized on impact alone.

## Things you simply can't do

**1. You can't pull a specific frame's pixels unless you're on the precise engine.**
Thumbnail generation, "extract frames A–B," grabbing a still off an upload — all
only work on the precise path. That path covers MP4, AVI, and WebM/MKV (H.264,
HEVC, VP8, VP9, AV1) wherever the browser's decoder can take the codec. Left
out: Ogg, anything in a Matroska file we cannot build a decoder configuration
for, and any clip whose codec this browser decodes only in its `<video>`
element (10-bit HEVC on Safari, AV1 on Safari). Trimmed clips get the precise
engine wherever it's available, and unindexed clips don't exist — they're
refused outright.

**2. The precise engine has no audio.**
Frame-exact playback is silent. Anything needing synced sound is stuck on the
plain browser player.

## Things that are slow / wasteful (work correctly, but cost the user time)

**3. Non-web-optimized MP4s open slowly on high-latency connections.**
A clip that isn't laid out for streaming can take many back-and-forth round
trips before the first frame appears — seconds of blank pane on a phone or a
distant cloud bucket, even for a small file.

---

## Possible follow-ups (not yet user-impacting, but worth doing)

- **Whole-clip seek-stepping indexer.** For a short clip in a format with no
  dedicated indexer (and no OpenDML/idx1-style index to read), stepping
  through it via seeks could still build a frame-exact table. Nothing does
  this today — those formats just get refused.
