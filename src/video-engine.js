import { ContainerIndex } from './container-index.js';
import { convertAnnexBToAvcc } from './avi.js';
import { beginPriorityRead, endPriorityRead } from './read-priority-gate.js';
import { ImageFrameDecoder, isImageFrameCodec, canDecodeImageFrames } from './image-frame-decoder.js';
import { UnplayableClipError } from './unplayable-clip.js';
import { UrlRangeReader } from './range-readers.js';
import { decoderConfigFrameReorderDepth } from './frame-reorder-bound.js';

// Frames the cache holds beyond the read-ahead window's far edge. Decoded
// frames arrive a little past the target while the playhead is still catching
// up, and evicting them the moment they land would mean decoding them twice.
const WINDOW_SLACK = 8;
// Never shrink the window below this, whatever the byte budget says: a cache
// that cannot hold the frame being decoded plus its neighbours would evict its
// own read-ahead and thrash.
const MINIMUM_WINDOW_FRAMES = 4;
// How far past a frame we keep feeding the decoder before concluding the frame
// is not going to come out. Decoders hold frames back to settle display order,
// so a frame we asked for can legitimately lag the samples we fed — past that
// lag, it is not in the pipeline: it was decoded earlier and evicted, and it has
// to be decoded again rather than waited for.
//
// The lag is the clip's, not a constant. An H.264 stream that declares no
// max_num_reorder_frames makes the decoder assume its level's whole
// decoded-picture buffer — 15 frames for a level 5.1 screen recording at
// 2606x1172 — and Chrome's decoder was measured holding such a clip's frames
// back by up to 18 samples, past the old fixed bound of 16. Every such frame
// then tripped the restart circuit-breaker as "undecodable", and playback
// updated only once per keyframe. So the bound is the stream's declared reorder
// depth plus DECODER_PIPELINE_SLACK for the decoder's own pipeline, never less
// than MINIMUM_REORDER_DEPTH.
const MINIMUM_REORDER_DEPTH = 16;
const DECODER_PIPELINE_SLACK = 8;
// Encoded bytes are read in blocks of this size — one fat request beats twenty
// thin ones — and never in blocks smaller than MIN_BLOCK, since a round trip
// costs more than those bytes. This is the encoded-byte read-ahead's own budget,
// deliberately separate from cacheBytes: a decoded frame costs about a thousand
// times what its encoded bytes do (a 4 MB block is 4 s of a 1080p clip, four
// decoded 1080p frames are 33 MB), so how far ahead the BYTES are fetched must
// not be governed by how many FRAMES fit in memory. At most four blocks are
// held at once — the one being decoded, the one before it, and one or two
// prefetched behind it (_prefetchDepth) — 16 MB.
const MAX_BLOCK = 1 << 22;   // 4 MB
const MIN_BLOCK = 1 << 18;   // 256 KB
// How long a paused playhead must sit still before the viewer counts as having
// LANDED somewhere rather than scrubbing through it (see update).
const SETTLE_MILLISECONDS = 500;
// How far ahead of a loop wrap (in composition-time seconds) to begin warming
// the loop origin's encoded bytes, so the read from the start of the file that
// the wrap triggers is already in hand. Enough to cover a round trip to a
// distant bucket, short enough not to fetch on a clip that merely has looping
// enabled but is nowhere near wrapping.
const LOOP_PREFETCH_LEAD_SECONDS = 0.75;
// Rebuffering. While playing, if the frame under the playhead is not decoded
// yet, the owned clock HOLDS on the last frame rather than running on and
// leaving that frame (and every frame until it catches up) undrawn — the
// buffering pause an online player shows, in place of silent frame-dropping.
// The hold releases once REBUFFER_SECONDS worth of frames ahead of the playhead
// are decoded (options.rebufferSeconds; 0 disables the hold and restores the
// old run-the-clock-and-drop behaviour). A hold helps only while WAITING closes
// the gap: a network backlog drains at link speed whether the clock runs or
// not, but a machine that simply cannot decode this clip in real time would
// hold, spurt, drain, and hold again forever — slow motion, not smooth. So a
// decode-bound hold that recurs DECODE_STALL_LIMIT times without a full
// recovery in between concedes the point: the clock is let run and frames are
// dropped (realtime, the browser's own decode-behind behaviour) until decode
// has kept up for DECODE_RECOVERY_SECONDS. Counting a STREAK of un-recovered
// stalls rather than stalls-per-time-window matters because a badly outmatched
// decoder produces long holds — three two-second freezes are not "rapid", but
// they are exactly what the fallback exists to end. A network-bound stall
// always holds — dropping frames with no bytes in hand just races the clock
// past a frozen picture.
const DEFAULT_REBUFFER_SECONDS = 0.3;
const DECODE_STALL_LIMIT = 3;
const DECODE_RECOVERY_SECONDS = 3;   // seconds

// How long the decode driver waits before each retry of an encoded-byte read
// that failed, and so how many retries it makes before declaring the source
// gone. Only a URL source retries: a network blip or a briefly unreachable
// server can recover, and giving up at once would kill a clip over a hiccup. A
// File's read failing means the file on disk was moved, renamed, deleted, or
// changed since it was opened — nothing that waiting fixes — so it fails at
// once. (The retries matter for what they replace, too: before them a failed
// read was logged and retried on the very next tick, forever, from every
// update() call.)
const SOURCE_READ_RETRY_MILLISECONDS = [500, 1000, 2000, 4000];

// A read of the clip's encoded bytes failed: the source itself, not the decoder.
// Thrown from _ensureBytes so the decode driver can tell the two apart.
class SourceReadError extends Error {
  constructor(cause) {
    super(cause && cause.message ? cause.message : String(cause));
    this.name = 'SourceReadError';
    this.cause = cause;
  }
}

// ==================================================================
// VideoEngine — WebCodecs. Authoritative: we decide which frame is on screen.
// ==================================================================
export class VideoEngine extends EventTarget {
  // options.windowAhead: how many frames to decode ahead of the playhead. The
  // default (56, ≈2 s) is sized for playback, where read-ahead is what absorbs
  // decode jitter. A host that mostly holds still — a frame-by-frame annotation
  // tool, a thumbnail picker — is buying bandwidth and decode work it will not
  // use, and can turn this down. It does not affect which frames are available,
  // only how eagerly they are fetched: the frame you ask for is always decoded.
  // Infinity means "read as far ahead as cacheBytes allows": the window then
  // fills the whole byte budget instead of stopping at a frame count.
  //
  // options.windowBack: how many decoded frames to KEEP behind the playhead, so
  // a backward scrub finds them resident rather than re-decoding from a keyframe.
  // Default 18. Like windowAhead it is only a target the byte budget can cut, and
  // Infinity likewise means "hold as much history as cacheBytes allows".
  //
  // options.cacheBytes: the memory ceiling for decoded frames (default 96 MB).
  // This, not the windows, is what bounds the engine's memory — each window is
  // cut to fit it, so a 4K clip caches few frames and a 360p clip caches many.
  //
  // options.rebufferSeconds: how far ahead the decode must reach before playback
  // resumes from a buffering hold (default 0.3 s of decoded frames ahead of the
  // playhead). When the frame under the playhead is not yet decoded, the clock
  // holds on the last frame and waits — the buffering pause of an ordinary
  // online player — instead of running on and dropping frames. 0 turns the hold
  // off, restoring the older behaviour where the clock never waits for the
  // decoder. See the DEFAULT_REBUFFER_SECONDS block for how a decode-bound hold
  // that keeps recurring falls back to frame-dropping so a slow machine plays at
  // real time rather than in lurching slow motion.
  //
  // options.imageSmoothingEnabled: true by default, matching every prior
  // release — the presentation canvas is sized to the pane in device pixels
  // (_syncCanvasSize), which on a HiDPI screen is routinely larger than the
  // decoded frame, so the browser's default bilinear resampling makes ordinary
  // upscaled playback look smooth rather than blocky. A host reading or
  // displaying exact pixel values (an annotation tool matching source pixels
  // 1:1, say) wants the opposite: pass false to keep every presented frame an
  // exact, uninterpolated blow-up of the decoded one.
  constructor(presentationCanvas, options = {}) {
    super();
    this.canvas = presentationCanvas;
    this.context = presentationCanvas.getContext('2d');
    this.ready = false;
    this.playing = false;
    this.loop = true;
    this._playbackRate = 1;
    // The optional loop region (see the loopStartFrame/loopEndFrame accessors).
    // Null means "the whole clip", which is the ordinary case.
    this._loopStartFrame = null;
    this._loopEndFrame = null;

    this.playhead = 0;          // seconds on the composition timeline
    this.duration = 0;
    this.numFrames = 0;

    this._index = null;
    this._reader = null;
    this._videoDecoder = null;
    this._decoderConfig = null;
    this._reorderDepth = MINIMUM_REORDER_DEPTH;   // set per clip in _adoptIndex
    this._declaredReorderDepth = 0;               // likewise
    // True when the index's samples are an Annex B bitstream (AVI's H.264) that
    // must be converted to length-prefixed AVCC before the decoder — which is
    // configured in AVCC mode — will accept them. False for ISOBMFF, whose
    // samples are already AVCC. Set from the index in _adoptIndex.
    this._annexBSamples = false;
    // True once the VideoDecoder has reported an unrecoverable error (see
    // _decoderFailed) or the source's bytes can no longer be read (see
    // _sourceReadFailed); cleared by load()/_teardown().
    this.failed = false;
    this._timescale = 1;

    // Upright display geometry, taken from the container index: the track's
    // rotation metadata (0/90/180/270) and the dimensions consumers should
    // letterbox and annotate against (coded axes swapped when rotation is
    // 90/270).
    this.rotation = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;

    // Decode-order sample table, aliased from the index (the decode driver
    // reads these on every tick).
    this._samples = null;
    this._keyframeDecodeIndices = null;
    this._displayToDecode = null;
    this._microsToDisplay = null;

    // Frame-level windowed cache. Single-keyframe ("one GOP") clips are common,
    // so we never hold a whole GOP — only a sliding window of decoded frames
    // around the playhead. Decoding streams forward from a keyframe and only
    // restarts (reset + reconfigure + decode forward) on a backward seek.
    this._cache = new Map();          // displayIndex -> ImageBitmap
    // Frames the decoder has emitted whose ImageBitmap is still being made
    // (createImageBitmap is async). They are on their way into the cache, so the
    // driver must not read their absence from _cache as "never decoded" and go
    // decode them all over again.
    this._pending = new Set();        // displayIndex
    // What the host would LIKE to hold: frames behind the playhead (a backward
    // scrub is then free) and ahead of it (playback doesn't stall on the
    // decoder). These are wishes, not the budget — _sizeWindows() cuts them to
    // what the clip's resolution can afford once the index says how big a frame
    // is. windowAhead: 0 means "no read-ahead at all", and stays 0.
    this._wantedWindowBack = Math.max(0, options.windowBack ?? 18);
    this._wantedWindowAhead = Math.max(0, options.windowAhead ?? 56);   // ≈2 s
    // A decoded frame's memory is width x height x 4, so a frame-counted cache
    // costs whatever the clip decides: 82 frames of 360p is 75 MB and 82 frames
    // of 1080p is 680 MB. On a phone the second one exhausts the surface pool
    // the decoder draws from and WebKit kills the decode session mid-playback
    // ("Decoder failure"), which is why the cache is sized in BYTES and the
    // window in frames falls out of it. The default is deliberately well under
    // iOS Safari's few-hundred-MB ceiling for image memory, which the
    // presentation canvas and the decoder's own frame pool also draw against.
    this._cacheBytes = Math.max(8 << 20, options.cacheBytes ?? (96 << 20));
    this._imageSmoothingEnabled = options.imageSmoothingEnabled ?? true;
    // Filled in by _sizeWindows() from _cacheBytes and the clip's frame size.
    this._windowBack = this._wantedWindowBack;
    this._windowAhead = this._wantedWindowAhead;
    this._windowSlack = WINDOW_SLACK;
    this._cacheBudget = this._windowBack + 1 + this._windowAhead + WINDOW_SLACK;
    // Cached bitmaps are for display only (frame-index accuracy is independent
    // of their resolution), so cap their long side: a 4K frame is 33 MB and the
    // whole byte budget would buy three of them. The canvas pane is never bigger
    // than the screen, so this is invisible. 1080p and smaller keep full
    // resolution (no downscale).
    this._displayCapPixels = 1920;
    this._runKeyframe = -1;           // decode index the current decode run began at
    this._fedThrough = -1;            // highest decode index fed to the decoder
    this._drained = false;            // flushed: the decoder now demands a key frame
    this._target = 0;                 // display frame the driver is steering toward
    this._driving = false;            // a _drive() loop is active
    this._restartTarget = -1;         // circuit-breaker: target of the last restart
    this._restartCount = 0;           // consecutive restarts for that same target
    this._stalledFrame = -1;          // a frame the circuit-breaker gave up on
    this._sourceReadFailures = 0;     // consecutive failed encoded-byte reads
    this._byteBuffer = null;          // read-ahead buffer of encoded bytes
    this._byteBufferStart = 0;        // its file offset
    // The block before _byteBuffer, kept while playback flows forward across
    // blocks: a decode run restarts from its GOP's keyframe when the target
    // crosses into a new GOP, and that keyframe can sit at the end of the block
    // just left behind. Dropped on a seek (any read that is not a continuation).
    this._previousByteBuffer = null;
    this._previousByteBufferStart = 0;
    this._prefetches = [];            // blocks in flight ahead of _byteBuffer,
                                      // oldest first: { start, end, done, promise }
    // How many blocks to keep banked ahead while playing. One is enough
    // whenever each block arrives before the current one runs out; it becomes
    // two the first time a boundary actually blocks (the prefetch was still in
    // flight when the driver needed it) — evidence of jitter one block of cover
    // cannot absorb, so the extra 4 MB is spent only on links that showed the
    // need.
    this._prefetchDepth = 1;
    // A background read of the loop origin's bytes, armed as a wrap approaches
    // and adopted by _ensureBytes at the wrap: { start, end, originFrame, done,
    // bytes, promise }. See _prefetchLoopOrigin.
    this._loopOriginPrefetch = null;
    // True until the first urgent read after the playhead was MOVED (a seek, a
    // loop wrap, load) rather than advanced by the clock; see _drive and update.
    this._landing = true;
    this._playheadAfterTick = -1;     // where update() last left the playhead
    this._frameAfterTick = -1;        // and which frame that was
    this._playheadMovedAt = 0;        // tick timestamp of the last move of it

    this._shownFrame = -1;
    this._lastBitmap = null;
    this._lastNow = 0;

    // Set while the playhead sits on the last indexed frame of an index that is
    // still growing. Playback is not over and not paused — it is waiting.
    this._waitingForIndex = false;
    // Rebuffering state (see the DEFAULT_REBUFFER_SECONDS block and update).
    this._rebufferSeconds = Math.max(0, options.rebufferSeconds ?? DEFAULT_REBUFFER_SECONDS);
    this._rebuffering = false;          // clock held, waiting for the buffer to refill
    this._droppingFrames = false;       // decode can't keep up: run the clock, drop frames
    this._decodeStallStreak = 0;        // consecutive decode-bound stalls, un-recovered
    this._lastDecodeShortfall = 0;      // performance.now() decode was last behind (recovery)
    // Listeners on the index, kept so _teardown can drop them: an index outlives
    // the engine that adopted it (createBestEngine may hand the same one to a
    // second engine after a WebCodecs load fails).
    this._indexListeners = null;
  }

  get paused() { return !this.playing; }
  get playbackRate() { return this._playbackRate; }
  set playbackRate(rate) { this._playbackRate = rate; }
  // The DOM node this engine presents into (for hosts that show/hide it or
  // position other elements relative to it).
  get displayElement() { return this.canvas; }
  // What this engine got, for dev labels and host-side diagnostics.
  get tier() { return 'webcodecs'; }
  // The clip's codec string as the container declares it (e.g.
  // 'hvc1.2.4.L123.b0'), for hosts that want to predict format trouble —
  // say, flagging 10-bit profiles for server-side conversion. Null until
  // load() has adopted an index.
  get codecString() { return this._decoderConfig ? this._decoderConfig.codec : null; }
  // The engine decodes each frame itself, so its frame indices are exact by
  // construction — there is no browser presentation to be uncertain about. True
  // in all three index states below: a growing index has fewer frames than the
  // clip, not less exact ones.
  get frameIndexIsExact() { return true; }

  // 'complete'  every frame in the clip is indexed (the ordinary case)
  // 'growing'   the index is still being built and numFrames is still rising;
  //             the frames it names are final, and there will be more of them
  // 'truncated' the index pass stopped early. What is here is final and correct;
  //             the rest of the clip is not coming.
  get frameIndexState() {
    return this._index ? this._index.completionState : 'growing';
  }
  // True while playback is pinned at the last indexed frame waiting for the
  // index to catch up — a stall on the indexer, not on the decoder.
  get waitingForIndex() { return this._waitingForIndex; }

  // True while playing but holding the clock on the last frame, waiting for the
  // decoder to catch up — the cue for a buffering spinner. Distinct from
  // `paused` (the host stopped playback) and `waitingForIndex` (pinned on the
  // last indexed frame while the index grows): here `playing` stays true, the
  // last frame stays on screen, and playback resumes on its own once
  // rebufferSeconds of frames ahead are decoded. Never true when the drop-frames
  // fallback has taken over (a decoder that can't keep up plays on, dropping
  // frames, rather than holding).
  get rebuffering() { return this._rebuffering; }

  // The clip's total length in seconds as the CONTAINER DECLARES IT, where it
  // declares one (Matroska's Info/Duration), and 0 where it does not. This is
  // what a host sizes a scrubber against while `frameIndexState` is 'growing',
  // so the track spans the whole clip instead of stretching under the cursor as
  // `duration` — the length actually indexed so far — rises to meet it.
  //
  // It is a claim, not a measurement, so it never names a frame: only the
  // scanned table does that. Fixed from the index's first publish, so it does
  // not wander mid-clip.
  get expectedDuration() { return this._index ? this._index.expectedDuration : 0; }

  frameAtTime(t) { return this._index ? this._index.frameAtTime(t) : 0; }

  get currentFrame() { return this._inVoid ? -1 : this.frameAtTime(this.playhead); }

  // The frame actually painted onto the canvas right now, as opposed to
  // `currentFrame` (the playhead's target, which lands the instant a host
  // seeks — before that frame is necessarily decoded). A host that needs to
  // know whether the pixels on screen have caught up to a seek should compare
  // against this, not `currentFrame`.
  get presentedFrame() { return this._shownFrame; }

  // Continuous playhead in frame units (frame index + fraction through that
  // frame's display interval) — what a host should drive any frame-indexed
  // display it renders in sync with the video (interpolated overlays etc.)
  // from, in place of the drift-prone `currentTime * frameRate`.
  get currentFrameFloat() {
    if (this._inVoid) return -1;
    return this._index ? this._index.frameFloatAtTime(this.playhead) : 0;
  }

  get currentTime() { return this.playhead; }
  set currentTime(t) { this.playhead = Math.max(0, Math.min(this.duration, t)); }

  // The composition time of display frame 0 — where playback begins and where a
  // loop wraps back to. A leading empty edit puts this past zero: the void
  // before the media is a real part of the timeline (a host can still seek into
  // it), but it is not playable content, so playback neither starts in it nor
  // loops back through it. An ordinary clip's first frame sits at zero.
  get _firstPresentedTime() {
    return this._index && this.numFrames > 0 ? this._index.presentationTimes[0] : 0;
  }

  // The loop region: the span of frames looping playback repeats, in place of
  // the whole clip. `loopStartFrame` is the frame a wrap lands on and
  // `loopEndFrame` is the last frame played before wrapping (inclusive); null
  // means the clip's own first/last frame. Frames, not seconds, because a frame
  // index names exactly one frame and a timestamp does not — a host holding a
  // time converts with frameAtTime(t).
  //
  // These apply only while `loop` is true; with looping off they are inert and
  // playback runs to the end of the clip as usual. They do not bound seeking:
  // seekToFrame outside the region is honored, and playback carries on from
  // there (see the wrap rule in the clock below).
  get loopStartFrame() { return this._loopStartFrame; }
  set loopStartFrame(n) { this._loopStartFrame = n == null ? null : Math.max(0, n | 0); }
  get loopEndFrame() { return this._loopEndFrame; }
  set loopEndFrame(n) { this._loopEndFrame = n == null ? null : Math.max(0, n | 0); }

  // The composition time a wrap lands on: the loop region's first frame, else
  // display frame 0.
  get _loopOriginTime() {
    if (this._loopStartFrame != null && this._index && this.numFrames > 0) {
      return this._index.presentationTimes[Math.min(this._loopStartFrame, this.numFrames - 1)];
    }
    return this._firstPresentedTime;
  }

  // The composition time a wrap fires at: the moment the region's last frame
  // leaves the screen, which is the start of the frame after it. Falls back to
  // the clip's end, so a region ending on the last frame is just ordinary
  // looping.
  get _loopWrapTime() {
    if (this._loopEndFrame != null && this._index
        && this._loopEndFrame < this.numFrames - 1) {
      return this._index.presentationTimes[this._loopEndFrame + 1];
    }
    return this.duration;
  }

  // Wrap back to the loop origin, carrying the overshoot past `wrapAt` with it
  // so the wrap itself costs no time and playback stays smooth across it.
  _wrapToLoopOrigin(wrapAt) {
    const origin = this._loopOriginTime;
    this.playhead -= (wrapAt - origin);
    if (!(this.playhead >= origin && this.playhead < wrapAt)) this.playhead = origin;
  }

  // Playhead in the leading void ahead of the media — the empty edit's gap, where
  // there is no frame to show. Distinct from being on frame 0 (which sits exactly
  // at _firstPresentedTime) and from a target still decoding (a real frame whose
  // pixels have not arrived yet). Here currentFrame reports -1 and the canvas is
  // cleared to an empty, transparent image — nothing, the way QuickTime and a
  // <video> element render an empty edit.
  get _inVoid() { return this.playhead < this._firstPresentedTime; }

  // Land the playhead exactly on the start of display frame n. Because we own
  // frameAtTime there is no browser seek-rounding to dodge, so we use the
  // frame's start directly (no midpoint trick, unlike NativeVideoEngine):
  // frameAtTime(presentationTimes[n]) === n exactly.
  seekToFrame(n) {
    if (!this._index) return;
    n = Math.max(0, Math.min(this.numFrames - 1, n | 0));
    this.playhead = this._index.presentationTimes[n];
  }

  play() { if (this.ready && !this.playing) { this.playing = true; this._lastNow = 0; } }
  pause() { this.playing = false; }

  // Change the decoded-frame memory ceiling at runtime — the same quantity the
  // cacheBytes constructor option sets, clamped the same way. The frame window
  // is re-derived from the new budget and the clip's frame size (_sizeWindows),
  // the cache is trimmed to it at once so a decrease frees memory immediately,
  // and the driver is kicked so an increase starts filling the newly affordable
  // read-ahead without waiting for the next seek. A host can turn this down on a
  // low-memory warning and back up when it has room again.
  setCacheBytes(bytes) {
    this._cacheBytes = Math.max(8 << 20, Math.floor(bytes) || (8 << 20));
    // Before an index is adopted there is no frame size to size the window
    // against; _adoptIndex runs _sizeWindows once it has one, off this value.
    if (!this._index) return;
    this._sizeWindows();
    this._evict();
    if (!this.ready) return;
    // Growing the window can call for frames the driver already STREAMED PAST and
    // eviction has since dropped — a paused viewer who shrank the cache and then
    // widened it again. The forward drive won't reproduce them: it feeds by a
    // high-water mark (_fedThrough) and those frames sit behind it, so it judges
    // them already delivered and streams onward, leaving a hole the read-ahead
    // never heals. Only a run restart from the keyframe re-decodes them. So walk
    // the wanted forward window and invalidate the run if any frame in it is
    // neither resident nor still on its way AND the stream is already past it.
    // (Not "high-water mark past the whole goal": after a partial fill the mark
    // sits BETWEEN the surviving island and the new goal, and resuming from
    // there strands the evicted frames behind it — cache [0-3, 6-112].) Growing
    // mid-playback stays free: wanted frames are ahead of the mark, no restart.
    if (this._cache.size < this._cacheBudget) {
      const aheadFrame = Math.min(this.numFrames - 1, this._target + this._windowAhead);
      for (let frame = this._target; frame <= aheadFrame; frame++) {
        if (this._cache.has(frame) || this._pending.has(frame)) continue;
        if (this._displayToDecode[frame] <= this._fedThrough) {
          this._runKeyframe = -1;
          break;
        }
        // A missing frame the stream has NOT reached yet doesn't settle it:
        // with B-frame reordering a later display frame can still have an
        // earlier decode index, so keep scanning rather than stopping here.
      }
    }
    this._request(this._target);
  }

  // options.index: a ContainerIndex already built for this source (createBestEngine
  // builds one up front and hands the same one to whichever engine plays, so the
  // moov is never parsed twice). Omit it and the engine builds its own.
  async load(source, options = {}) {
    this._teardown();
    try {
      const index = options.index
        || await ContainerIndex.fromSource(source);
      if (!index.supportsWebCodecs) {
        // An Ogg index, or a Matroska one whose codec we could not configure:
        // exact timestamps, but nothing here to decode from. The clip is fine —
        // it belongs on NativeVideoEngine, which the same index makes frame-exact
        // anyway.
        throw new Error(`this ${index.containerFormat} container carries no `
          + 'sample table for WebCodecs to decode from');
      }
      this._adoptIndex(index);

      // A Motion JPEG clip has no VideoDecoder to ask — its frames are whole
      // still images and ImageFrameDecoder reaches the browser's JPEG decoder
      // instead — so the question to ask is whether THAT is available.
      if (isImageFrameCodec(this._decoderConfig.codec)) {
        if (!canDecodeImageFrames()) {
          throw new UnplayableClipError('this browser cannot decode image frames: '
            + this._decoderConfig.codec,
            { reason: 'codec-not-decodable', codec: this._decoderConfig.codec,
              codecRefusedBySupportCheck: true });
        }
      } else {
        const support = await VideoDecoder.isConfigSupported(this._decoderConfig);
        if (!support.supported) {
          // The decoder's own answer, asked before a byte is decoded: this is
          // POSITIVE evidence that the codec is the problem, as distinct from a
          // decode that failed for some other reason (damaged frame bytes, say).
          // createBestEngine leans on that distinction when the <video> element
          // then fails too — see describeExhaustedLadder.
          throw new UnplayableClipError(
            'codec not supported: ' + this._decoderConfig.codec,
            { reason: 'codec-not-decodable', codec: this._decoderConfig.codec,
              codecRefusedBySupportCheck: true });
        }
      }

      this._configureDecoder();
      this.playhead = this._firstPresentedTime;
      this._shownFrame = -1;
      // Decode and paint frame 0 before resolving (the loadeddata analogue).
      await this.ensureFrame(0);
      this.resizeCanvas();   // size the backing store to the pane before painting
      this._present(0);
      this.ready = true;
      this.dispatchEvent(new Event('loaded'));
    } catch (err) {
      console.error('VideoEngine.load failed:', err);
      this._showError(err && err.message ? err.message : String(err));
      throw err;
    }
  }

  _adoptIndex(index) {
    this._index = index;
    this._reader = index.reader;
    this._decoderConfig = index.decoderConfig;
    // See MINIMUM_REORDER_DEPTH. A codec with no readable declaration (VP8,
    // VP9, AV1, in-band parameter sets) keeps the minimum.
    const declaredReorderDepth = index.decoderConfig ? decoderConfigFrameReorderDepth(
      index.decoderConfig.codec, index.decoderConfig.description) : null;
    this._declaredReorderDepth = declaredReorderDepth ?? 0;
    this._reorderDepth = Math.max(MINIMUM_REORDER_DEPTH,
      this._declaredReorderDepth + DECODER_PIPELINE_SLACK);
    this._annexBSamples = !!index.samplesAreAnnexB;
    this._timescale = index.timescale;
    this.rotation = index.rotation;
    this.videoWidth = index.videoWidth;
    this.videoHeight = index.videoHeight;
    this._readIndexTables();
    this._sizeWindows();

    // An index that is still being built hands over more frames as it certifies
    // them. Re-read its tables each time rather than reach through the index on
    // the decode driver's hot path.
    if (this._indexListeners || index.completionState !== 'growing') return;
    const onExtended = () => this._indexExtended();
    const onSettled = () => {
      if (index.completionState !== 'truncated') {
        this.dispatchEvent(new Event('indexcomplete'));
        return;
      }
      this.dispatchEvent(new Event('indextruncated'));
      // Not `failed`: the frames this engine has are exact and it will go on
      // playing them. What ended is the clip's growth, and a host showing a
      // scrubber or a frame count needs to hear that in the channel it already
      // watches for trouble.
      const because = index.completionError && index.completionError.message;
      this.dispatchEvent(new CustomEvent('errormessage', {
        detail: {
          message: `Only the first ${this.numFrames} frames of this clip could be `
            + `indexed${because ? ` (${because})` : ''}. Those frames are exact; the `
            + 'rest of the clip is unavailable.',
          fatal: true,
          incomplete: true,
        },
      }));
    };
    this._indexListeners = { index, onExtended, onSettled };
    index.addEventListener('extended', onExtended);
    index.addEventListener('complete', onSettled);
    index.addEventListener('truncated', onSettled);
  }

  // Alias the index's tables. Safe to redo on a growing index precisely because
  // it grows by APPENDING: every entry already read keeps its meaning, so a
  // re-read can only ever add frames, never move one.
  _readIndexTables() {
    const index = this._index;
    this._samples = index.samples;
    this._keyframeDecodeIndices = index.keyframeDecodeIndices;
    this._displayToDecode = index.displayToDecode;
    this._microsToDisplay = index.microsToDisplay;
    this.numFrames = index.numFrames;
    this.duration = index.duration;
  }

  // The index certified more frames. Synchronous from end to end: the index
  // dispatches this from inside its own publish, so anything awaited here would
  // let the host observe a half-grown table.
  _indexExtended() {
    this._readIndexTables();
    // A frame the driver gave up on may simply not have been indexed yet — the
    // decode run ran off the end of a sample table that was still short. Those
    // verdicts are stale now, so clear them rather than leave a frame
    // permanently undecodable for the rest of the session.
    this._stalledFrame = -1;
    this._restartTarget = -1;
    this._restartCount = 0;
    this._drained = false;
    if (this._waitingForIndex) {
      this._waitingForIndex = false;
      this._lastNow = 0;   // do not charge the wait to the playhead
    }
    if (this.ready) this._request(this.frameAtTime(this.playhead));
    this.dispatchEvent(new Event('indexextended'));
  }

  // The size a cached bitmap of this clip's frames comes out at, after the
  // display cap. _absorb downscales to exactly this, so the byte budget below
  // and the memory actually held are the same arithmetic.
  _cachedBitmapSize(width, height) {
    const scale = Math.min(1, this._displayCapPixels / Math.max(width, height));
    return [Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale))];
  }

  // Turn the byte budget into a frame window, now that the index has said how
  // big a frame is. The clip's resolution — not the host — decides how many
  // frames fit: at 96 MB that is ~330 frames of 360p but only ~11 of 1080p.
  _sizeWindows() {
    const [width, height] = this._cachedBitmapSize(this.videoWidth, this.videoHeight);
    const bytesPerFrame = Math.max(1, width * height * 4);
    const affordable = Math.max(MINIMUM_WINDOW_FRAMES,
      Math.floor(this._cacheBytes / bytesPerFrame));

    // Frames resident at once: the ones behind, the centre frame, the ones
    // ahead, and the slack _insideWindow admits past the far edge.
    let back = this._wantedWindowBack;
    let ahead = this._wantedWindowAhead;
    let slack = WINDOW_SLACK;

    if (back + 1 + ahead + slack > affordable) {
      // Everything except the centre frame is negotiable. Read-ahead is bought
      // first — without it playback stalls on the decoder every frame, whereas a
      // short history only costs a re-decode on a backward scrub — and this only
      // ever shrinks the window, so a host that asked for no read-ahead (or a
      // narrow one) keeps what it asked for.
      const spendable = Math.max(0, affordable - 1);
      slack = Math.min(slack, Math.floor(spendable / 3));
      const forWindow = spendable - slack;
      back = Math.min(back, Math.floor(forWindow / 4));
      ahead = Math.min(ahead, forWindow - back);
    }
    this._windowBack = back;
    this._windowAhead = ahead;
    this._windowSlack = slack;
    // Must cover the window on both sides, or the eviction pass would throw away
    // frames the read-ahead just paid to decode.
    this._cacheBudget = back + 1 + ahead + slack;
  }

  // ---- decode (streaming, frame-windowed) ---------------------------------
  // Both decoders are driven identically from here on: same constructor, same
  // configure/decode/flush/reset/close, same decodeQueueSize and output
  // callback. Which frames to decode, and when, is the same problem whether a
  // frame arrives from a VideoDecoder or from the browser's JPEG decoder.
  _configureDecoder() {
    const Decoder = isImageFrameCodec(this._decoderConfig.codec)
      ? ImageFrameDecoder : VideoDecoder;
    this._videoDecoder = new Decoder({
      output: (frame) => this._absorb(frame),
      error: (e) => this._decoderFailed(e),
    });
    this._videoDecoder.configure(this._decoderConfig);
    this._runKeyframe = -1;
    this._fedThrough = -1;
  }

  // The VideoDecoder error callback fires only for unrecoverable failures (the
  // decoder is closed once it does). The treacherous case is a browser whose
  // isConfigSupported() said yes and whose decoder survived frame 0 but dies
  // once sustained decoding starts — seen on WebKit with 10-bit HEVC — which
  // is AFTER load() resolved, so createBestEngine's load-time fallback cannot
  // catch it. Mark the engine failed so waiters (ensureFrame) fail fast
  // instead of timing out, and tell the host it is fatal: a host holding a
  // <video> element should rebuild with prefer: 'native', which typically
  // plays the same clip fine.
  _decoderFailed(e) {
    console.error('VideoDecoder error:', e);
    this.failed = true;
    const detail = {
      message: e && e.message ? e.message : String(e),
      fatal: true,
      errorName: (e && e.name) || null,
      codec: this._decoderConfig ? this._decoderConfig.codec : null,
      frame: this.currentFrame,
    };
    this.dispatchEvent(new CustomEvent('errormessage', { detail }));
  }

  // Largest keyframe decode index <= decodeIndex (binary search).
  _keyframeForDecode(decodeIndex) {
    const arr = this._keyframeDecodeIndices;
    let lo = 0, hi = arr.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= decodeIndex) { ans = arr[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // The frames worth keeping sit around the playhead AND around whatever frame
  // the decode driver is currently steering toward. Those are usually the same
  // number: a seek moves the playhead and the target together, and playback
  // walks both forward. They come apart when a host asks for a frame WITHOUT
  // moving the playhead — ensureFrame(n) on its own, which is how a thumbnail or
  // an annotation tool grabs a frame's pixels.
  //
  // Windowing on the playhead alone made that case impossible: the driver dutifully
  // decoded toward the target, and every frame it produced arrived here, landed
  // outside the playhead's window, and was dropped on the floor. ensureFrame then
  // waited for a frame that was being decoded and discarded over and over, until
  // it timed out. The bug needed a clip longer than the window (~64 frames) to show
  // itself at all, so short test clips sailed straight past it.
  _windowCenters() {
    const current = this.currentFrame;
    return (this._target === current) ? [current] : [current, this._target];
  }

  // Display index of the keyframe that begins displayIndex's GOP: the frame a
  // backward step can retreat to without crossing into the previous GOP, and so
  // without forcing a re-decode. The keyframe is known in DECODE order
  // (_keyframeForDecode); its display index is recovered through the same
  // timestamp→display map the decoder output uses (microsToDisplay is keyed by
  // round(cts * 1e6 / timescale), matching the chunk timestamps we feed).
  _keyframeDisplayFor(displayIndex) {
    const decodeIndex = this._displayToDecode[displayIndex];
    if (decodeIndex === undefined) return displayIndex;
    const keyframeSample = this._samples[this._keyframeForDecode(decodeIndex)];
    const keyframeDisplay = this._microsToDisplay.get(
      Math.round(keyframeSample.cts * 1e6 / this._timescale));
    return keyframeDisplay === undefined ? displayIndex : keyframeDisplay;
  }

  // The frame ranges worth keeping, around each window centre: from that frame's
  // GOP keyframe — or _windowBack, whichever reaches further back — forward
  // through the read-ahead window. The keyframe back-edge is what makes short
  // backward steps after a seek free: the run from the keyframe to the target is
  // decoded on the way to the target anyway, so holding it costs no extra decode
  // (the byte budget still caps how much survives — see _evict). Everything
  // outside every range is stale: a previous seek's island, or history before
  // the current GOP that a backward scrub would re-decode from an earlier
  // keyframe regardless.
  _keepRanges() {
    const ranges = this._windowCenters().map((center) => {
      const back = Math.min(center - this._windowBack,
        this._keyframeDisplayFor(Math.max(0, center)));
      return [back, center + this._windowAhead + this._windowSlack];
    });
    // When looping, keep the WHOLE loop region resident if it fits the budget:
    // the playhead replays every frame in it on the next wrap, so dropping the
    // part beyond the read-ahead window's forward edge — for a single-GOP clip,
    // most of the clip — only forces a re-decode from the keyframe every loop.
    // This is a superset of the normal window, so it never keeps FEWER frames;
    // gated on fitting the budget, so it never lifts the memory ceiling (the
    // budget pass in _evict still enforces it if a seek out of the region pushes
    // the resident set over). When the region does not fit, this adds nothing and
    // the ordinary window plus the budget pass govern, as before.
    if (this.loop && this.numFrames > 0) {
      const loopStart = this._loopStartFrame != null
        ? Math.min(this._loopStartFrame, this.numFrames - 1) : 0;
      const loopEnd = this._loopEndFrame != null
        ? Math.min(this._loopEndFrame, this.numFrames - 1) : this.numFrames - 1;
      if (loopEnd >= loopStart && (loopEnd - loopStart + 1) <= this._cacheBudget) {
        ranges.push([loopStart, loopEnd]);
      }
    }
    return ranges;
  }

  _insideKeepWindow(displayIndex, ranges = this._keepRanges()) {
    return ranges.some(([lo, hi]) => displayIndex >= lo && displayIndex <= hi);
  }

  // A decoded frame arrived. Cache it (as an ImageBitmap, freeing the decoder's
  // bounded frame pool) if it falls inside a window we care about; otherwise drop.
  _absorb(frame) {
    const displayIndex = this._microsToDisplay.get(frame.timestamp);
    if (displayIndex === undefined
        || !this._insideKeepWindow(displayIndex)
        || this._cache.has(displayIndex)) {
      frame.close();
      return;
    }
    const cacheRef = this._cache;   // detect a teardown/reload mid-conversion
    // Downscale oversized frames (e.g. 4K) when caching — display only. Same
    // arithmetic _sizeWindows() budgeted against, so what lands in the cache is
    // the size it was told to expect.
    let options;
    const [width, height] =
      this._cachedBitmapSize(frame.displayWidth, frame.displayHeight);
    if (width !== frame.displayWidth || height !== frame.displayHeight) {
      options = { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' };
    }
    this._pending.add(displayIndex);
    createImageBitmap(frame, options).then((bitmap) => {
      frame.close();
      this._pending.delete(displayIndex);
      if (cacheRef !== this._cache || cacheRef.has(displayIndex)) { bitmap.close(); return; }
      cacheRef.set(displayIndex, bitmap);
      this._evict();
    }).catch(() => {
      this._pending.delete(displayIndex);
      try { frame.close(); } catch (e) { /* already closed */ }
    });
  }

  _evict() {
    // First shed anything outside the keep window, whatever the budget says. A
    // seek that leaves the cache under budget still drops the pre-seek island
    // (and any history before the current GOP) this way, so the resident frames
    // are the ones around where playback actually is now. Without this pass,
    // budget-only eviction left a disconnected island sitting in the cache until
    // enough new frames were decoded to breach the budget — which on a paused
    // seek often never happened, so stale frames lingered indefinitely.
    const keep = this._keepRanges();
    for (const key of [...this._cache.keys()]) {
      if (this._insideKeepWindow(key, keep)) continue;
      // Never close the frame currently on screen. _lastBitmap aliases this same
      // ImageBitmap, and _syncCanvasSize repaints it on the next canvas resize —
      // closing it here leaves that repaint drawing a detached bitmap, which
      // throws. A loop wrap (or any seek that lands the playhead far from where
      // the picture still shows the previous frame) is exactly when the on-screen
      // frame falls outside the keep window, so guard it until a new frame
      // replaces it. It becomes evictable again the moment _shownFrame moves on.
      if (key === this._shownFrame) continue;
      const bitmap = this._cache.get(key);
      if (bitmap) bitmap.close();
      this._cache.delete(key);
    }

    if (this._cache.size <= this._cacheBudget) return;
    // Forward-biased: drop frames BEHIND the playhead first (forward playback
    // won't revisit them), farthest-behind first; only then frames far AHEAD.
    // This protects the read-ahead window we just paid to decode — a symmetric
    // distance metric would instead evict the about-to-be-shown read-ahead.
    //
    // Ranked against the nearest window centre, for the same reason _absorb is:
    // when a host has asked for a frame away from the playhead, that frame and
    // its neighbours are the ones being decoded right now, and evicting them by
    // distance-from-playhead would throw out the very thing we are waiting for.
    const centers = this._windowCenters();
    const distance = (k, center) =>
      (k < center) ? 2e6 + (center - k) : (k - center);
    const rank = (k) => Math.min(...centers.map((center) => distance(k, center)));
    const keys = [...this._cache.keys()].sort((a, b) => rank(b) - rank(a));
    while (this._cache.size > this._cacheBudget) {
      const key = keys.shift();
      if (key === undefined) break;
      if (key === this._shownFrame) continue;   // pinned: see the keep-pass note
      const bitmap = this._cache.get(key);
      if (bitmap) bitmap.close();
      this._cache.delete(key);
    }
  }

  _bitmapFor(frameIndex) { return this._cache.get(frameIndex); }

  // Steer decoding toward display frame N: kick the driver loop, which streams
  // samples forward from the right keyframe and fills the cache window.
  _request(frameIndex) {
    if (frameIndex === this._stalledFrame) return;   // known-undecodable; don't spin
    // A failed engine has nothing to decode with, or nothing to read from, and
    // update() calls here every tick: starting the driver again would only fail
    // again, once per frame, for as long as the page stays open.
    if (this.failed) return;
    this._target = frameIndex;
    // Prune to the window centred on the new target now, not only when the next
    // frame is absorbed: a seek onto already-cached frames (or one whose decode
    // has not produced anything yet) would otherwise leave the previous
    // location's frames resident until some later absorb happened to run _evict.
    this._evict();
    if (!this._driving) { this._driving = true; this._drive(); }
  }

  async _drive() {
    try {
      while (this._videoDecoder) {
        const target = this._target;
        const targetDecode = this._displayToDecode[target];
        const keyframe = this._keyframeForDecode(targetDecode);
        // Read-ahead goal in decode-index terms: enough to also produce the
        // frames ahead of the target (so playback doesn't stall every frame).
        // A decoder releases a frame only once the samples that may reorder
        // ahead of it have gone in, so the read-ahead frames come OUT only if
        // the stream's declared reorder depth is fed past them. Without that, a
        // stream declaring a deep reorder (15 for a level 5.1 screen recording)
        // whose read-ahead the byte budget cut to a few frames never has a frame
        // out before it is due, and plays in the drop-frames fallback throughout.
        const aheadFrame = Math.min(this.numFrames - 1, target + this._windowAhead);
        const lastSample = this._samples.length - 1;
        const decodeGoal = Math.min(lastSample,
          Math.max(targetDecode, this._displayToDecode[aheadFrame])
          + (this._windowAhead > 0 ? this._declaredReorderDepth : 0));
        // Decoded, or decoded and still becoming an ImageBitmap. Either way it is
        // coming, and re-decoding it would be wasted work.
        const haveTarget = this._cache.has(target) || this._pending.has(target);

        // The frame the circuit-breaker was counting restarts against has
        // surfaced, so those restarts SUCCEEDED: clear the breaker. Its job is to
        // give up on a frame that restarts over and over WITHOUT ever appearing
        // (a corrupt sample, an impossible target) — not on one that needs a
        // legitimate restart each time it comes around. A looped clip does
        // exactly that: every wrap, the frame cold at the loop origin (for a clip
        // larger than the cache) or the tail past the read-ahead window (for one
        // that fits) needs one restart from the keyframe. Without this reset those
        // successful restarts accumulate ACROSS loops — the counter only cleared
        // when the target changed — until the breaker passed its limit and
        // wrongly stranded a perfectly decodable frame (see the restart branch).
        if (haveTarget && target === this._restartTarget) {
          this._restartTarget = -1;
          this._restartCount = 0;
        }

        // Hard restart when the target lives in a different GOP than the current
        // run. Backward seeks within the same GOP are handled below.
        if (this._runKeyframe !== keyframe) this._restartRun(keyframe);

        // Need more frames decoded? Feed the next sample (in decode order).
        //
        // Past the read-ahead goal, keep feeding while the target itself has not
        // surfaced. A decoder holds a frame back until enough LATER samples have
        // arrived to settle the display order (B-frames), so more samples -- not
        // a flush -- are what shake it loose. Flushing here instead would empty
        // the decoder and leave it demanding a key frame, which the next delta
        // sample is not: it throws, and the driver dies with the picture frozen
        // on whatever frame was last painted. That was survivable only while the
        // read-ahead was so deep the target always surfaced before we reached
        // the goal; it is the ordinary case once the byte budget cuts the window
        // on a big clip.
        //
        // Bounded by _reorderDepth: a decoder holds only a few frames back, so
        // once we are well past the target with nothing to show for it, the frame
        // is not in the pipeline at all -- it came out earlier and was evicted
        // (a backward seek), and feeding forward would read to the end of the
        // clip to find something that is behind us.
        const stillComing = !haveTarget
          && this._fedThrough < lastSample
          && this._fedThrough < targetDecode + this._reorderDepth;
        if (this._fedThrough < decodeGoal || stillComing) {
          // A drained decoder accepts nothing but a key frame, and the next
          // sample in decode order is a delta. Begin the run again.
          if (this._drained) { this._restartRun(keyframe); continue; }
          // Keep few chunks in flight so few decoded frames (which may be 4K)
          // coexist before we downscale + cache them.
          if (this._videoDecoder.decodeQueueSize > 4) { await this._sleep(0); continue; }
          const k = this._fedThrough + 1;
          const s = this._samples[k];
          // While the viewer is waiting to LAND on a frame -- the first frame of
          // the clip, a paused seek or step, the first read after a seek during
          // playback -- every byte fetched beyond the ones that frame depends on
          // is a byte the viewer waits on for nothing, so read only as far as
          // the target's own sample. On a slow link this is the difference
          // between waiting for one keyframe and waiting for a fixed 4 MB block.
          //
          // But during continuous playback an uncached target means something
          // else: the decoder has fallen behind the wall clock. A small read
          // there is one round trip per quarter megabyte, and the clock runs on
          // through every one of them, so playback never climbs back out. Read
          // full blocks instead, and land only once per move of the playhead.
          const landing = !this.playing || this._shownFrame < 0 || this._landing;
          const urgent = landing && !this._cache.has(target);
          if (urgent && this.playing) this._landing = false;
          await this._ensureBytes(s.offset, s.size,
            urgent ? this._bytesThrough(k, targetDecode) : 0);
          if (!this._videoDecoder || this._fedThrough !== k - 1) continue;  // restarted mid-read
          // AVI stores H.264 as Annex B, but the decoder is configured in AVCC
          // mode (a description is present), so convert this frame's start-code
          // NAL units to length-prefixed form first. ISOBMFF samples are already
          // AVCC and pass through untouched.
          const sampleBytes = this._annexBSamples
            ? convertAnnexBToAvcc(this._sliceSample(k)) : this._sliceSample(k);
          this._videoDecoder.decode(new EncodedVideoChunk({
            type: s.isSync ? 'key' : 'delta',
            timestamp: Math.round(s.cts * 1e6 / this._timescale),
            duration: Math.round(s.duration * 1e6 / this._timescale),
            data: sampleBytes,
          }));
          this._fedThrough = k;
          continue;
        }

        if (!haveTarget && this._target === target) {
          // The clip has no sample left to feed and the target still has not come
          // out: it is held in the pipeline with nothing later to release it. Only
          // here is a flush the right instrument -- it drains what is held. The run
          // is over afterwards (the decoder now wants a key frame), so forget it:
          // anything further restarts from a keyframe.
          if (this._fedThrough >= lastSample && !this._drained) {
            await this._videoDecoder.flush();
            this._drained = true;
            if (this._target !== target) continue;     // playhead moved; re-evaluate
            if (this._cache.has(target) || this._pending.has(target)) continue;
          }
          // The target was decoded earlier and evicted (a backward seek beyond
          // the window), so decode it again from its keyframe. Guard against an
          // impossible target so a bad frame can't spin the loop forever.
          if (this._restartTarget === target && ++this._restartCount > 2) {
            console.warn(`VideoEngine: cannot decode frame ${target}; holding`);
            this._stalledFrame = target;
            this._driving = false;
            return;
          }
          if (this._restartTarget !== target) { this._restartTarget = target; this._restartCount = 0; }
          this._restartRun(keyframe);
          continue;
        }

        // Target is shown and read-ahead is satisfied: idle until next request.
        if (this._target === target) { this._driving = false; return; }
      }
    } catch (err) {
      if (err instanceof SourceReadError) { this._sourceReadFailed(err.cause); return; }
      console.error('decode driver:', err);
    }
    this._driving = false;
  }

  // The decode driver could not read the clip's encoded bytes. For a URL, wait
  // and try again (see SOURCE_READ_RETRY_MILLISECONDS), keeping _driving set
  // through the wait so update() does not start another pass straight into the
  // same failure. Otherwise, or once the retries run out, the source is gone:
  // mark the engine failed, which stops the driver for good and makes waiters
  // (ensureFrame) fail fast, and tell the host. The event is fatal like a dead
  // decoder's, but carries sourceUnavailable so a host can tell them apart —
  // rebuilding on the native tier cures a decoder that died, but not a file that
  // is no longer there; that wants the person to open it again.
  _sourceReadFailed(cause) {
    const attempt = this._sourceReadFailures++;
    const fromUrl = this._reader instanceof UrlRangeReader;
    if (fromUrl && attempt < SOURCE_READ_RETRY_MILLISECONDS.length) {
      const delay = SOURCE_READ_RETRY_MILLISECONDS[attempt];
      console.warn(`VideoEngine: reading the clip failed (${cause}); retrying in ${delay} ms`);
      const decoder = this._videoDecoder;
      setTimeout(() => {
        // Torn down or reloaded during the wait: that session's driver is gone.
        if (this._videoDecoder !== decoder || !decoder || this.failed) return;
        this._drive();
      }, delay);
      return;
    }
    console.error('VideoEngine: the clip\'s source can no longer be read:', cause);
    this._driving = false;
    this.failed = true;
    const message = fromUrl
      ? 'This video\'s URL stopped answering requests for its data, so it cannot '
        + 'be played any further.'
      : 'This video\'s file can no longer be read. It was probably moved, renamed, '
        + 'or deleted after it was opened; open it again to keep playing.';
    this.dispatchEvent(new CustomEvent('errormessage', { detail: {
      message,
      fatal: true,
      sourceUnavailable: true,
      errorName: (cause && cause.name) || null,
      sourceErrorMessage: (cause && cause.message) || String(cause),
      frame: this.currentFrame,
    } }));
  }

  _restartRun(keyframe) {
    this._videoDecoder.reset();
    this._videoDecoder.configure(this._decoderConfig);
    this._runKeyframe = keyframe;
    this._fedThrough = keyframe - 1;
    this._drained = false;
  }

  // Encoded bytes from sample `from` through sample `through`, inclusive — what
  // it costs to decode `through`, given a decode run that starts at `from`.
  // Samples are contiguous in decode order, so this is just the span between
  // them; it is what the urgent read below asks for.
  _bytesThrough(from, through) {
    const first = this._samples[from];
    const last = this._samples[Math.max(from, through)];
    return (last.offset + last.size) - first.offset;
  }

  // Ensure the encoded bytes for [offset, offset+size) are in the read-ahead
  // buffer, fetching a larger block (covering many subsequent samples) on a miss.
  //
  // `wanted` is how far ahead this particular read is worth taking: pass 0 (the
  // default) for background read-ahead, which takes a big block because the
  // viewer is not waiting on it and one fat request beats twenty thin ones; pass
  // a byte count while a frame is outstanding, and the block shrinks to just the
  // samples that frame depends on. A fixed block here used to make the first
  // frame of a clip wait on 4 MB when a single keyframe would have done.
  //
  // It is still a floor-and-ceiling, not an exact read: never less than this
  // sample (or the slice below would run off the end of the buffer), never more
  // than MAX_BLOCK, and never so small that a GOP costs one request per frame.
  //
  // During playback the block AFTER the current one is fetched in the background
  // (_prefetchNextBlock), so the driver crosses a block boundary by adopting
  // bytes already in hand instead of stopping to wait for them: a blocking
  // refill here is a round trip plus the transfer with nothing decoding, and
  // the few frames of decoded read-ahead a 1080p clip can afford under
  // cacheBytes cover about 0.2 s of it.
  async _ensureBytes(offset, size, wanted = 0) {
    if (this._bufferHolding(offset, size)) {
      this._prefetchNextBlock();
      return;
    }
    // Somebody is waiting on this one. Say so, so that an index pass still
    // streaming the rest of the container out of the same source stands aside
    // rather than racing us for the pipe (see read-priority-gate).
    beginPriorityRead();
    try {
      // Adopt prefetched blocks, oldest first, while the bytes begin in the
      // current buffer or in the block under adoption. Usually one adoption; a
      // sample straddling into the block after takes two, and the stitch in
      // _bytesAt covers each crossed boundary.
      while (!this._bufferHolding(offset, size)) {
        const next = this._prefetches[0];
        const beginsInCurrent = this._byteBuffer && offset >= this._byteBufferStart
          && offset < this._byteBufferStart + this._byteBuffer.length;
        if (!next || offset >= next.end + 1
            || (offset < next.start && !beginsInCurrent)) break;
        // Having to wait here is the evidence _prefetchDepth asks for: one
        // block of cover was not enough for this link. But only a boundary
        // crossed out of a FULL block says that -- the prefetch then had a
        // whole block's consumption time as head start. Running out of a
        // partial buffer (the landing read, moments after play begins) says
        // nothing about the link.
        if (!next.done && this._byteBuffer
            && this._byteBuffer.length >= MAX_BLOCK) {
          this._prefetchDepth = 2;
        }
        const bytes = await next.promise;
        // Nothing else drops queued prefetches but this method and a reset, so
        // a different head here means the engine was reset under the wait.
        if (this._prefetches[0] !== next) return;
        this._prefetches.shift();
        if (!bytes) break;   // the prefetch failed; read directly below
        // A continuation: keep the block being left behind (see the field).
        this._previousByteBuffer = this._byteBuffer;
        this._previousByteBufferStart = this._byteBufferStart;
        this._byteBuffer = bytes;
        this._byteBufferStart = next.start;
      }
      // A wrap's read from the loop origin: adopt the background prefetch that
      // warmed it (see _prefetchLoopOrigin) instead of blocking on a fresh read.
      if (!this._bufferHolding(offset, size) && this._loopOriginPrefetch
          && offset >= this._loopOriginPrefetch.start
          && offset + size <= this._loopOriginPrefetch.end + 1) {
        const origin = this._loopOriginPrefetch;
        const bytes = origin.done ? origin.bytes : await origin.promise;
        if (this._loopOriginPrefetch === origin) {   // not reset under the await
          this._loopOriginPrefetch = null;
          if (bytes) {
            this._previousByteBuffer = null;
            this._byteBuffer = bytes;
            this._byteBufferStart = origin.start;
          }
        }
      }
      if (!this._bufferHolding(offset, size)) {
        // Anything still queued is for somewhere the playhead no longer is.
        this._prefetches = [];
        const block = wanted > 0
          ? Math.min(MAX_BLOCK, Math.max(size, Math.min(wanted, MAX_BLOCK), MIN_BLOCK))
          : MAX_BLOCK;
        const end = Math.min(this._reader.size, offset + block) - 1;
        let bytes;
        try {
          bytes = new Uint8Array(await this._reader.read(offset, end));
        } catch (err) {
          throw new SourceReadError(err);
        }
        this._sourceReadFailures = 0;
        this._previousByteBuffer = null;
        this._byteBuffer = bytes;
        this._byteBufferStart = offset;
      }
    } finally {
      endPriorityRead();
    }
    this._prefetchNextBlock();
  }

  // Keep the queue of blocks ahead of the current buffer topped up, to `depth`
  // blocks. While playing that is _prefetchDepth; while paused it is nothing at
  // all, because a viewer stepping or dragging the scrubber would have 4 MB
  // fetched past every landing and the next seek's read would have to share the
  // pipe with it. The one exception is a playhead that has settled (update
  // passes depth 1 then), where the next thing to happen is usually play.
  //
  // A new block is started only once every queued one has resolved, so a
  // struggling link never has speculative requests stacked on it. Not bracketed
  // as a priority read -- nobody is waiting on it yet; if the driver catches up
  // to it, the wait in _ensureBytes is. Never rejects: a failure resolves to
  // null and the driver reads directly.
  _prefetchNextBlock(depth = this.playing ? this._prefetchDepth : 0) {
    if (!this._byteBuffer || !this._reader) return;
    if (this._prefetches.length >= depth) return;
    const last = this._prefetches[this._prefetches.length - 1];
    if (last && !last.done) return;
    const start = last ? last.end + 1
      : this._byteBufferStart + this._byteBuffer.length;
    if (start >= this._reader.size) return;
    const end = Math.min(this._reader.size, start + MAX_BLOCK) - 1;
    const record = { start, end, done: false, promise: null };
    record.promise = this._reader.read(start, end)
      .then((bytes) => { record.done = true; return new Uint8Array(bytes); },
            () => { record.done = true; return null; });
    this._prefetches.push(record);
  }

  // Warm the loop origin's encoded bytes as a wrap approaches. The origin sits at
  // the start of the file, behind the tail the driver is streaming, so the read
  // the wrap triggers — the decode run restarts from the origin's keyframe — is a
  // blocking round trip, seconds of frozen picture on a distant bucket. Fetch it
  // in the background instead, into a side buffer _ensureBytes adopts at the wrap.
  //
  // A no-op when the origin frame is already decoded: a clip small enough to stay
  // cached across the wrap (see _keepRanges) needs no byte read there, so this
  // spends bytes only for a clip too large to keep resident — the case that
  // stalls. Never rejects; a failed read resolves to null and the wrap reads
  // directly, exactly as it does today.
  _prefetchLoopOrigin() {
    if (!this.loop || !this._reader || !this._index || !this._samples
        || !this._displayToDecode) return;
    const originFrame = this._loopStartFrame != null
      ? Math.min(this._loopStartFrame, this.numFrames - 1) : 0;
    // The wrap will show this frame from the cache — no byte read to warm.
    if (this._cache.has(originFrame)) return;
    const decodeIndex = this._displayToDecode[originFrame];
    if (decodeIndex === undefined) return;
    const sample = this._samples[this._keyframeForDecode(decodeIndex)];
    if (!sample) return;
    // Already in the read-ahead buffer, or already armed for this origin.
    if (this._bufferHolding(sample.offset, sample.size)) return;
    if (this._loopOriginPrefetch
        && this._loopOriginPrefetch.originFrame === originFrame) return;
    const start = sample.offset;
    const end = Math.min(this._reader.size, start + MAX_BLOCK) - 1;
    const record = { start, end, originFrame, done: false, bytes: null, promise: null };
    record.promise = this._reader.read(start, end).then(
      (bytes) => { record.done = true; record.bytes = new Uint8Array(bytes); return record.bytes; },
      () => { record.done = true; return null; });
    this._loopOriginPrefetch = record;
  }

  // Are the bytes [offset, offset+size) resident — in the current block, in the
  // previous one, or (when the two are contiguous) spanning both?
  _bufferHolding(offset, size) {
    return this._bytesAt(offset, size, false) !== null;
  }

  // The resident bytes [offset, offset+size): a view into whichever block holds
  // them whole, or, for a sample straddling the boundary between the previous
  // block and the current one, a fresh copy stitched from both (a sample is a
  // few kilobytes to a few hundred, so the copy is nothing). Null when they are
  // not all resident. `materialize: false` only asks the question.
  _bytesAt(offset, size, materialize = true) {
    const current = this._byteBuffer, currentStart = this._byteBufferStart;
    const previous = this._previousByteBuffer, previousStart = this._previousByteBufferStart;
    const end = offset + size;
    if (current && offset >= currentStart && end <= currentStart + current.length) {
      return materialize ? current.subarray(offset - currentStart, end - currentStart) : current;
    }
    if (previous && offset >= previousStart && end <= previousStart + previous.length) {
      return materialize ? previous.subarray(offset - previousStart, end - previousStart) : previous;
    }
    if (current && previous && previousStart + previous.length === currentStart
        && offset >= previousStart && offset < currentStart && end <= currentStart + current.length) {
      if (!materialize) return current;
      const stitched = new Uint8Array(size);
      const head = previous.subarray(offset - previousStart);
      stitched.set(head, 0);
      stitched.set(current.subarray(0, end - currentStart), head.length);
      return stitched;
    }
    return null;
  }
  _sliceSample(k) {
    const s = this._samples[k];
    return this._bytesAt(s.offset, s.size);
  }
  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Block until display frame N is decoded and cached (used to paint frame 0
  // on load, and by consumers that grab a frame's pixels — e.g. thumbnail
  // capture). Bounded so a bad clip fails instead of hanging.
  async ensureFrame(frameIndex) {
    this._request(frameIndex);
    const startedAt = performance.now();
    while (!this._cache.has(frameIndex)) {
      // A dead decoder will never produce this frame; fail now, not at the
      // timeout. This is also what lets load() (frame 0 goes through here)
      // reject promptly when the decoder dies during load, so
      // createBestEngine's fallback fires without a 5-second stall.
      if (this.failed) throw new Error('decoder failed');
      await this._sleep(8);
      if (performance.now() - startedAt > 5000) throw new Error('decode timed out');
    }
  }

  // The decoded ImageBitmap for display frame N, if resident in the cache
  // (call ensureFrame first to guarantee it). NOTE: the bitmap is in CODED
  // orientation and may be downscaled to _displayCapPixels on its long side —
  // consumers must apply `rotation` themselves and treat coordinates as
  // relative, not absolute pixels. NativeVideoEngine has no equivalent (a
  // <video> element cannot hand back a frame you can name), so hosts that need
  // pixels should check `frameIndexIsExact` or `tier` first.
  bitmapForFrame(frameIndex) { return this._cache.get(frameIndex); }

  // ---- rebuffering ---------------------------------------------------------
  // A display frame is "buffered" once it is decoded — resident in the cache, or
  // emitted and still becoming an ImageBitmap (_pending): either way it will
  // paint within a tick or two, so both count toward the lookahead the clock
  // waits for.
  _buffered(frame) { return this._cache.has(frame) || this._pending.has(frame); }

  // Seconds of contiguously-COVERED frames at and ahead of `frame`, where a
  // frame counts as covered if it can be shown without waiting on the network —
  // already decoded, OR its encoded bytes are resident and only need decoding.
  // (Both halves are needed: a frame just played has been decoded but its bytes
  // are long since freed, while a frame further ahead has bytes but is not
  // decoded yet — a bytes-only test would stop at the first already-played frame
  // and read zero.) This is the buffer that refills during a stall and the one a
  // normal player's buffer bar shows; the DECODED-frame cache alone cannot serve
  // here, because the bytes-not-frames memory ceiling keeps it to a handful of
  // frames on an HD clip (well under any reasonable rebufferSeconds), so gating
  // resume on decoded lookahead would hold such a clip for ever. Decode keeping
  // pace is a separate concern, answered by the drop-frames fallback.
  //
  // Infinity when the run reaches the last frame this engine can currently name
  // (the loop region's end, or the last indexed frame): there is no more to
  // download, so a short tail — or the growing edge of an index still being
  // built — must not hold the clock for ever. Reaching the growing edge resumes
  // the clock into the accumulation step's own `_waitingForIndex` wait, the
  // right instrument for a stall on the indexer rather than on bytes or decode.
  // The scan stops the moment it clears rebufferSeconds, so it never walks the
  // whole clip.
  _downloadedAheadSeconds(frame) {
    if (!this._index) return 0;
    const times = this._index.presentationTimes;
    const lastPlayable = this._loopEndFrame != null
      ? Math.min(this._loopEndFrame, this.numFrames - 1)
      : this.numFrames - 1;
    let m = frame;
    while (m <= lastPlayable) {
      const s = this._samples[this._displayToDecode[m]];
      const covered = this._buffered(m) || (s && this._bufferHolding(s.offset, s.size));
      if (!covered) break;
      const ahead = times[m] - times[frame];
      if (m > frame && ahead >= this._rebufferSeconds) return ahead;
      m++;
    }
    if (m > lastPlayable) return Infinity;
    return m > frame ? times[m - 1] - times[frame] : 0;
  }

  // Decide, at the top of a playing tick, whether the clock must HOLD this tick
  // rather than advance. Called before the playhead is advanced, so `frame` is
  // where playback currently sits. Sets this._rebuffering and returns it.
  //
  // Entering a hold takes a single undecoded frame under the playhead; LEAVING
  // one takes rebufferSeconds of decoded frames ahead of it. That hysteresis is
  // the point: resuming the instant the current frame alone decodes would
  // re-stall on the very next frame, so a hold refills a cushion before it lets
  // go — the way a buffering player waits past the first frame it recovers.
  _rebufferHold(now) {
    if (this._rebufferSeconds <= 0 || !this._index) { this._rebuffering = false; return false; }
    const frame = this.frameAtTime(this.playhead);
    // A void position (a leading empty edit) has no frame to wait on, and a
    // frame the decode circuit-breaker gave up on will never arrive — never
    // freeze on either.
    const unwaitable = this._inVoid || frame === this._stalledFrame;
    const buffered = this._buffered(frame);
    // Decode is behind (as opposed to the network) when the current frame is not
    // decoded but its ENCODED bytes are already resident: waiting on the network
    // would not be what unblocks it. Classified every tick, so the recovery
    // timer below measures real elapsed time since decode last fell short —
    // including the ticks spent holding.
    let decodeBehind = false;
    if (!unwaitable && !buffered) {
      const sample = this._samples[this._displayToDecode[frame]];
      decodeBehind = !!(sample && this._bufferHolding(sample.offset, sample.size));
    }
    if (decodeBehind) this._lastDecodeShortfall = now;
    // Decode has kept up for a full recovery interval: retire the drop-frames
    // fallback and clear the streak, so a later transient stall buffers cleanly
    // again. (The streak also clears when no fallback is active, so isolated
    // stalls spread across a session never accumulate into one.)
    else if (now - this._lastDecodeShortfall >= DECODE_RECOVERY_SECONDS * 1000) {
      this._droppingFrames = false;
      this._decodeStallStreak = 0;
    }

    if (this._rebuffering) {
      // Mid-hold: resume once the current frame is decoded (something to show)
      // AND the download has refilled to rebufferSeconds ahead of it (a cushion,
      // so we do not re-stall on the very next frame). A decode-bound hold has
      // its bytes already resident, so this reduces to "resume when the frame
      // decodes" — the drop-frames fallback, not a longer hold, is what answers
      // a decoder that cannot keep up.
      const resume = unwaitable
        || (buffered && this._downloadedAheadSeconds(frame) >= this._rebufferSeconds);
      if (resume) {
        this._rebuffering = false;
        return false;
      }
      return true;
    }

    // Not holding, and not stalled: advance.
    if (unwaitable || buffered) return false;

    // A fresh stall.
    if (decodeBehind && !this._droppingFrames) {
      // Count consecutive decode stalls not separated by a recovery; enough of
      // them means decode simply cannot keep up here.
      if (++this._decodeStallStreak >= DECODE_STALL_LIMIT) this._droppingFrames = true;
    }
    // In the fallback: let the clock run and drop frames rather than lurch. The
    // present step below holds the last frame until a newer one decodes. Only a
    // decode-bound stall drops — a network-bound one always holds, since
    // dropping frames with no bytes in hand just races the clock past a freeze.
    if (decodeBehind && this._droppingFrames) return false;
    this._rebuffering = true;
    return true;
  }

  // ---- per-tick clock + presentation --------------------------------------
  // Called once per render tick with the rAF timestamp. Advances the owned
  // playhead, drives decoding of the surrounding window, and paints the frame.
  update(now) {
    if (!this.ready) return;
    // The pane can get its size, or change it, after the clip was loaded — a host
    // that reveals the player only once the clip is ready, a CSS transition, a
    // flex reflow. Nothing announces that, so check it here rather than rely on
    // the host to call resizeCanvas() at exactly the right moment.
    this._syncCanvasSize();
    // A playhead that is not where the last tick left it was moved by the host
    // (seekToFrame, currentTime, playhead) rather than by the clock. The driver
    // then LANDS on the new frame -- a small, urgent read -- instead of treating
    // it as playback that fell behind (see _drive).
    if (this.playhead !== this._playheadAfterTick) {
      this._landing = true;
      this._playheadMovedAt = now;
    }
    if (this.playing) {
      // Hold the clock on the last frame instead of advancing into a frame that
      // is not decoded yet: playback buffers, the way an online player does,
      // rather than running the clock on and dropping every frame until decode
      // catches up (see _rebufferHold). _lastNow is still stamped below whether
      // we hold or not, so releasing the hold resumes without a time jump.
      const holdForBuffer = this._rebufferHold(now);
      if (this._lastNow && !holdForBuffer) {
        const previousPlayhead = this.playhead;
        this.playhead += (now - this._lastNow) / 1000 * this._playbackRate;
        // A loop region wraps early — but only for a playhead that reached its
        // end by playing forward. One that is already past the region (a host
        // seeked out of it) plays on to the clip's end and wraps back into the
        // region from there, rather than being yanked back the instant it lands.
        const wrapAt = this._loopWrapTime;
        if (this.loop && wrapAt < this.duration
            && previousPlayhead < wrapAt && this.playhead >= wrapAt) {
          this._wrapToLoopOrigin(wrapAt);
        } else if (this.playhead >= this.duration) {
          if (this.frameIndexState === 'growing') {
            // Not the end of the clip — the end of what has been indexed so far.
            // Hold on the last frame we can name and keep playing: the index
            // publishing its next run releases us (see _indexExtended). Looping
            // here would restart a clip the viewer is still in the middle of.
            this.playhead = Math.max(0, this.duration - 1e-6);
            this._waitingForIndex = true;
          } else if (this.loop) {
            // Wrap over the presented span only, not the whole timeline: a clip
            // with a leading empty edit loops back to its first frame's time,
            // never through the empty lead ahead of it. With a loop region set
            // this is the seeked-past-the-region case, and it lands on the
            // region's start — the one place every wrap goes.
            this._wrapToLoopOrigin(this.duration);
          } else {
            this.playhead = Math.max(0, this.duration - 1e-6);
            this.playing = false;
          }
        }
      }
      this._lastNow = now;
    } else {
      this._lastNow = 0;
      this._rebuffering = false;
    }

    const frame = this.frameAtTime(this.playhead);
    // A loop wrap moves the playhead inside this tick; it is a jump like any other.
    if (frame < this._frameAfterTick) this._landing = true;
    this._playheadAfterTick = this.playhead;
    this._frameAfterTick = frame;
    this._request(frame);   // streams/prefetches the window around `frame`
    // A paused playhead that has sat still this long belongs to a viewer who
    // landed somewhere, not one dragging the scrubber through it, and the play
    // that usually follows starts from a landing read only a fraction of a
    // block long. Bank the block after it now, while nothing is waiting on the
    // pipe. Half a second of stillness is what separates the two: a drag moves
    // the playhead far more often than that, so nothing is fetched under it.
    if (!this.playing && this._playheadMovedAt
        && now - this._playheadMovedAt >= SETTLE_MILLISECONDS) {
      this._prefetchNextBlock(1);
    }
    // Approaching a loop wrap while playing: warm the origin's bytes so the wrap
    // does not stall on a read from the start of the file (_prefetchLoopOrigin).
    if (this.playing && this.loop) {
      const untilWrap = this._loopWrapTime - this.playhead;
      if (untilWrap > 0 && untilWrap <= LOOP_PREFETCH_LEAD_SECONDS) {
        this._prefetchLoopOrigin();
      }
    }
    if (this._inVoid) {
      // No frame at this time — show an empty image, not frame 0 held. Frame 0's
      // window is still warmed above, so leaving the void paints instantly.
      if (this._shownFrame !== -1) this._presentEmpty();
    } else if (frame !== this._shownFrame) {
      const bitmap = this._cache.get(frame);
      if (bitmap) this._present(frame, bitmap);   // else hold last frame (stall)
    }
  }

  _present(frameIndex, bitmap) {
    bitmap = bitmap || this._bitmapFor(frameIndex);
    if (!bitmap) return;
    this._lastBitmap = bitmap;
    this._shownFrame = frameIndex;
    this._drawBitmap(bitmap);
  }

  // Clear the canvas to an empty (transparent) image and report no frame on
  // screen. Used when the playhead sits in a leading empty edit's void, where
  // there is no frame to present (see _inVoid) — the RGBA canvas makes "nothing"
  // a real value, distinct from a frame still decoding.
  _presentEmpty() {
    this._shownFrame = -1;
    this._lastBitmap = null;   // so a later resize does not repaint a stale frame
    const cw = this.canvas.width, ch = this.canvas.height;
    if (cw && ch) this.context.clearRect(0, 0, cw, ch);
  }

  // Size the canvas backing store to the pane (device pixels) and repaint the
  // current frame. Safe to call at any time; update() also calls it every tick,
  // so a host does not have to get the timing right.
  resizeCanvas() { this._syncCanvasSize(); }

  _syncCanvasSize() {
    // No pane at all: the canvas is not in a document tree. That is a real way
    // to use this engine — a host that only wants pixels (bitmapForFrame) and
    // never shows the canvas, e.g. generating a thumbnail during an upload — so
    // it is not an error, it is the 0x0 case below with nothing to measure.
    // Reading clientWidth off the null parent instead would throw out of
    // load(), which createBestEngine catches and reports as "WebCodecs cannot
    // play this clip": a silent, permanent fallback to the <video> element for
    // every offscreen host, on every clip.
    const pane = this.canvas.parentElement;
    if (!pane) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(pane.clientWidth * dpr);
    const height = Math.round(pane.clientHeight * dpr);

    // A pane with no layout — display:none, not yet in the document, a host that
    // reveals its player only once the clip is ready — measures 0x0. Leave the
    // canvas alone and wait to be called again once it has a box. Sizing it to
    // 1x1 here (the obvious clamp) would quietly replace the frame with a single
    // pixel of its average colour, which CSS then stretches across the pane: a
    // flat wash that looks like a decode failure but is a layout bug.
    //
    // Both early returns self-heal: update() calls this every animation frame,
    // so a canvas that later gains a parent, or a box, starts painting then.
    if (!width || !height) return;

    if (this.canvas.width === width && this.canvas.height === height) return;
    // Assigning either dimension clears the canvas, so this must repaint.
    this.canvas.width = width;
    this.canvas.height = height;
    if (this._lastBitmap) this._drawBitmap(this._lastBitmap);
  }

  _drawBitmap(bitmap) {
    // Letterbox the frame inside the canvas (like <video>'s object-fit:
    // contain), centered, preserving the source aspect — so a host aligning
    // other elements to the video can compute the same rectangle. The track's
    // display rotation is applied here: cached bitmaps stay in coded
    // orientation, and the upright (display) aspect drives the letterbox.
    const cw = this.canvas.width, ch = this.canvas.height, ctx = this.context;
    if (!cw || !ch) return;   // pane not laid out yet; resizeCanvas will repaint
    ctx.clearRect(0, 0, cw, ch);
    // Assigning canvas.width/height (_syncCanvasSize, on every real resize)
    // resets all context state back to its defaults, imageSmoothingEnabled
    // included — so this must be reasserted on every draw, not just once.
    ctx.imageSmoothingEnabled = this._imageSmoothingEnabled;
    const rotation = this.rotation || 0;
    const swapAxes = rotation === 90 || rotation === 270;
    const displayW = swapAxes ? bitmap.height : bitmap.width;
    const displayH = swapAxes ? bitmap.width : bitmap.height;
    const sourceAspect = displayW / displayH, paneAspect = cw / ch;
    let drawWidth, drawHeight;
    if (paneAspect > sourceAspect) { drawHeight = ch; drawWidth = ch * sourceAspect; }
    else { drawWidth = cw; drawHeight = cw / sourceAspect; }
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    if (rotation) ctx.rotate(rotation * Math.PI / 180);
    // Inside the rotated frame the bitmap's own axes apply, so its draw box
    // is the display box with width/height swapped back when rotated 90/270.
    const bitmapDrawW = swapAxes ? drawHeight : drawWidth;
    const bitmapDrawH = swapAxes ? drawWidth : drawHeight;
    ctx.drawImage(bitmap, -bitmapDrawW / 2, -bitmapDrawH / 2, bitmapDrawW, bitmapDrawH);
    ctx.restore();
  }

  // Release the decoder and all cached bitmaps. Call when done with the
  // engine (e.g. closing the dialog that hosts it) — decoders are a limited
  // browser resource, so discarded engines must not wait for garbage
  // collection. The engine remains usable: load() creates a fresh decoder.
  destroy() { this._teardown(); }

  _teardown() {
    this.ready = false;
    this.playing = false;
    this.failed = false;
    this._waitingForIndex = false;
    // Rebuffering conclusions are per-clip: a new load may be a different
    // resolution/codec the machine decodes at a different rate.
    this._rebuffering = false;
    this._droppingFrames = false;
    this._decodeStallStreak = 0;
    this._lastDecodeShortfall = 0;
    // Stop listening to the index before letting go of it: the same index can be
    // handed on to another engine (createBestEngine falls back to the <video>
    // element after a WebCodecs load failure), and a torn-down engine must not
    // still be reacting to it.
    if (this._indexListeners) {
      const { index, onExtended, onSettled } = this._indexListeners;
      index.removeEventListener('extended', onExtended);
      index.removeEventListener('complete', onSettled);
      index.removeEventListener('truncated', onSettled);
      this._indexListeners = null;
    }
    if (this._videoDecoder) {
      try { this._videoDecoder.close(); } catch (e) { /* already closed */ }
      this._videoDecoder = null;
    }
    // Swap in a fresh cache map so any createImageBitmap still resolving from
    // the old session (see _absorb's cacheRef check) closes its bitmap instead
    // of populating the new clip's cache.
    for (const bitmap of this._cache.values()) bitmap.close();
    this._cache = new Map();
    this._pending.clear();
    this._driving = false;
    this._runKeyframe = -1;
    this._fedThrough = -1;
    this._drained = false;
    this._restartTarget = -1;
    this._restartCount = 0;
    this._stalledFrame = -1;
    this._sourceReadFailures = 0;
    this._byteBuffer = null;
    this._byteBufferStart = 0;
    this._previousByteBuffer = null;
    this._previousByteBufferStart = 0;
    this._prefetches = [];
    this._loopOriginPrefetch = null;
    // _prefetchDepth is kept: it describes the link, not the clip.
    this._landing = true;
    this._playheadAfterTick = -1;
    this._frameAfterTick = -1;
    this._playheadMovedAt = 0;
    this._lastBitmap = null;
    this._shownFrame = -1;
    this._hideError();
  }

  // Error display is the host page's job (it owns the DOM and any i18n):
  // detail.message is the human-readable reason, or null to clear a
  // previously shown error.
  _showError(message) {
    this.dispatchEvent(new CustomEvent('errormessage', { detail: { message } }));
  }
  _hideError() {
    this.dispatchEvent(new CustomEvent('errormessage', { detail: { message: null } }));
  }
}

