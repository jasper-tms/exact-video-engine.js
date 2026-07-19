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
// and by scanning the clusters for WebM. Either way the same table goes to
// whichever engine ends up playing (see ContainerIndex). That is what makes the
// <video> path frame-exact on variable-frame-rate clips rather than merely
// close.
//
// createBestEngine() picks the best available combination for a given clip and
// browser, degrading in this order:
//
//   1. container index + WebCodecs   exact index, exact decode, owned clock
//                                    (MP4 only: WebM's index carries timestamps
//                                    but no sample table to decode from)
//   2. container index + <video>     exact index, browser decode + presentation
//                                    (MP4 and WebM)
//   3. declared frame rate + <video> exact for constant-frame-rate clips only
//   4. no requestVideoFrameCallback  currentTime * frameRate; last resort
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
// index MP4s; WebM indexing is built in and needs nothing. Without mp4box an MP4
// falls to step 3/4, while a WebM still gets step 2.
//
// Neither engine touches the host page's DOM beyond the canvas or <video> it is
// given. Errors surface as an 'errormessage' CustomEvent whose detail.message
// is a human-readable string, or null when a previous error should be cleared;
// the host owns rendering (and translating) that message.
// ==================================================================

