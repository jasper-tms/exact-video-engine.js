# How the native `<video>` tier stays frame-exact

`NativeVideoEngine` (`src/native-video-engine.js`) is *observational*: the
browser decides which frame is on screen, and the engine finds out
afterwards, through `requestVideoFrameCallback`. That costs the authoritative
guarantees of the WebCodecs tier (a dropped startup frame stays dropped), but
it does not have to cost knowing *which* frame is on screen — which is the
part most fallbacks get wrong.

## `mediaTime` → frame index

`requestVideoFrameCallback`'s `mediaTime` **is** the presented frame's exact
presentation timestamp — not an estimate. Given the container's per-frame
timestamp table (see indexing.md), the engine binary-searches `mediaTime`
into an exact frame index, correct even on variable-frame-rate clips. Without
the table, a timestamp cannot become an index — which is why the usual
fallback (multiply by an assumed constant frame rate) quietly mismaps
variable-frame-rate clips, and why this engine refuses to run without an
index.

One browser quirk is deliberately tolerated: after a programmatic seek,
Firefox's `requestVideoFrameCallback` echoes the seek target rather than the
landed frame's real timestamp. Post-seek readbacks are therefore exempt from
the disagreement watcher below — the echo says nothing about the table.

## Timeline calibration and edit lists

Two things are load-bearing, and both are tested (see testing.md):

- **The element's timeline is not always the container's.** A clip carrying an
  edit list presents its first frame at a nonzero `mediaTime`. The engine
  calibrates the offset at load by anchoring on the first presented frame,
  whose identity it knows.
- **A trimming edit list is honored, not guessed at.** A clip trimmed to
  start and end partway in — the container still holds every source frame,
  but the edit list presents only a window of them — is numbered over just
  that presented window, so display frame 0 is the first frame the viewer
  sees. (The decoder still runs the frames before the trim point to
  reconstruct the first presented one; they are never shown.) Where a browser
  mishandles such a clip's `<video>` timeline, the native path refuses the
  clip rather than report frame numbers the element is not actually showing:
  WebKit runs `currentTime` on the media timeline yet reports the shorter
  edited duration (leaving the tail frames unreachable, which the calibration
  detects), and Gecko presents the untrimmed frames outright — a whole-frame
  shift no runtime check can see, so it is refused up front. The WebCodecs
  path is frame-exact on the trim everywhere, and it is what the auto ladder
  picks for these clips anyway.

## Load-time deadline for silent non-decoders

A browser that can demux a container but cannot decode what is inside it
often reports no error at all: it parses the metadata, goes quiet with every
byte in hand, and never presents a frame (WebKit does this with AV1 in WebM).
With no deadline that is an unbounded wait inside `load()`, so the native
path gives up after ten seconds *of no progress at all*. Bytes still arriving
keep rearming the deadline, so a slow download is never cut off by it.

## The runtime disagreement watcher

Honesty does not end at load. Each frame the element presents during playback
is checked against the table, and if they sustainedly disagree the engine
latches `failed`, flips `frameIndexIsExact` to false, and emits a fatal
`errormessage` (`detail.inexact: true`). It never silently degrades: an
engine that reports frame numbers it cannot stand behind is worse than no
engine.

## Startup-frame identity

`currentTime` is mapped so display frame 0 sits at t = 0 in both engines, and
`currentFrame` on this engine is presentation-clamped — it reports where the
element has actually settled, not merely where a seek aimed. Precise mapping
between the element's clock and frame indices lives entirely in this module;
`VideoEngine` never needs it because it owns its clock outright.
