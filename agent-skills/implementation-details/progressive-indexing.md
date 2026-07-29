# Progressive indexing: `playWhileIndexing` and the certified prefix

A full-file indexing pass (Matroska, fragmented MP4) can take long enough
that a progress bar is still a bar. With `playWhileIndexing` set, the pass
hands back a playable engine as soon as `minimumIndexedFramesBeforePlayback`
frames are certified, and keeps indexing the rest underneath it. The
machinery lives in `src/certified-prefix.js` and
`src/frame-reorder-bound.js`.

## The invariant

This is not "index or refuse" relaxed, but restated at the level it actually
holds:

> **Every frame number this engine reports is exact and permanent. The set of
> frames it is willing to report grows.**

Display indices are append-only and immutable. If frame 412 ever came to mean
a different picture once more of the file had been read, a host that had
already written an annotation against 412 would have been handed exactly the
silent off-by-one this library exists to prevent. So a frame is published
only once **no frame still to be read can present before it** — the
*certified* prefix.

## Proving a frame is final

How far behind the scan the certification runs depends on the codec, and on
what the container or stream *proves* rather than on what muxers usually do:

- **VP8 and VP9** do not reorder frames for presentation, so storage order
  *is* presentation order and a frame is certified the moment the next one is
  read. Effectively no lag; this is most real `.webm`.
- **H.264 and HEVC** declare how far they reorder, in their own sequence
  parameter set — H.264's `max_num_reorder_frames` in the VUI, HEVC's
  `sps_max_num_reorder_pics` — and that beats anything the container knows.
  Both mean *the greatest number of frames that may precede a frame in decode
  order and follow it in presentation order*, typically 0, 1 or 2. Read
  backwards it is a watermark: once a frame has N + 1 frames at or after its
  own presentation time already in hand, an unread frame landing before it
  would have to displace all N + 1, which the stream is not allowed to do. So
  the lag is a handful of frames rather than a span of time. Where H.264
  writes no VUI at all, the specification's own inference applies — a
  conforming stream can never reorder past its level's
  decoded-picture-buffer capacity — so there is a bound either way.
- **AV1 in Matroska**, and anything whose setup record we cannot read, falls
  back to what the container proves: a block's timestamp is its cluster's
  plus a *signed 16-bit* offset, so the honest bound is that window — 32768
  ticks, or 32.8 seconds at the default 1 ms timestamp scale. A clip shorter
  than that, or one written as a single cluster, certifies nothing early and
  simply indexes in one pass — the correct conservative answer, not a
  failure.

Both are proofs, so whichever is tighter is used. A stream that breaks its own
declaration is not papered over: a frame arriving before one already
published means the numbers already handed out are wrong, so the clip is
refused outright (`CertifiedPrefixViolationError`) rather than kept as a
shorter index.

## Fragmented MP4

This works for fragmented MP4 as well as Matroska, and that is the case it is
worth the most for: fMP4 is what a recorder or a CMAF packager writes, so
"just uploaded, want it playing now" is its normal condition. There the
reorder declaration is the *only* bound available — nothing bounds an unread
`moof` the way the signed 16-bit block offset bounds an unread Matroska
cluster — so an fMP4 publishes early exactly when its stream declares its
reorder depth (H.264 and HEVC, which is nearly all of them) or cannot reorder
at all (VP8, VP9). An AV1 fragmented clip, or an `avc3`/`hev1` track keeping
its parameter sets in the frames rather than in the `stsd`, indexes in one
pass as before.

## State exposed to the host

`frameIndexState` is `growing` while the pass runs, then `complete`, or
`truncated` if the pass dies (a budget, a dropped connection, a corrupt
tail). Frames already published *stay* — they were certified before they went
out; `numFrames` just stops rising, and an `indextruncated` event plus a
fatal `errormessage` tell the host. Nothing is cached in the truncated state.
`duration` is the length indexed so far; `expectedDuration` is the length the
container *declares* (Matroska's `Info/Duration`), fixed from the first
publish, `0` when the file declares none — a claim for sizing scrubbers, and
never a mapping input, because it names no frame.

While playback catches up to the indexer, the engine holds the playhead at
the last indexed frame (`waitingForIndex` true) rather than looping — a stall
on the indexer is not the end of the clip.

## Deliberate limits

- **Off by default**: a growing `numFrames` is not what existing callers
  expect.
- **WebCodecs tier only**: a `<video>` element plays the whole clip whether or
  not we have named its frames yet, so it would be asked within seconds which
  frame is on screen for an uncertified part of the clip. The WebCodecs
  engine can hold the playhead because it owns the clock; the native path
  cannot, so it refuses a growing index outright. Ogg, which has no WebCodecs
  tier, is unaffected.
