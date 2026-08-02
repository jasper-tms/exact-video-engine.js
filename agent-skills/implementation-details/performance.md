# Performance strategy: round trips, read-ahead, memory

Three currencies are managed separately, because a test (or an optimization)
that watches only one will happily regress another: bytes off the network,
round trips, and bytes held in memory. See testing.md for how each is pinned.

## Opening a clip: round trips first

Opening a clip is a chain of *dependent* reads — learn the size, sniff the
container, find the `moov`, read the frame — so they cannot be issued in
parallel and their latencies add up. Against a bucket a few hundred
milliseconds away (Firebase Storage, Cloud Storage), those round trips *are*
the load time, whatever few bytes they carry.

So the first read is speculative and generous: one 256 KB range read answers
the file's size (every `206` names it in `Content-Range`), its magic number,
and — for a faststart MP4 — its whole `moov`. And a clip small enough to be
worth having outright (under 8 MB) is fetched outright rather than groped
through one range at a time, since anything scrubbing it will read most of it
anyway. Opening a typical few-MB clip costs **two** requests; a large one,
two or three. (`src/read-priority-gate.js` keeps read-ahead traffic from
starving the read the host is actually waiting on.)

## Read-ahead

`VideoEngine` decodes a window around the playhead so that playback and short
seeks come out of memory. The frame actually asked for is never held up by
it: `load()` and `ensureFrame(n)` fetch what that one frame needs and
resolve, and the window fills behind them. The default window is 56 frames
(about two seconds); `windowAhead: 0` turns read-ahead off for hosts that
only ever hold still (a thumbnail grab, a single-frame page) while still
decoding the requested frame.

## Memory: the ceiling is bytes, not frames

A decoded frame costs width × height × 4 bytes, so a window counted in
*frames* costs whatever the clip's resolution decides — the same 56-frame
read-ahead is tens of megabytes at 360p and hundreds at 1080p. That is not
merely wasteful on a phone: iOS decodes into a bounded pool of surfaces, and
an engine holding hundreds of megabytes of decoded frames exhausts it, at
which point WebKit kills the decode session outright (`VideoDecoder` reports
*"Decoder failure"* a second or two into playback, on big clips only).

So the ceiling is bytes — `cacheBytes`, default 96 MB — and the window is
whatever fits under it. At the default, a 360p clip keeps the full 56-frame
read-ahead, while a 1080p clip holds about a dozen frames: enough to play
without stalling, and far enough under the ceiling to leave the decoder its
surfaces. Frames cached for display are also downscaled to 1920 on the long
side, so a 4K clip costs the same per frame as a 1080p one
(`bitmapForFrame()` hands back that bitmap, in coded orientation). Lowering
`cacheBytes` shrinks read-ahead first and history second; it never changes
which frames are *available*, only how many are held in memory at once.

## What the cache holds: a window on the playhead, not a log of everything seen

The resident frames track *where playback is now*, not everywhere it has been.
`_evict` keeps a "keep window" around each active centre — the playhead, plus
any frame `ensureFrame` is separately steering toward — running from that
frame's GOP keyframe (or `_windowBack`, whichever reaches further back) forward
through the read-ahead, and drops everything else. Crucially this runs on every
`_request`, not only when a newly decoded frame breaches the byte budget: a
seek relocates the window immediately, so the frames around the *previous*
location are dropped at once rather than lingering until enough new frames were
decoded to force eviction. (They used to linger indefinitely on a paused seek,
where the new region plus read-ahead often stayed just under budget and no
eviction ever ran — an emergent effect of budget-only eviction, visible as
stray cached segments left behind the old playhead in `demo.html`.)

The keyframe back-edge is deliberate. Reaching a frame mid-GOP means decoding
its whole run from the keyframe forward anyway, so those frames pass through the
decoder whether or not they are kept; holding them (as far as the byte budget
allows) makes short backward steps after a seek free, up until the step crosses
the previous keyframe into a GOP that would have to be decoded afresh. When
read-ahead is full the budget spends itself there and little of the run
survives; when it is not — a seek near the clip's end, say — the slack holds
more of the run instead.
