// ==================================================================
// exact-video-engine.js — a frame-perfect WebCodecs video player for the browser.
// https://github.com/jasper-tms/exact-video-engine.js
//
// Why this exists: a native <video> playing via play() stochastically drops a
// frame near the start (Chrome's compositor swallows ~one inter-frame interval
// as the media clock spins up) and its currentTime->frame mapping drifts on
// non-integer / variable-frame-rate clips. Here we demux the container with
// mp4box.js, decode every frame ourselves with a WebCodecs VideoDecoder, and
// present frames onto a canvas on a clock we own. Nothing hands the stream to
// a compositor, so no startup frame is dropped; and because the host reads the
// playhead from the same engine that paints the pixels, anything it renders in
// sync with the video (a 3D overlay, an annotation layer) cannot drift from
// the frame actually on screen. The integer frame index is the source of
// truth throughout: per-frame presentation timestamps come from the container
// (B-frame safe, VFR safe), never from an assumed constant fps.
//
// Decode is windowed by GOP (group of pictures: a keyframe plus the frames
// that depend on it). To show a frame we decode just its GOP, cache the
// results as ImageBitmaps, and evict distant GOPs, so memory stays flat
// regardless of clip length (handles multi-minute clips).
//
// Classic (non-module) script defining three globals — UrlRangeReader,
// FileRangeReader, and VideoEngine — so both module and non-module host pages
// can use it. Requires mp4box.js (the `MP4Box` / `DataStream` globals) to be
// loaded first.
//
// The engine never touches the host page's DOM beyond the canvas it is given.
// Errors surface as an 'errormessage' CustomEvent on the engine whose
// detail.message is a human-readable string, or null when a previous error
// should be cleared; the host owns rendering (and translating) that message.
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

    this._reader = null;
    this._videoDecoder = null;
    this._decoderConfig = null;
    this._timescale = 1;

    // Upright display geometry, set by _demux: the track's rotation metadata
    // (0/90/180/270) and the dimensions consumers should letterbox and
    // annotate against (coded axes swapped when rotation is 90/270).
    this.rotation = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;

    // Decode-order sample table (from the container's moov; no frame bytes):
    // each entry is {offset, size, isSync, cts, duration}.
    this._samples = null;
    this._keyframeDecodeIndices = null;   // sorted decode indices of sync samples
    this._presentationTimes = null;   // Float64Array, display order, seconds
    this._frameDurations = null;      // Float64Array, display order, seconds
    this._displayToDecode = null;     // Int32Array, displayIndex -> decode index
    this._microsToDisplay = null;     // Map<chunkTimestampMicros, displayIndex>

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

  // Largest display frame whose presentation time is <= t (binary search over
  // the real per-frame PTS table — no fps assumption, so CFR and VFR alike).
  frameAtTime(t) {
    const pts = this._presentationTimes;
    if (!pts || !pts.length) return 0;
    let lo = 0, hi = pts.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  get currentFrame() { return this.frameAtTime(this.playhead); }

  // Continuous playhead in frame units (frame index + fraction through that
  // frame's display interval) — what a host should drive any frame-indexed
  // display it renders in sync with the video (interpolated overlays etc.)
  // from, in place of the drift-prone `currentTime * fps`.
  get currentFrameFloat() {
    const pts = this._presentationTimes;
    if (!pts || !pts.length) return 0;
    const n = this.frameAtTime(this.playhead);
    const start = pts[n];
    const end = (n + 1 < pts.length) ? pts[n + 1] : start + this._frameDurations[n];
    const span = end - start;
    const frac = span > 0 ? (this.playhead - start) / span : 0;
    return n + Math.max(0, Math.min(1, frac));
  }

  get currentTime() { return this.playhead; }
  set currentTime(t) { this.playhead = Math.max(0, Math.min(this.duration, t)); }

  // Land the playhead exactly on the start of display frame n. Because we own
  // frameAtTime there is no browser seek-rounding to dodge, so we use pts[n]
  // directly (no midpoint trick): frameAtTime(pts[n]) === n exactly.
  seekToFrame(n) {
    if (!this._presentationTimes) return;
    n = Math.max(0, Math.min(this.numFrames - 1, n | 0));
    this.playhead = this._presentationTimes[n];
  }

  play() { if (this.ready && !this.playing) { this.playing = true; this._lastNow = 0; } }
  pause() { this.playing = false; }

  async load(source) {
    // source is a string (server filename/URL) or a File (browsed local clip).
    this._teardown();
    try {
      const reader = (typeof source === 'string')
        ? new UrlRangeReader(source) : new FileRangeReader(source);
      await reader.init();
      this._reader = reader;
      await this._demux(reader);
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

  // ---- demux (mp4box) -----------------------------------------------------
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

    this._decoderConfig = {
      codec: videoTrack.codec,
      codedWidth: videoTrack.video.width,
      codedHeight: videoTrack.video.height,
      description: this._codecDescription(file, videoTrack.id),
      optimizeForLatency: true,   // emit frames promptly; less internal buffering
    };

    // Display geometry. Phone clips are commonly coded landscape with a 90°
    // track rotation matrix; a <video> tag applies it but VideoDecoder does
    // not, so presentation (and any consumer annotating over the video) must.
    // videoWidth/videoHeight are the upright *display* dimensions — axes
    // swapped relative to the coded frame when rotation is 90/270.
    this.rotation = this._trackRotation(videoTrack);
    const swapAxes = this.rotation === 90 || this.rotation === 270;
    this.videoWidth = swapAxes ? videoTrack.video.height : videoTrack.video.width;
    this.videoHeight = swapAxes ? videoTrack.video.width : videoTrack.video.height;

    const support = await VideoDecoder.isConfigSupported(this._decoderConfig);
    if (!support.supported) throw new Error('codec not supported: ' + videoTrack.codec);

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
    this._timescale = n ? samples[0].timescale : 1;

    // Decode-order records (the first sample is always a keyframe).
    this._samples = new Array(n);
    const keyframes = [];
    for (let k = 0; k < n; k++) {
      const s = samples[k];
      const isSync = !!s.is_sync || k === 0;
      if (isSync) keyframes.push(k);
      this._samples[k] = {
        offset: s.offset, size: s.size, isSync, cts: s.cts, duration: s.duration,
      };
    }
    this._keyframeDecodeIndices = keyframes;   // ascending == decode order

    // Display order = samples sorted by composition time (B-frame safe).
    const order = Array.from({ length: n }, (_, k) => k);
    order.sort((a, b) => this._samples[a].cts - this._samples[b].cts);
    const cts0 = n ? this._samples[order[0]].cts : 0;
    this._presentationTimes = new Float64Array(n);
    this._frameDurations = new Float64Array(n);
    this._displayToDecode = new Int32Array(n);
    this._microsToDisplay = new Map();
    for (let d = 0; d < n; d++) {
      const k = order[d];
      const s = this._samples[k];
      this._presentationTimes[d] = (s.cts - cts0) / this._timescale;
      this._frameDurations[d] = s.duration / this._timescale;
      this._displayToDecode[d] = k;
      this._microsToDisplay.set(Math.round(s.cts * 1e6 / this._timescale), d);
    }
    this.numFrames = n;
    this.duration = n
      ? this._presentationTimes[n - 1] + this._frameDurations[n - 1] : 0;
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
  // relative, not absolute pixels.
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
