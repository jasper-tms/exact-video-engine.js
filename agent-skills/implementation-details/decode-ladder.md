# The engine-selection ladder and the refusal taxonomy

`createBestEngine()` (`src/create-best-engine.js`) picks the best combination
available for a given clip and browser:

| | Index from | Presentation | Frame index |
| --- | --- | --- | --- |
| 1. WebCodecs (`VideoEngine`) | container (MP4, WebM/MKV, or AVI) | engine-owned canvas | exact |
| 2. `<video>` + index (`NativeVideoEngine`) | container (MP4, WebM/MKV, or Ogg) | browser | exact |

Tier 2 is the one that usually does not exist in other libraries. It covers
browsers without WebCodecs (Safari before 16.4, older Firefox), codecs the
platform decoder rejects, Ogg (whose index carries timestamps but no sample
table for WebCodecs to decode from), and any host that needs audio or the
battery-friendly hardware overlay path — none of which have to settle for
guessing at frame numbers.

There is no tier 3. `prefer: 'native'` lets a host skip tier 1 (used when
recovering from a mid-playback decoder death — see the user-guide skill).

## Index or refuse

One rule: every clip we agree to analyze has a real per-frame
presentation-timestamp table, read from the container without decoding a
frame. `createBestEngine` throws — with an error message a host can show —
rather than play a clip it would have to guess about:

- **A container we cannot parse** (HLS/MPEG-TS or other segmented delivery,
  live streams, raw elementary streams — anything not MP4/MOV, WebM/MKV, Ogg,
  or AVI). No table can exist. An AVI whose *codec* this browser cannot decode
  is refused here too: AVI has no native fallback, so an index it cannot
  decode from is useless.
- **An indexing pass that ran out of its budget** (`indexTimeoutMilliseconds`
  / `indexMaxBytes`) before naming a single frame. A partial table is a wrong
  table — unless every frame in it was *certified* as final before it was
  handed out, which is what progressive-indexing.md is about.
- **A browser without `requestVideoFrameCallback`, when the clip must play
  natively.** Even a perfect index cannot say which frame a `<video>` element
  is showing without the presented-frame clock — raw `currentTime` keeps
  advancing through decoder stalls while the picture is frozen. The clock has
  shipped everywhere current (Safari 15.4+, Firefox 132+, any recent
  Chromium), so this refusal only bites genuinely outdated browsers, and only
  for clips WebCodecs cannot take.
- **An element that loads the clip's metadata and then never presents a
  frame.** A browser that can demux a container but cannot decode what is
  inside it often reports no error at all: it parses the metadata, goes quiet,
  and never produces a picture (WebKit does this with AV1 in WebM). With no
  deadline that is an unbounded wait inside `load()`, so the native path gives
  up after ten seconds *of no progress at all* — bytes still arriving keep
  rearming the deadline, so a slow download is never cut off by it.
- **A container whose table disagrees with what the element actually
  presents** (a trimming edit list the browser mis-times, a truncated file
  whose tail the scan never saw). Caught at load by comparing durations and
  calibrating the timeline — see native-engine-exactness.md.

## `UnplayableClipError`

Every refusal throws an `UnplayableClipError` (`src/unplayable-clip.js`): an
`Error` (so existing `catch (error) { show(error.message) }` code keeps
working) carrying machine-readable fields. `reason` is one of the exported
`UNPLAYABLE_REASONS`: `container-not-indexable`, `codec-not-decodable`,
`no-fallback-element`, `no-presented-frame-clock`, `timeline-unmappable`.
Alongside it, whichever are known: `codec`, `codecName` (via
`describeCodec()`, exported for hosts writing their own wording),
`containerFormat`, `numFrames`, `triedWebCodecs`, `webCodecsMessage`,
`nativeErrorCode`, `nativeErrorMessage`, and `suggestion`. A field that is not
known is absent rather than null, so `'codec' in error` means what it says.

Two rules about how the message is built:

- **It is composed in `createBestEngine`**, because that is the only place
  that knows the *whole* ladder — a clip whose codec WebCodecs rejected *and*
  whose `<video>` element then failed is a different thing from either half.
- **It is composed from what the engine reasoned, never from the browser's
  own error text.** On the same undecodable file Chromium, Firefox, and WebKit
  report structurally different things (or nothing). What the browser said
  travels as `nativeErrorMessage`, to be logged rather than shown or parsed,
  so the same file produces the same sentence everywhere. Example:

  > Its codec, MPEG-4 Part 2 (`mp4v.20.1`), is not one this browser can decode
  > — WebCodecs rejected it and the `<video>` element could not play it
  > either. The container itself is fine: it indexed cleanly as isobmff with
  > 200 frames, so nothing is wrong with the file.

  Indexing an undecodable container anyway is what makes that message
  possible: knowing the clip is `mp4v.20.1` in a well-formed MP4 of *n* frames
  lets the failure say so, instead of a flat "not a format we can index" for a
  file that indexes perfectly well. The `suggestion` field can then carry a
  concrete re-encode command (`ffmpeg -i in.mp4 -c:v libx264 -crf 18 out.mp4`).

## Predictive routing: codecs a browser accepts and then fails on

WebCodecs feature detection is not always honest. WebKit (desktop Safari and
every iOS browser) answers `isConfigSupported()` = true for **10-bit HEVC** —
the iPhone's own HDR camera format — decodes the first keyframe, and then the
decoder dies a second or two into sustained playback. Both the support check
and the frame-0 decode pass, so the ladder's load-time fallback never sees it.

`createBestEngine` recognizes that combination up front
(`src/decode-support.js`) and routes straight to the `<video>` element, which
decodes the same clip fine through the platform's own path, with the
container index keeping it frame-exact. This table is deliberately tight — a
false positive needlessly gives up the WebCodecs owned-clock path — so it
names only the combination confirmed to crash, and the fatal `errormessage`
event remains the reactive net for anything else. The pieces are exported for
a host that wants to make the same prediction itself (flagging an upload for
server-side transcoding, say): `detectBrowserEngine()`,
`isTenBitHevc(codecString)`, and `webCodecsMayFailMidStream(codecString,
browserEngine)`.

For the tested per-browser support matrix behind these decisions, load the
sibling **video-format-support-per-browser** skill.

## Honesty after load

Each frame the native element presents during playback is checked against the
table, and if they sustainedly disagree the engine latches `failed`, flips
`frameIndexIsExact` to false, and emits a fatal `errormessage`
(`detail.inexact: true`) — it never silently degrades. (Post-seek readbacks
are exempt: after a programmatic seek Firefox's `requestVideoFrameCallback`
echoes the seek target rather than the landed frame's real timestamp, which
says nothing about the table.)
