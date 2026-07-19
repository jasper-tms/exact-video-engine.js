---
name: decode-support-matrix
description: MUST load before diagnosing any exact-video-engine.js playback or
  decode failure — especially a video that plays on desktop but fails on
  iPhone/mobile ("Decoder failure" mid-playback), or any question about which
  codecs each backend (WebCodecs VideoEngine vs native <video>) can decode.
  Contains the empirically tested codec support matrix (10-bit HEVC, Dolby
  Vision, High 10 H.264, WebM), why isConfigSupported lies on WebKit, which
  failures the automatic fallback does and does not catch, and what format to
  transcode uploads to. Code inspection alone gives wrong answers here; this
  matrix comes from real-device testing.
---

# Decode support by backend

The engine has two backends behind one interface: `VideoEngine` (WebCodecs —
demuxes with mp4box, decodes every frame itself) and `NativeVideoEngine`
(`<video>` element — the browser decodes and presents). `createBestEngine()`
picks per clip. This skill records which real-world video formats each backend
can actually decode, established by hands-on testing (2026-07, engine v1.6.x).

## Frame-exactness is decided by the index, not the decoder

Container indexing is codec-agnostic and separate from decoding:

- **mp4box indexes ISO-BMFF only** (MP4/M4V/MOV). It reads the sample table
  without touching encoded pixels, so 10-bit HEVC, Dolby Vision, and any other
  exotic codec parse fine. The index is handed to **whichever** backend plays,
  so the native engine stays frame-exact for any indexed clip.
- **Fragmented MP4** (`mvex`/`moof`, the DASH/CMAF shape) is indexed by feeding
  the whole file through mp4box so every fragment's samples land in the table —
  a full-file read with the same deadline/byte budget and progress reporting as
  the WebM scan, but a complete index (sample table included), so fragmented
  clips play through WebCodecs like classic ones.
- **WebM** and **Ogg/Theora** have built-in indexers (timestamps only, no
  sample table to decode from), so they never get the WebCodecs backend — only
  frame-exact `<video>` playback.
- No index at all → the clip is REFUSED with a clear error ("index or refuse",
  see the README). There is no approximate mode: `declaredFrameRate` /
  `allowApproximate` no longer exist, and every engine `createBestEngine`
  returns has `frameIndexIsExact` true. An indexing pass that blows its budget
  refuses too; the IndexedDB index cache (`src/index-cache.js`) makes a
  finished full-file pass a once-per-clip cost.

So "can this backend decode it" (below) never affects whether frame numbers
are trustworthy — only which pixels-producing path is available.

## WebCodecs support is per-browser-engine, and the API lies

`VideoDecoder` capability differs by **browser engine**, not device: Chromium
(desktop Chrome/Edge) is the most complete, with software fallbacks; WebKit
(ALL iOS browsers, including Chrome-on-iOS, plus desktop Safari) is younger
and has holes its own feature detection does not report.

The dangerous class is the **dishonest yes**: WebKit answers
`isConfigSupported()` = true for a format whose hardware exists (it's the
iPhone's own camera format), decodes the first keyframe, then the decoder
dies once sustained decoding starts. `VideoEngine.load()` validates support
via `isConfigSupported` plus a decode of frame 0 — both pass — so
`createBestEngine`'s load-time fallback never fires, and the user gets a
hard mid-playback error. An **honest no** (rejection at load) is always safe:
`createBestEngine` silently swaps to the native engine.

## Two distinct iOS "Decoder failure" classes — don't conflate them

WebKit reports the same *"Decoder failure"* string for two different problems:

1. **Decoded-frame memory pressure** (any codec, big resolutions): iOS decodes
   into a bounded pool of surfaces, and an engine holding hundreds of
   megabytes of decoded frames exhausts it. This is why the frame cache is
   budgeted in BYTES, not frames (v1.6.0; see README "the ceiling is bytes").
   Fixed for reasonable clips since then; symptom before the fix was
   big-clips-only failure a second or two into playback.
2. **10-bit HEVC on WebKit** (this skill's matrix): still fails at v1.6.1,
   byte budget notwithstanding, on a 13-second 1080p clip whose 8-bit HEVC
   re-encode plays fine. Root cause is strongly suspected to be WebKit's
   WebCodecs plumbing for 10-bit output frames rather than memory (the
   engine's ImageBitmap cache costs the same bytes either way), but as of
   2026-07-13 that is not proven: the clean discriminating test — a
   small-resolution (e.g. 320×180) 10-bit HEVC clip, which removes memory
   from the equation — has not been run. If you run it, record the result
   here.

## The tested matrix

| Format | WebCodecs, WebKit/iOS | WebCodecs, Chromium desktop | Native `<video>` |
|---|---|---|---|
| H.264 8-bit (High/Main) | works | works | works |
| HEVC 8-bit | works | works where the platform decodes HEVC | works |
| **HEVC Main 10** (iPhone HDR default, with or without Dolby Vision profile 8) | **dishonest yes: claims support, decodes frame 0, dies mid-stream** | works | works |
| H.264 High 10 (no hardware decoder exists anywhere) | honest no at load → auto-fallback to native, invisible | works (software decode) | works (software decode) |
| WebM (VP8/VP9) | never attempted (no mp4box index) | never attempted | works where the browser plays WebM |

Findings behind the HEVC Main 10 row (bisected with single-variable variant
files): stripping the Dolby Vision RPUs alone does **not** fix it; re-encoding
to 8-bit HEVC **does**; so the trigger is 10-bit HEVC in WebKit's WebCodecs
path, not Dolby Vision and not the .MOV container (see the two-classes
section above for the one alternative not yet ruled out). The same phone
plays the same file perfectly through `<video>` (AVFoundation) — the hardware
is fine, the WebCodecs plumbing is not.

## Practical guidance

- **Proactive routing (current):** `createBestEngine` now recognizes the confirmed
  dishonest-yes combination — WebKit + 10-bit HEVC — from the container's declared
  codec string and routes straight to the native `<video>` element BEFORE
  attempting WebCodecs, so the mid-stream crash never happens and the index keeps
  the native path frame-exact. It is `detectBrowserEngine()` (navigator.vendor ===
  'Apple Computer, Inc.' for all WebKit) + `isTenBitHevc()` (HEVC general_profile_idc
  2, or Dolby Vision dvh1/dvhe) in `src/decode-support.js`, wired into the ladder.
  The table is intentionally tight (a false positive gives up the owned clock), so
  the reactive fatal-fallback below is still the net for anything it does not name
  (e.g. Range-Extensions high-bit-depth HEVC, or a future WebKit regression). If you
  confirm another dishonest-yes combination, add it to `webCodecsMayFailMidStream`
  AND record it in the matrix above.
- Since v1.7.0, a mid-stream `VideoDecoder` death sets `engine.failed`, makes
  `ensureFrame()` reject promptly, and emits `errormessage` with
  `detail.fatal: true` plus diagnostics (`errorName`, `codec`, `frame`). The
  engine still does not swap itself — the HOST owns both surfaces — but both
  known consumers (movim-website's FramePlayer and SportViewer) respond to
  the fatal flag by rebuilding with `createBestEngine(source, { prefer:
  'native' })` at the same playhead. Both engines also expose `codecString`
  (the container-declared codec) so hosts can predict format trouble.
- movim-website additionally routes around the whole class server-side:
  `functions/remux.js` writes an 8-bit H.264 `playback` display copy for any
  upload whose pixel format is not 8-bit 4:2:0, and the frame player prefers
  the native engine outright on mobile (nothing there needs the WebCodecs
  owned clock). SportViewer keeps WebCodecs first — its mesh sync needs the
  owned playhead — and relies on the fatal fallback.
- To reproduce iOS WebKit decode bugs without a phone: desktop **Safari** is
  the same WebKit + VideoToolbox stack (Apple Silicon also has HEVC Main 10
  hardware). **Confirmed 2026-07-13**: a 10-bit HEVC clip that hit "Decoder
  failure" on iPhone failed identically in desktop Safari — with a full Web
  Inspector available. This also means the dishonest-yes class is not
  mobile-specific: it is WebKit-wide, so "works on desktop" only means
  "works on desktop *Chrome*".
- Bit depth is the common thread of trouble: no browser gets universal
  hardware 10-bit decode, so 10-bit clips always land on some fallback tier
  that varies per browser (software decode, native engine, or a crash).
  A consumer that controls uploads gets the best-tier playback everywhere by
  transcoding anything that is not 8-bit yuv420p to 8-bit H.264 server-side.
- When testing a suspect format, test the *whole stream*, not the first
  frame: the dishonest-yes class passes every load-time check and fails only
  seconds into playback.
