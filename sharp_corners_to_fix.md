# Sharp corners to fix

What's currently broken or unsupported from a user's point of view — phrased as
"someone tries to do X, and here's what goes wrong." Internal machinery left out
so these can be prioritized on impact alone.

## Things that visibly break

**1. HDR / iPhone videos crash partway through playback.**
A video shot on a recent iPhone (the default HDR / 10-bit format) can start
playing, then die a second or two in — on iPhones, and also in desktop Safari.
Whether the user recovers depends entirely on the app around it catching the
failure and reloading; on its own, the player just stops. This is the single
most common real-world "it worked on my laptop but broke on my phone" report.

**2. Trimmed videos lose frame accuracy.**
If a clip has been trimmed so it starts partway in, the player refuses to guess
and drops to *approximate* frame numbers. So a trimmed clip can't be annotated
or seeked frame-accurately — the one thing this library exists to guarantee
quietly stops being guaranteed for that clip.

## Things that silently degrade (no crash, but wrong or fuzzy)

**3. WebM never gets the precise engine.**
A `.webm` clip only ever plays through the plain browser player, and is only
frame-accurate if the app finishes reading it in time. It can never hand back
pixels for a named frame (see #6).

**4. Big WebM files (or slow connections) time out into approximate mode.**
Opening a WebM means reading through the whole file. A large one, or a slow
link, blows the deadline — the user waits, watches a progress bar, and then gets
*degraded* frame accuracy as the reward. The bigger the file, the worse this
gets.

**5. Anything that isn't MP4/MOV or WebM is approximate only.**
Ogg, streaming formats (HLS), and other containers play, but with guessed frame
numbers. No error, just silently not frame-exact.

## Things you simply can't do

**6. You can't pull a specific frame's pixels unless you're on the precise engine.**
Thumbnail generation, "extract frames A–B," grabbing a still off an upload — all
only work on the precise (MP4-on-capable-browser) path. On iPhone/Safari, on
WebM, or on any trimmed/unindexed clip, that capability just isn't there.

**7. The precise engine has no audio.**
Frame-exact playback is silent. Anything needing synced sound is stuck on the
plain browser player.

## Things that are slow / wasteful (work correctly, but cost the user time)

**8. Reopening the same clip re-does all the opening work.**
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
  the native path degrades honestly to approximate rather than lie.
