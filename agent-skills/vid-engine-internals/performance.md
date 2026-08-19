# Performance strategy: round trips, read-ahead, memory

Three currencies are managed separately, because a test (or an optimization)
that watches only one will happily regress another: bytes off the network,
round trips, and bytes held in memory. See vid-engine-test-coverage.md for how each is pinned.

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

## Read-ahead: decoded frames, and encoded bytes

`VideoEngine` decodes a window around the playhead so that playback and short
seeks come out of memory. The frame actually asked for is never held up by
it: `load()` and `ensureFrame(n)` fetch what that one frame needs and
resolve, and the window fills behind them. The default window is 56 frames
(about two seconds); `windowAhead: 0` turns read-ahead off for hosts that
only ever hold still (a thumbnail grab, a single-frame page) while still
decoding the requested frame.

The encoded bytes are read ahead separately, on their own budget. A decoded
frame costs about a thousand times what its encoded bytes do, so how far ahead
the bytes are fetched must not fall out of how many frames fit under
`cacheBytes` — at 1080p that is a dozen frames, a fraction of a second, which
does not cover a round trip to a distant bucket. `_ensureBytes` reads in 4 MB
blocks (`MAX_BLOCK`), and during playback the next block is always in flight
(`_prefetchNextBlock`), so the decode driver crosses a block boundary by
adopting bytes already in hand rather than stopping to wait for them. The block
just left behind stays resident until the next seek: a decode run restarts
from its GOP's keyframe when the target crosses into a new GOP, and that
keyframe can sit at the tail of the previous block.

How many blocks are banked ahead adapts to the link (`_prefetchDepth`): one,
until a boundary is crossed out of a full block with the prefetch still in
flight — a whole block's consumption time was not enough head start, so the
link has jitter one block of cover cannot absorb — after which two are kept.
(A boundary out of a *partial* buffer, the landing read moments after play
begins, says nothing about the link and does not escalate.) A new prefetch is
only issued once every queued one has resolved, so a struggling link never
has speculative requests stacked on it. The depth describes the link, not the
clip, so it survives seeks and loads within the engine's lifetime. At most
four blocks are resident — previous, current, and up to two prefetched —
16 MB, outside `cacheBytes`.

A read shrinks below the block size (to what the target frame depends on,
floored at 256 KB) only while the viewer is *landing* on a frame: the first
frame of the clip, any paused seek or step, and the first read after a seek
during playback. Once playback is flowing, an uncached target means the
decoder has fallen behind the wall clock, and a small read there — one round
trip per quarter megabyte, with the clock running on through every one — turns
a slow link into a collapse. So playback reads full blocks, and lands only once
per move of the playhead (`_landing`, set by `update()` when the playhead is
not where the last tick left it). `test/stall-test.mjs` pins all of this.

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
read-ahead, while a 1080p clip holds about a dozen frames: far enough under
the ceiling to leave the decoder its surfaces, and enough to absorb decode
jitter — network latency is the encoded-byte prefetch's job, above. Frames cached for display are also downscaled to 1920 on the long
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
