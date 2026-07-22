// ==================================================================
// exact-video-engine.js — frame-perfect video playback for the browser.
// https://github.com/jasper-tms/exact-video-engine.js
//
// Why this exists: a native <video> playing via play() stochastically drops a
// frame near the start (Chrome's compositor swallows ~one inter-frame interval
// as the media clock spins up) and its currentTime->frame mapping drifts on
// non-integer / variable-frame-rate clips.
//
// Two engines, one surface. Both expose the same members (play/pause,
// currentFrame, currentFrameFloat, seekToFrame, ...) so a host can hold either
// one in the same variable and never branch on which it got:
//
//   VideoEngine        demuxes the container with mp4box.js, decodes every
//                      frame itself with a WebCodecs VideoDecoder, and presents
//                      onto a canvas on a clock it owns. Nothing is handed to a
//                      compositor, so no startup frame is dropped, and because
//                      the host reads the playhead from the same object that
//                      paints the pixels, a synchronized overlay cannot drift.
//                      It is authoritative: we DECIDE which frame is on screen.
//
//   NativeVideoEngine  plays through a real <video> element (hardware overlay,
//                      battery-friendly, plays containers and codecs WebCodecs
//                      cannot, and is the only path with audio). It is
//                      observational: we can only LEARN which frame the browser
//                      chose to present, which it reports through
//                      requestVideoFrameCallback.
//
// The integer frame index is the source of truth in both. What separates them
// is not the timestamps — requestVideoFrameCallback's `mediaTime` IS the
// presented frame's exact presentation timestamp — but the mapping from a
// timestamp to a frame *index*, which needs the table of every frame's PTS. A
// <video> element never exposes that table, so we read it out of the container
// ourselves, without decoding a single frame: from the moov for MP4 (mp4box),
// the moof fragments for fragmented MP4, the clusters for WebM, the pages for
// Ogg, and the idx1 / OpenDML index for AVI. Either way the same table goes to
// whichever engine ends up playing
// (see ContainerIndex), and a full-file pass worth caching lands in IndexedDB
// so it is paid once per clip (see index-cache). That is what makes the
// <video> path frame-exact on variable-frame-rate clips rather than merely
// close.
//
// createBestEngine() picks the best available combination for a given clip and
// browser, choosing between two exact tiers and otherwise refusing:
//
//   1. container index + WebCodecs   exact index, exact decode, owned clock
//                                    (MP4 and AVI: WebM's and Ogg's indexes carry
//                                    timestamps but no sample table to decode from)
//   2. container index + <video>     exact index, browser decode + presentation
//                                    (MP4, WebM, Ogg), read out through the
//                                    presented-frame clock (requestVideoFrameCallback)
//
// AVI is the one container that lives ONLY in tier 1: browsers do not reliably
// play AVI through a <video> element (Chromium and Firefox refuse it outright), so
// AVI gets no tier-2 fallback. That is exactly why its index (unlike WebM's and
// Ogg's) must be a full decode-order sample table with a decoder configuration —
// the WebCodecs engine is the only tier that plays it — and why an AVI whose codec
// WebCodecs cannot decode is refused rather than handed to a <video> element that
// would (on most browsers) reject it too. AVI's H.264 is stored Annex B but
// decoded in AVCC mode: WebKit's WebCodecs claims to support Annex B and then
// fails the decode, so the sample table's bytes are converted to length-prefixed
// AVCC (see src/avi.js) — the one form every engine decodes.
//
// There is no third tier. A clip whose container we cannot index, or a native-path
// browser with no requestVideoFrameCallback (so no exact presented-frame clock),
// is refused with a clear error rather than played with guessed frame numbers.
// This engine is the *exact* one: an engine it hands back always reports true
// frame indices, never inferred ones.
//
// Decode (engine 1) is windowed by GOP (group of pictures: a keyframe plus the
// frames that depend on it). To show a frame we decode just its GOP, cache the
// results as ImageBitmaps, and evict distant GOPs, so memory stays flat
// regardless of clip length (handles multi-minute clips).
//
// Classic (non-module) script whose host-facing globals are UrlRangeReader,
// FileRangeReader, ContainerIndex, VideoEngine, NativeVideoEngine,
// createBestEngine, and formatProgress (see createBestEngine's onProgress), so
// both module and non-module host pages can use it.
// mp4box.js (the `MP4Box` / `DataStream` globals) should be loaded first to
// index MP4s; WebM and Ogg indexing are built in and need nothing. Without
// mp4box an MP4 cannot be indexed and is refused, while WebM and Ogg still get
// tier 2.
//
// Neither engine touches the host page's DOM beyond the canvas or <video> it is
// given. Errors surface as an 'errormessage' CustomEvent whose detail.message
// is a human-readable string, or null when a previous error should be cleared;
// the host owns rendering (and translating) that message.
// ==================================================================

