import { ContainerIndex } from './container-index.js';

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
// so a frame we asked for can legitimately lag the samples we fed by a few — but
// only a few. Past this, it is not in the pipeline: it was decoded earlier and
// evicted, and it has to be decoded again rather than waited for.
const REORDER_DEPTH = 16;

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
  //
  // options.cacheBytes: the memory ceiling for decoded frames (default 96 MB).
  // This, not windowAhead, is what bounds the engine's memory — the window is
  // cut to fit it, so a 4K clip caches few frames and a 360p clip caches many.
  constructor(presentationCanvas, options = {}) {
    super();
    this.canvas = presentationCanvas;
    this.context = presentationCanvas.getContext('2d');
    this.ready = false;
    this.playing = false;
    this.loop = true;
    this._playbackRate = 1;

    this.playhead = 0;          // seconds on the composition timeline
    this.duration = 0;
    this.numFrames = 0;

    this._index = null;
    this._reader = null;
    this._videoDecoder = null;
    this._decoderConfig = null;
    // True once the VideoDecoder has reported an unrecoverable error (see
    // _decoderFailed); cleared by load()/_teardown().
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
    this._wantedWindowBack = 18;
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
    this._byteBuffer = null;          // read-ahead buffer of encoded bytes
    this._byteBufferStart = 0;        // its file offset

    this._shownFrame = -1;
    this._lastBitmap = null;
    this._lastNow = 0;
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
  // construction — there is no browser presentation to be uncertain about.
  get frameIndexIsExact() { return true; }

  frameAtTime(t) { return this._index ? this._index.frameAtTime(t) : 0; }

  get currentFrame() { return this.frameAtTime(this.playhead); }

  // Continuous playhead in frame units (frame index + fraction through that
  // frame's display interval) — what a host should drive any frame-indexed
  // display it renders in sync with the video (interpolated overlays etc.)
  // from, in place of the drift-prone `currentTime * frameRate`.
  get currentFrameFloat() {
    return this._index ? this._index.frameFloatAtTime(this.playhead) : 0;
  }

  get currentTime() { return this.playhead; }
  set currentTime(t) { this.playhead = Math.max(0, Math.min(this.duration, t)); }

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

  // options.index: a ContainerIndex already built for this source (createBestEngine
  // builds one up front and hands the same one to whichever engine plays, so the
  // moov is never parsed twice). Omit it and the engine builds its own.
  async load(source, options = {}) {
    this._teardown();
    try {
      const index = options.index
        || await ContainerIndex.fromSource(source);
      if (!index.supportsWebCodecs) {
        // A WebM index: exact timestamps, but no sample table and no decoder
        // configuration, so there is nothing here to decode from. The clip is
        // fine — it belongs on NativeVideoEngine, which the same index makes
        // frame-exact anyway.
        throw new Error(`this ${index.containerFormat} container carries no `
          + 'sample table for WebCodecs to decode from');
      }
      this._adoptIndex(index);

      const support = await VideoDecoder.isConfigSupported(this._decoderConfig);
      if (!support.supported) {
        throw new Error('codec not supported: ' + this._decoderConfig.codec);
      }

      this._configureDecoder();
      this.playhead = 0;
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
    this._timescale = index.timescale;
    this._samples = index.samples;
    this._keyframeDecodeIndices = index.keyframeDecodeIndices;
    this._displayToDecode = index.displayToDecode;
    this._microsToDisplay = index.microsToDisplay;
    this.numFrames = index.numFrames;
    this.duration = index.duration;
    this.rotation = index.rotation;
    this.videoWidth = index.videoWidth;
    this.videoHeight = index.videoHeight;
    this._sizeWindows();
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
  _configureDecoder() {
    this._videoDecoder = new VideoDecoder({
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

  _insideWindow(displayIndex) {
    return this._windowCenters().some((center) =>
      displayIndex >= center - this._windowBack
      && displayIndex <= center + this._windowAhead + this._windowSlack);
  }

  // A decoded frame arrived. Cache it (as an ImageBitmap, freeing the decoder's
  // bounded frame pool) if it falls inside a window we care about; otherwise drop.
  _absorb(frame) {
    const displayIndex = this._microsToDisplay.get(frame.timestamp);
    if (displayIndex === undefined
        || !this._insideWindow(displayIndex)
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
    this._target = frameIndex;
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
        const aheadFrame = Math.min(this.numFrames - 1, target + this._windowAhead);
        const decodeGoal = Math.max(targetDecode, this._displayToDecode[aheadFrame]);
        const lastSample = this._samples.length - 1;
        // Decoded, or decoded and still becoming an ImageBitmap. Either way it is
        // coming, and re-decoding it would be wasted work.
        const haveTarget = this._cache.has(target) || this._pending.has(target);

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
        // Bounded by REORDER_DEPTH: a decoder holds only a few frames back, so
        // once we are well past the target with nothing to show for it, the frame
        // is not in the pipeline at all -- it came out earlier and was evicted
        // (a backward seek), and feeding forward would read to the end of the
        // clip to find something that is behind us.
        const stillComing = !haveTarget
          && this._fedThrough < lastSample
          && this._fedThrough < targetDecode + REORDER_DEPTH;
        if (this._fedThrough < decodeGoal || stillComing) {
          // A drained decoder accepts nothing but a key frame, and the next
          // sample in decode order is a delta. Begin the run again.
          if (this._drained) { this._restartRun(keyframe); continue; }
          // Keep few chunks in flight so few decoded frames (which may be 4K)
          // coexist before we downscale + cache them.
          if (this._videoDecoder.decodeQueueSize > 4) { await this._sleep(0); continue; }
          const k = this._fedThrough + 1;
          const s = this._samples[k];
          // Until the target is on screen, every byte we fetch beyond the ones
          // it depends on is a byte the viewer waits on for nothing. So read
          // only as far as the target's own sample while it is outstanding, and
          // switch to big background blocks once it has surfaced. On a slow link
          // this is the difference between waiting for one keyframe and waiting
          // for a fixed 4 MB block.
          await this._ensureBytes(s.offset, s.size,
            this._cache.has(target) ? 0 : this._bytesThrough(k, targetDecode));
          if (!this._videoDecoder || this._fedThrough !== k - 1) continue;  // restarted mid-read
          this._videoDecoder.decode(new EncodedVideoChunk({
            type: s.isSync ? 'key' : 'delta',
            timestamp: Math.round(s.cts * 1e6 / this._timescale),
            duration: Math.round(s.duration * 1e6 / this._timescale),
            data: this._sliceSample(k),
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
      console.error('decode driver:', err);
    }
    this._driving = false;
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
  async _ensureBytes(offset, size, wanted = 0) {
    const buffer = this._byteBuffer;
    if (buffer && offset >= this._byteBufferStart
        && offset + size <= this._byteBufferStart + buffer.length) return;
    const MAX_BLOCK = 1 << 22;   // 4 MB
    const MIN_BLOCK = 1 << 18;   // 256 KB — a round trip costs more than these bytes
    const block = wanted > 0
      ? Math.min(MAX_BLOCK, Math.max(size, Math.min(wanted, MAX_BLOCK), MIN_BLOCK))
      : MAX_BLOCK;
    const end = Math.min(this._reader.size, offset + block) - 1;
    this._byteBuffer = new Uint8Array(await this._reader.read(offset, end));
    this._byteBufferStart = offset;
  }
  _sliceSample(k) {
    const s = this._samples[k];
    const rel = s.offset - this._byteBufferStart;
    return this._byteBuffer.subarray(rel, rel + s.size);
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
    if (this.playing) {
      if (this._lastNow) {
        this.playhead += (now - this._lastNow) / 1000 * this._playbackRate;
        if (this.playhead >= this.duration) {
          if (this.loop) {
            this.playhead -= this.duration;
            if (!(this.playhead >= 0 && this.playhead < this.duration)) this.playhead = 0;
          } else {
            this.playhead = Math.max(0, this.duration - 1e-6);
            this.playing = false;
          }
        }
      }
      this._lastNow = now;
    } else {
      this._lastNow = 0;
    }

    const frame = this.frameAtTime(this.playhead);
    this._request(frame);   // streams/prefetches the window around `frame`
    if (frame !== this._shownFrame) {
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
    this._byteBuffer = null;
    this._byteBufferStart = 0;
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

