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
// <video> element never exposes that table. mp4box can build it from the moov
// alone, without decoding a single frame, so we build it whenever we can and
// hand it to whichever engine ends up playing (see ContainerIndex). That is
// what makes the <video> path frame-exact on variable-frame-rate clips rather
// than merely close.
//
// createBestEngine() picks the best available combination for a given clip and
// browser, degrading in this order:
//
//   1. container index + WebCodecs   exact index, exact decode, owned clock
//   2. container index + <video>     exact index, browser decode + presentation
//   3. declared frame rate + <video> exact for constant-frame-rate clips only
//   4. no requestVideoFrameCallback  currentTime * frameRate; last resort
//
// Decode (engine 1) is windowed by GOP (group of pictures: a keyframe plus the
// frames that depend on it). To show a frame we decode just its GOP, cache the
// results as ImageBitmaps, and evict distant GOPs, so memory stays flat
// regardless of clip length (handles multi-minute clips).
//
// Classic (non-module) script defining six globals — UrlRangeReader,
// FileRangeReader, ContainerIndex, VideoEngine, NativeVideoEngine, and
// createBestEngine — so both module and non-module host pages can use it.
// mp4box.js (the `MP4Box` / `DataStream` globals) should be loaded first; if it
// is absent, only step 3/4 above remain available.
//
// Neither engine touches the host page's DOM beyond the canvas or <video> it is
// given. Errors surface as an 'errormessage' CustomEvent whose detail.message
// is a human-readable string, or null when a previous error should be cleared;
// the host owns rendering (and translating) that message.
// ==================================================================

// Random-access byte readers used to feed mp4box (the moov index) and to fetch
// encoded samples per GOP on demand — only the bytes actually needed are read.
// URLs go over HTTP Range (the server must answer 206); local Files use
// File.slice.
class UrlRangeReader {
  constructor(url) { this.url = url; this.size = 0; }
  async init() {
    const r = await fetch(this.url, { headers: { Range: 'bytes=0-0' } });
    if (r.status !== 206 && r.status !== 200) throw new Error(`range probe ${r.status}`);
    const contentRange = r.headers.get('Content-Range');   // "bytes 0-0/<total>"
    if (contentRange) this.size = parseInt(contentRange.split('/')[1], 10);
    else {
      const len = r.headers.get('Content-Length');
      this.size = len ? parseInt(len, 10) : 0;
    }
    await r.arrayBuffer();   // drain the probe body
  }
  async read(start, endInclusive) {
    const r = await fetch(this.url,
      { headers: { Range: `bytes=${start}-${endInclusive}` } });
    if (r.status !== 206 && r.status !== 200) throw new Error(`range read ${r.status}`);
    return await r.arrayBuffer();
  }
}

class FileRangeReader {
  constructor(file) { this.file = file; this.size = file.size; }
  async init() {}
  async read(start, endInclusive) {
    return await this.file.slice(start, endInclusive + 1).arrayBuffer();
  }
}

// A source is a URL string (server must answer HTTP Range with 206) or a
// File/Blob (browsed local clip).
function createRangeReader(source) {
  return (typeof source === 'string')
    ? new UrlRangeReader(source) : new FileRangeReader(source);
}

// ==================================================================
// ContainerIndex — everything the moov tells us, with nothing decoded.
//
// This is the piece both engines want and neither can get from a <video>
// element: the real per-frame presentation timestamp table (B-frame safe,
// variable-frame-rate safe), plus the sample table, the display rotation, and
// the decoder configuration. Building it reads only the moov — a few range
// requests, no frame bytes, no VideoDecoder — so it works in browsers that have
// no WebCodecs at all, which is exactly what makes the <video> fallback
// frame-exact rather than fps-guessing.
//
// Limited to ISOBMFF (mp4/m4v/mov), because that is what mp4box parses. A WebM
// or Ogg clip will fail here, and the <video> element will still play it — just
// without an exact index. That is the intended degradation, not a bug.
// ==================================================================
class ContainerIndex {
  constructor(reader) {
    this.reader = reader;
    this.timescale = 1;

    // Decode-order sample table (no frame bytes): {offset, size, isSync, cts,
    // duration}. The byte ranges the decoder will later fetch on demand.
    this.samples = null;
    this.keyframeDecodeIndices = null;   // sorted decode indices of sync samples

    // Display order (samples sorted by composition time).
    this.presentationTimes = null;   // Float64Array, seconds, frame 0 at t = 0
    this.frameDurations = null;      // Float64Array, seconds
    this.displayToDecode = null;     // Int32Array, displayIndex -> decode index
    this.microsToDisplay = null;     // Map<chunkTimestampMicros, displayIndex>

    this.decoderConfig = null;
    this.rotation = 0;               // 0/90/180/270
    this.videoWidth = 0;             // upright display dimensions (rotation applied)
    this.videoHeight = 0;
    this.numFrames = 0;
    this.duration = 0;               // seconds (sum of real frame durations)
  }

  static async load(reader) {
    if (typeof MP4Box === 'undefined') throw new Error('mp4box.js is not loaded');
    const index = new ContainerIndex(reader);
    await index._demux(reader);
    return index;
  }

  // Build an index straight from a source, for hosts that want the frame table
  // without instantiating an engine.
  static async fromSource(source) {
    const reader = createRangeReader(source);
    await reader.init();
    return await ContainerIndex.load(reader);
  }

  // Largest display frame whose presentation time is <= t (binary search over
  // the real per-frame PTS table — no fps assumption, so constant and variable
  // frame rate alike).
  frameAtTime(t) {
    const times = this.presentationTimes;
    if (!times || !times.length) return 0;
    let lo = 0, hi = times.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // Frame index plus the fraction elapsed through that frame's real display
  // interval — the continuous playhead a synchronized overlay should follow.
  frameFloatAtTime(t) {
    const times = this.presentationTimes;
    if (!times || !times.length) return 0;
    const n = this.frameAtTime(t);
    const start = times[n];
    const end = (n + 1 < times.length)
      ? times[n + 1] : start + this.frameDurations[n];
    const span = end - start;
    const fraction = span > 0 ? (t - start) / span : 0;
    return n + Math.max(0, Math.min(1, fraction));
  }

  // The frame index of a timestamp that is known to BE a frame's presentation
  // time — what requestVideoFrameCallback reports for the frame on screen.
  //
  // Not the same question as frameAtTime, and it must not be answered the same
  // way. Our table computes each time from the container's integer composition
  // time and timescale; the browser computes its mediaTime (and its duration,
  // which it clamps seeks against) its own way, and the two disagree in the last
  // few microseconds. Under "largest entry at or below t" an undershoot that
  // small reads as the PREVIOUS frame — a whole frame wrong, from a rounding
  // error a thousand times smaller than a frame. Snapping to the entry within a
  // tolerance far below any real frame duration is immune to that.
  frameOfPresentedTime(t) {
    const SNAP_SECONDS = 1e-4;   // ~100x the disagreement, ~1/40th of a 240fps frame
    return this.frameAtTime(t + SNAP_SECONDS);
  }

  // The midpoint of frame n's display interval. Seeking a <video> element here
  // (rather than to the frame's start, which sits exactly on the boundary the
  // browser rounds at) is what makes it land on frame n and not its neighbour.
  midpointOfFrame(n) {
    const times = this.presentationTimes;
    const start = times[n];
    const end = (n + 1 < times.length)
      ? times[n + 1] : start + this.frameDurations[n];
    return (start + end) / 2;
  }

  async _demux(reader) {
    const file = MP4Box.createFile(false);   // false: discard mdat bytes
    let info = null, demuxError = null;
    file.onReady = (i) => { info = i; };
    file.onError = (e) => { demuxError = new Error('mp4box: ' + e); };

    // Feed the container until the moov (index) is parsed. appendBuffer returns
    // the next byte offset it wants, which jumps past the mdat when the moov
    // sits at the end of the file — so we never read frame bytes here.
    const CHUNK = 1 << 18;   // 256 KB
    let offset = 0;
    while (info === null && demuxError === null && offset < reader.size) {
      const end = Math.min(offset + CHUNK, reader.size) - 1;
      const buffer = await reader.read(offset, end);
      if (!buffer.byteLength) break;
      buffer.fileStart = offset;
      offset = file.appendBuffer(buffer);
    }
    file.flush();
    if (demuxError) throw demuxError;
    if (!info) throw new Error('no moov found (not a valid MP4?)');

    const videoTrack = info.videoTracks && info.videoTracks[0];
    if (!videoTrack) throw new Error('no video track in file');

    this.decoderConfig = {
      codec: videoTrack.codec,
      codedWidth: videoTrack.video.width,
      codedHeight: videoTrack.video.height,
      description: this._codecDescription(file, videoTrack.id),
      optimizeForLatency: true,   // emit frames promptly; less internal buffering
    };

    // Display geometry. Phone clips are commonly coded landscape with a 90°
    // track rotation matrix; a <video> tag applies it but VideoDecoder does
    // not, so VideoEngine's presentation (and any consumer annotating over the
    // video) must. videoWidth/videoHeight are the upright *display* dimensions
    // — axes swapped relative to the coded frame when rotation is 90/270 — and
    // mean the same thing in both engines.
    this.rotation = this._trackRotation(videoTrack);
    const swapAxes = this.rotation === 90 || this.rotation === 270;
    this.videoWidth = swapAxes ? videoTrack.video.height : videoTrack.video.width;
    this.videoHeight = swapAxes ? videoTrack.video.width : videoTrack.video.height;

    this._buildTables(file.getTrackSamplesInfo(videoTrack.id));
  }

  _codecDescription(file, trackId) {
    // The avcC/hvcC/etc. box bytes that VideoDecoder.configure needs, serialized
    // and stripped of the 8-byte box header (size + type). Recipe from the W3C
    // WebCodecs mp4-decode sample.
    const trak = file.getTrackById(trackId);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8);
      }
    }
    return undefined;   // VP8/VP9/AV1 may legitimately carry no description
  }

  // The track's display rotation in degrees (0/90/180/270), read from the
  // tkhd matrix (2x2 rotation part, 16.16 fixed point). Anything that isn't a
  // clean multiple of 90 is treated as 0.
  _trackRotation(videoTrack) {
    const matrix = videoTrack.matrix;
    if (!matrix || matrix.length < 5) return 0;
    const a = matrix[0] / 65536, b = matrix[1] / 65536;
    const degrees = Math.round(Math.atan2(b, a) * 180 / Math.PI);
    const normalized = ((degrees % 360) + 360) % 360;
    return (normalized % 90 === 0) ? normalized : 0;
  }

  _buildTables(samples) {
    const n = samples.length;
    this.timescale = n ? samples[0].timescale : 1;

    // Decode-order records (the first sample is always a keyframe).
    this.samples = new Array(n);
    const keyframes = [];
    for (let k = 0; k < n; k++) {
      const s = samples[k];
      const isSync = !!s.is_sync || k === 0;
      if (isSync) keyframes.push(k);
      this.samples[k] = {
        offset: s.offset, size: s.size, isSync, cts: s.cts, duration: s.duration,
      };
    }
    this.keyframeDecodeIndices = keyframes;   // ascending == decode order

    // Display order = samples sorted by composition time (B-frame safe). Times
    // are normalized so display frame 0 sits at t = 0: with B-frames the first
    // composition time is often a nonzero offset, and both engines want a
    // timeline whose origin is the first frame the viewer sees.
    const order = Array.from({ length: n }, (_, k) => k);
    order.sort((a, b) => this.samples[a].cts - this.samples[b].cts);
    const cts0 = n ? this.samples[order[0]].cts : 0;
    this.presentationTimes = new Float64Array(n);
    this.frameDurations = new Float64Array(n);
    this.displayToDecode = new Int32Array(n);
    this.microsToDisplay = new Map();
    for (let d = 0; d < n; d++) {
      const k = order[d];
      const s = this.samples[k];
      this.presentationTimes[d] = (s.cts - cts0) / this.timescale;
      this.frameDurations[d] = s.duration / this.timescale;
      this.displayToDecode[d] = k;
      this.microsToDisplay.set(Math.round(s.cts * 1e6 / this.timescale), d);
    }
    this.numFrames = n;
    this.duration = n
      ? this.presentationTimes[n - 1] + this.frameDurations[n - 1] : 0;
  }
}

// ==================================================================
// VideoEngine — WebCodecs. Authoritative: we decide which frame is on screen.
// ==================================================================
class VideoEngine extends EventTarget {
  constructor(presentationCanvas) {
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
    this._cacheBudget = 80;           // max resident decoded frames
    this._windowBack = 18;            // keep this many frames behind the playhead
    this._windowAhead = 56;           // read-ahead target (≈2 s) to absorb decode jitter
    // Cached bitmaps are for display only (frame-index accuracy is independent
    // of their resolution), so cap their long side: a 4K clip otherwise costs
    // ~33 MB/frame and the cache would blow past 1 GB. The canvas pane is never
    // bigger than the screen, so this is invisible. 1080p and smaller keep full
    // resolution (no downscale).
    this._displayCapPixels = 1920;
    this._runKeyframe = -1;           // decode index the current decode run began at
    this._fedThrough = -1;            // highest decode index fed to the decoder
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
  }

  // ---- decode (streaming, frame-windowed) ---------------------------------
  _configureDecoder() {
    this._videoDecoder = new VideoDecoder({
      output: (frame) => this._absorb(frame),
      error: (e) => { console.error('VideoDecoder error:', e);
                      this._showError(e.message || String(e)); },
    });
    this._videoDecoder.configure(this._decoderConfig);
    this._runKeyframe = -1;
    this._fedThrough = -1;
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

  // A decoded frame arrived. Cache it (as an ImageBitmap, freeing the decoder's
  // bounded frame pool) if it falls inside the playhead window; otherwise drop.
  _absorb(frame) {
    const displayIndex = this._microsToDisplay.get(frame.timestamp);
    const current = this.currentFrame;
    if (displayIndex === undefined
        || displayIndex < current - this._windowBack
        || displayIndex > current + this._windowAhead + 8
        || this._cache.has(displayIndex)) {
      frame.close();
      return;
    }
    const cacheRef = this._cache;   // detect a teardown/reload mid-conversion
    // Downscale oversized frames (e.g. 4K) when caching — display only.
    let options;
    const longSide = Math.max(frame.displayWidth, frame.displayHeight);
    if (longSide > this._displayCapPixels) {
      const scale = this._displayCapPixels / longSide;
      options = {
        resizeWidth: Math.max(1, Math.round(frame.displayWidth * scale)),
        resizeHeight: Math.max(1, Math.round(frame.displayHeight * scale)),
        resizeQuality: 'medium',
      };
    }
    createImageBitmap(frame, options).then((bitmap) => {
      frame.close();
      if (cacheRef !== this._cache || cacheRef.has(displayIndex)) { bitmap.close(); return; }
      cacheRef.set(displayIndex, bitmap);
      this._evict();
    }).catch(() => { try { frame.close(); } catch (e) { /* already closed */ } });
  }

  _evict() {
    if (this._cache.size <= this._cacheBudget) return;
    const current = this.currentFrame;
    // Forward-biased: drop frames BEHIND the playhead first (forward playback
    // won't revisit them), farthest-behind first; only then frames far AHEAD.
    // This protects the read-ahead window we just paid to decode — a symmetric
    // distance metric would instead evict the about-to-be-shown read-ahead.
    const rank = (k) => (k < current) ? 2e6 + (current - k) : (k - current);
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

        // Hard restart when the target lives in a different GOP than the current
        // run. Backward seeks within the same GOP are handled below (after a
        // flush confirms the frame was evicted, not merely pending).
        if (this._runKeyframe !== keyframe) this._restartRun(keyframe);

        // Need more frames decoded? Feed the next sample (in decode order).
        if (this._fedThrough < decodeGoal) {
          // Keep few chunks in flight so few decoded frames (which may be 4K)
          // coexist before we downscale + cache them.
          if (this._videoDecoder.decodeQueueSize > 4) { await this._sleep(0); continue; }
          const k = this._fedThrough + 1;
          const s = this._samples[k];
          await this._ensureBytes(s.offset, s.size);
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

        // Fed through the goal. If the target hasn't surfaced yet, it may be
        // stuck in the decoder's reorder buffer — flush to force it out.
        if (!this._cache.has(target) && this._target === target) {
          await this._videoDecoder.flush();
          if (this._target !== target) continue;       // playhead moved; re-evaluate
          if (!this._cache.has(target)) {
            // Fed every dependency and flushed, yet the target never cached. It
            // was decoded earlier and evicted (a backward seek beyond the
            // window): re-decode from the keyframe. Guard against an impossible
            // target so a bad frame can't spin the loop forever.
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
  }

  // Ensure the encoded bytes for [offset, offset+size) are in the read-ahead
  // buffer, fetching a larger block (covering many subsequent samples) on a miss.
  async _ensureBytes(offset, size) {
    const buffer = this._byteBuffer;
    if (buffer && offset >= this._byteBufferStart
        && offset + size <= this._byteBufferStart + buffer.length) return;
    const READ_AHEAD = 1 << 22;   // 4 MB
    const end = Math.min(this._reader.size, offset + READ_AHEAD) - 1;
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
  // current frame. Called from the window resize handler.
  resizeCanvas() {
    const pane = this.canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(pane.clientWidth * dpr));
    const height = Math.max(1, Math.round(pane.clientHeight * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
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
    if (this._videoDecoder) {
      try { this._videoDecoder.close(); } catch (e) { /* already closed */ }
      this._videoDecoder = null;
    }
    // Swap in a fresh cache map so any createImageBitmap still resolving from
    // the old session (see _absorb's cacheRef check) closes its bitmap instead
    // of populating the new clip's cache.
    for (const bitmap of this._cache.values()) bitmap.close();
    this._cache = new Map();
    this._driving = false;
    this._runKeyframe = -1;
    this._fedThrough = -1;
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

// ==================================================================
// NativeVideoEngine — a <video> element behind the same surface as VideoEngine.
//
// Observational, not authoritative: the browser decides which frame is on
// screen and we find out afterwards. Two things make that good enough to
// annotate against.
//
// 1. The presented-frame clock. requestVideoFrameCallback hands us, for each
//    frame as it is presented, that frame's exact presentation timestamp
//    (`mediaTime`) and the wall-clock moment it appeared. video.currentTime is
//    unusable for frame mapping twice over: it keeps advancing through decoder
//    stalls (e.g. the restart when a looping clip wraps to 0) while the
//    displayed frame is frozen, which lets a synchronized overlay run away from
//    the pixels; and on iOS WebKit it only refreshes at coarse uneven
//    intervals, which makes between-frame motion jerky. So we extrapolate a
//    smooth playhead from the last presented frame using performance.now()
//    (which advances perfectly evenly), and clamp it to the hold interval of
//    the frame actually on screen — a no-op in steady playback, and during a
//    stall it pins the overlay to the visible frame, so motion degrades to
//    whole-frame steps but stays in sync with the equally stuttering video.
//
// 2. The container index, when we have one. `mediaTime` is an exact timestamp,
//    but turning a timestamp into a frame *index* needs the table of every
//    frame's PTS, which a <video> element never exposes. Given a ContainerIndex
//    we binary-search it and the index is exact on variable-frame-rate clips.
//    Without one we fall back to `mediaTime * framesPerSecond`, which is exact
//    only if the clip really is constant-frame-rate — the accepted trade for
//    playing containers mp4box cannot parse.
// ==================================================================
class NativeVideoEngine extends EventTarget {
  constructor(videoElement) {
    super();
    this.video = videoElement;
    this.ready = false;
    this.numFrames = 0;
    this.framesPerSecond = 30;     // only used when there is no container index
    this.rotation = 0;

    this._index = null;
    // Seconds to add to a container-index time to get a time on the element's
    // own timeline. Nonzero when the container carries an edit list or a
    // nonzero start time; calibrated at load (see _calibrateTimeOffset).
    this._timeOffset = 0;
    this._indexStrikes = 0;        // consecutive presented frames that missed the table

    this._loop = true;
    this._rate = 1;                // reapplied after each load (src reset clears it)
    this._objectUrl = null;

    // The presented-frame clock: the exact PTS of the frame currently on screen
    // and the wall-clock moment it was presented. Both stay null/0 until the
    // first frame presents, and forever where requestVideoFrameCallback is
    // unsupported (pre-15.4 Safari), in which case mapping falls back to raw
    // currentTime.
    this._presentedMediaTime = null;
    this._presentedAt = 0;
    this._presentWaiters = [];

    videoElement.muted = true;
    videoElement.playsInline = true;   // iOS: play inline, no auto-fullscreen
    videoElement.addEventListener('dblclick', (e) => e.preventDefault());

    this.hasPresentedFrameClock = 'requestVideoFrameCallback' in videoElement;
    this._clockStopped = false;
    if (this.hasPresentedFrameClock) {
      this._onPresentedFrame = this._onPresentedFrame.bind(this);
      videoElement.requestVideoFrameCallback(this._onPresentedFrame);
    }
  }

  // The presented-frame callback re-registers itself, so it would outlive a
  // destroyed engine and keep a reference to it alive. There is no way to cancel
  // a pending requestVideoFrameCallback, so destroy() sets this and the callback
  // declines to re-register; load() starts it up again if it had stopped.
  _startPresentedFrameClock() {
    if (!this.hasPresentedFrameClock || !this._clockStopped) return;
    this._clockStopped = false;
    this.video.requestVideoFrameCallback(this._onPresentedFrame);
  }

  get displayElement() { return this.video; }
  get paused() { return this.video.paused; }
  play() { const p = this.video.play(); if (p) p.catch(() => {}); }
  pause() { this.video.pause(); }
  get playbackRate() { return this.video.playbackRate; }
  set playbackRate(rate) { this._rate = rate; this.video.playbackRate = rate; }
  get loop() { return this._loop; }
  set loop(value) { this._loop = value; this.video.loop = value; }

  // Upright display dimensions. The element applies the track's rotation
  // itself, so these already account for it — the same meaning VideoEngine's
  // videoWidth/videoHeight carry.
  get videoWidth() {
    return this.video.videoWidth || (this._index ? this._index.videoWidth : 0);
  }
  get videoHeight() {
    return this.video.videoHeight || (this._index ? this._index.videoHeight : 0);
  }

  get duration() {
    // The index's duration is the sum of the real frame durations, which is
    // what VideoEngine reports; fall back to the element's own.
    if (this._index) return this._index.duration;
    return this.video.duration || 0;
  }

  // Normalized to the content timeline (display frame 0 at t = 0), so that
  // currentTime, duration, frameAtTime and seekToFrame mean exactly what they
  // mean on VideoEngine and a host can swap one engine for the other blindly.
  get currentTime() { return this.video.currentTime - this._timeOffset; }
  set currentTime(t) {
    const clamped = Math.max(0, Math.min(this.duration, t));
    this.video.currentTime = clamped + this._timeOffset;
  }

  // What this engine got, for dev labels and host-side diagnostics.
  get tier() {
    const index = this._index ? 'container index' : 'declared frame rate';
    const clock = this.hasPresentedFrameClock ? 'presented clock' : 'currentTime clock';
    return `native (${index}, ${clock})`;
  }
  // True only when frame indices come from the container's real timestamps.
  // With a declared frame rate they are exact for constant-frame-rate clips and
  // approximate otherwise, and a host that must not mislabel a frame (an
  // annotation tool, say) should check this and say so.
  get frameIndexIsExact() { return this._index !== null; }

  frameAtTime(t) {
    if (this._index) return this._index.frameAtTime(t);
    const n = Math.floor(t * this.framesPerSecond);
    return Math.max(0, Math.min(Math.max(0, this.numFrames - 1), n));
  }

  // Frame index + fraction, for a time on the *element's* timeline.
  _frameFloatAtVideoTime(videoSeconds) {
    if (this._index) {
      return this._index.frameFloatAtTime(videoSeconds - this._timeOffset);
    }
    return videoSeconds * this.framesPerSecond;
  }

  // The frame on screen, from its own presentation timestamp. Null until one has
  // been presented (or forever, without requestVideoFrameCallback). Integer and
  // exact with a container index; with a declared frame rate it is a float,
  // exact only if the clip really is constant-frame-rate.
  _presentedFrame() {
    if (this._presentedMediaTime === null) return null;
    const t = this._presentedMediaTime - this._timeOffset;
    return this._index
      ? this._index.frameOfPresentedTime(t)
      : t * this.framesPerSecond;
  }

  get currentFrameFloat() {
    // While paused, currentTime is exact and authoritative — a sub-frame seek
    // must land where it aimed. While playing, extrapolate from the last
    // presented frame instead (see the class comment).
    const smoothVideoTime = (this._presentedMediaTime === null || this.video.paused)
      ? this.video.currentTime
      : this._presentedMediaTime
        + (performance.now() - this._presentedAt) / 1000 * this.video.playbackRate;

    let frameFloat = this._frameFloatAtVideoTime(smoothVideoTime);

    const presented = this._presentedFrame();
    if (presented !== null) {
      // Clamp to the hold interval [P, P+1] of the frame actually on screen, so
      // the reported playhead can never run past the pixels — nor lag behind
      // them, which is what rescues the last frame of a clip: the element clamps
      // a seek there to its own duration, which can land a rounding error below
      // the frame's start, and only the presented frame says which frame that
      // really is.
      frameFloat = Math.max(presented, Math.min(presented + 1, frameFloat));
    }
    return Math.max(0, Math.min(Math.max(0, this.numFrames - 1), frameFloat));
  }

  get currentFrame() { return Math.floor(this.currentFrameFloat); }

  seekToFrame(n) {
    n = Math.max(0, Math.min(Math.max(0, this.numFrames - 1), n | 0));
    // Seek to the midpoint of the frame's display interval, not its start: the
    // start sits exactly on the boundary the browser rounds at, so aiming there
    // can land on frame n-1. With an index the interval is the frame's real
    // one; without, it is the constant-frame-rate approximation.
    const midpoint = this._index
      ? this._index.midpointOfFrame(n) + this._timeOffset
      : (n + 0.5) / this.framesPerSecond;
    this.video.currentTime = midpoint;
  }

  // Best effort: seek to frame n and wait until it is the frame on screen.
  // Unlike VideoEngine.ensureFrame there is no decoded bitmap to hand back —
  // a <video> element cannot give you a frame you can name — so this only
  // guarantees the element has settled on it.
  async ensureFrame(frameIndex) {
    this.seekToFrame(frameIndex);
    const startedAt = performance.now();
    while (this.currentFrame !== frameIndex) {
      await new Promise((resolve) => setTimeout(resolve, 8));
      if (performance.now() - startedAt > 5000) throw new Error('seek timed out');
    }
  }

  // Set the frame rate to map frames with when there is no container index
  // (a host that knows the clip's rate from elsewhere — a sidecar pose file,
  // say). Ignored when an index is present, which is strictly better.
  setFrameRate(framesPerSecond, numFrames) {
    if (this._index) return;
    this.framesPerSecond = framesPerSecond || 30;
    this.numFrames = numFrames
      || Math.round((this.video.duration || 0) * this.framesPerSecond);
  }

  // options.index: a ContainerIndex for this source. options.frameRate /
  // options.numFrames: the declared fallback mapping, used only when no index
  // is available.
  async load(source, options = {}) {
    this._teardown();
    this._startPresentedFrameClock();   // in case a previous destroy() stopped it
    try {
      this._index = options.index || null;
      if (this._index) {
        this.numFrames = this._index.numFrames;
        this.rotation = this._index.rotation;
        // An average rate, so that a host reading framesPerSecond gets a sane
        // number and so the declared mapping is usable if the index is later
        // rejected as inconsistent (see _checkPresentedFrame).
        this.framesPerSecond = this._index.duration
          ? this._index.numFrames / this._index.duration : 30;
      } else {
        this.framesPerSecond = options.frameRate || 30;
        this.numFrames = options.numFrames || 0;
        this.rotation = 0;
      }

      await this._loadElement(source);

      if (this._index && !this._indexDescribesElement()) this._index = null;

      if (this._index) {
        await this._calibrateTimeOffset();
      } else {
        if (options.frameRate) this.framesPerSecond = options.frameRate;
        this.numFrames = options.numFrames
          || Math.round(this.duration * this.framesPerSecond);
      }

      this.ready = true;
      this.dispatchEvent(new Event('loaded'));
    } catch (err) {
      console.error('NativeVideoEngine.load failed:', err);
      this._showError(err && err.message ? err.message : String(err));
      throw err;
    }
  }

  _loadElement(source) {
    const url = (typeof source === 'string')
      ? source : (this._objectUrl = URL.createObjectURL(source));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.video.removeEventListener('loadeddata', onLoaded);
        this.video.removeEventListener('error', onError);
      };
      const onLoaded = () => {
        cleanup();
        // Reassigning src resets playbackRate/loop to defaults; reapply.
        this.video.playbackRate = this._rate;
        this.video.loop = this._loop;
        resolve();
      };
      const onError = () => { cleanup(); reject(new Error('native <video> load failed')); };
      this.video.addEventListener('loadeddata', onLoaded);
      this.video.addEventListener('error', onError);
      this.video.src = url;
      this.video.load();
    });
  }

  // Does the sample table describe the same content the element will present?
  //
  // The calibration below anchors on "the first frame the element presents is
  // display frame 0 of the table". An edit list that trims into the middle of a
  // GOP breaks that: the samples before the trim point stay in the table (the
  // decoder needs them) but are never presented, so the first presented frame
  // is really frame k, and every index we report would be shifted by k. A
  // whole-frame shift is invisible to _checkPresentedFrame — a table shifted by
  // whole frames still has every mediaTime landing exactly on an entry — so it
  // has to be caught here or not at all.
  //
  // Durations are the tell. A shifting edit list (the common one: it
  // compensates for the composition offset B-frames introduce) leaves the
  // presented duration equal to the table's. A trimming one makes the element's
  // duration shorter by everything it cut, which is at least a GOP. Anything
  // beyond a couple of frames of container rounding, we do not trust the table.
  _indexDescribesElement() {
    const elementDuration = this.video.duration;
    if (!isFinite(elementDuration) || elementDuration <= 0) return true;
    const slack = 2 / this.framesPerSecond;
    if (Math.abs(this._index.duration - elementDuration) <= slack) return true;
    console.warn('NativeVideoEngine: the container\'s frame table spans '
      + `${this._index.duration.toFixed(3)}s but the element will present `
      + `${elementDuration.toFixed(3)}s, so the table describes frames the `
      + 'element never shows (a trimming edit list?). Falling back to the '
      + 'declared frame rate rather than report shifted frame numbers.');
    return false;
  }

  // Find the constant offset between the container index's timeline and the
  // element's own.
  //
  // The first frame the element presents after load is display frame 0, and
  // requestVideoFrameCallback reports its exact PTS on the element's timeline.
  // Our table puts frame 0 at t = 0 by construction, so that reported PTS *is*
  // the offset (it is nonzero when the container carries an edit list or a
  // nonzero start time). Anchoring on a frame whose identity we already know is
  // what makes this immune to whole-frame errors — a residual check alone
  // cannot catch those, because a table shifted by exactly one frame still has
  // every mediaTime landing precisely on an entry.
  async _calibrateTimeOffset() {
    const mediaTime = await this._nextPresentedMediaTime(2000);
    if (mediaTime === null) {
      // No presented frame to anchor on (no requestVideoFrameCallback, or it
      // never fired). The timelines coincide for ordinary clips, so assume they
      // do — but say so, because an edit list would now silently shift every
      // frame number.
      console.warn('NativeVideoEngine: no presented frame to calibrate the '
        + 'container timeline against; assuming it matches the element\'s.');
      this._timeOffset = 0;
      return;
    }
    this._timeOffset = mediaTime - this._index.presentationTimes[0];
  }

  // Resolves with the mediaTime of the next presented frame, or null if the
  // clock is unavailable or nothing presents within timeoutMilliseconds.
  _nextPresentedMediaTime(timeoutMilliseconds) {
    if (!this.hasPresentedFrameClock) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMilliseconds);
      this._presentWaiters.push(finish);
    });
  }

  _onPresentedFrame(now, metadata) {
    if (this._clockStopped) return;   // destroyed; stop the self-perpetuating loop
    this._presentedMediaTime = metadata.mediaTime;
    this._presentedAt = now;
    this._checkPresentedFrame();

    const waiters = this._presentWaiters;
    this._presentWaiters = [];
    for (const resolve of waiters) resolve(metadata.mediaTime);

    this.video.requestVideoFrameCallback(this._onPresentedFrame);
  }

  // A presented frame's mediaTime IS some frame's exact PTS, so once calibrated
  // it must land essentially on an entry of our table. Persistent misses mean
  // the table does not describe what the element is actually playing (a
  // different track, or a container we mis-parsed), and indexing from it would
  // report confidently wrong frame numbers — worse than admitting we are
  // guessing. Drop to the declared-frame-rate mapping instead.
  _checkPresentedFrame() {
    if (!this._index) return;
    const t = this._presentedMediaTime - this._timeOffset;
    const n = this._index.frameOfPresentedTime(t);
    const residual = Math.abs(t - this._index.presentationTimes[n]);
    const tolerance = 0.25 * (this._index.frameDurations[n] || 1 / this.framesPerSecond);
    if (residual <= tolerance) { this._indexStrikes = 0; return; }
    if (++this._indexStrikes < 5) return;   // tolerate a transient straggler
    console.warn('NativeVideoEngine: the container index disagrees with the '
      + 'frames the element is presenting; falling back to the declared frame '
      + 'rate. Frame indices are now exact only if the clip is '
      + 'constant-frame-rate.');
    this._index = null;
    this._timeOffset = 0;
  }

  update() {}          // the <video> element advances its own clock
  resizeCanvas() {}    // CSS object-fit handles letterboxing

  // Drop the element's decoded media and stop the presented-frame clock, rather
  // than wait for garbage collection. Like VideoEngine, the engine stays usable:
  // load() restarts both.
  destroy() {
    this._clockStopped = true;
    this._teardown();
    this.video.removeAttribute('src');
    this.video.load();
  }

  _teardown() {
    this.ready = false;
    try { this.video.pause(); } catch (e) { /* not loaded */ }
    if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
    // The previous clip's clock says nothing about the next one's.
    this._presentedMediaTime = null;
    this._presentedAt = 0;
    for (const resolve of this._presentWaiters) resolve(null);
    this._presentWaiters = [];
    this._index = null;
    this._timeOffset = 0;
    this._indexStrikes = 0;
    this._hideError();
  }

  _showError(message) {
    this.dispatchEvent(new CustomEvent('errormessage', { detail: { message } }));
  }
  _hideError() {
    this.dispatchEvent(new CustomEvent('errormessage', { detail: { message: null } }));
  }
}

// ==================================================================
// createBestEngine — walk the ladder and return a loaded engine.
//
// The container index is built once, up front, and handed to whichever engine
// ends up playing: it is what WebCodecs decodes from, and it is also what lifts
// the <video> path from an assumed frame rate to exact per-frame timestamps. So
// it is worth building even when WebCodecs is nowhere in sight, and it is never
// built twice.
//
//   createBestEngine(source, {canvas, video})  ->  VideoEngine | NativeVideoEngine
//
// The returned engine is loaded and ready. `engine.displayElement` is the one of
// the two elements the host should show; `engine.tier` says what it got, and
// `engine.frameIndexIsExact` whether frame numbers can be trusted absolutely.
// ==================================================================
async function createBestEngine(source, options = {}) {
  const {
    canvas = null,
    video = null,
    // 'auto' (default) tries WebCodecs first; 'native' skips it; 'webcodecs'
    // still falls back if WebCodecs cannot play the clip — there is no point
    // refusing to show a video the browser can play perfectly well.
    prefer = 'auto',
    declaredFrameRate = 0,
    declaredNumFrames = 0,
  } = options;

  let index = null;
  if (typeof MP4Box !== 'undefined') {
    try {
      index = await ContainerIndex.fromSource(source);
    } catch (err) {
      console.warn('exact-video-engine: could not index this container (not '
        + 'ISOBMFF?). The <video> element may still play it, but frame indices '
        + 'will come from the declared frame rate.', err);
    }
  }

  if (prefer !== 'native' && canvas && index && typeof VideoDecoder !== 'undefined') {
    const engine = new VideoEngine(canvas);
    try {
      await engine.load(source, { index });
      return engine;
    } catch (err) {
      // Container parsed but the codec will not decode here (an unsupported
      // profile, or a browser with a partial WebCodecs). The element may well
      // play it natively, and we keep the exact index either way.
      engine.destroy();
      console.warn('exact-video-engine: WebCodecs could not play this clip; '
        + 'falling back to the native <video> element.', err);
    }
  }

  if (!video) {
    throw new Error('createBestEngine: no <video> element supplied to fall back to');
  }
  const engine = new NativeVideoEngine(video);
  await engine.load(source, {
    index,
    frameRate: declaredFrameRate,
    numFrames: declaredNumFrames,
  });
  return engine;
}
