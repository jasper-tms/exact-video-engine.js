import { buildDeclaredRateProbePlan, predictedFrameCount, isPresentedTimeOnGrid, declaredRateTolerance } from './frame-rate-check.js';

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
//    we binary-search it and the index is exact on variable-frame-rate clips —
//    MP4 and WebM alike, which is the whole reason both are indexed. Without one
//    (a container we cannot read at all, or a WebM whose indexing pass ran out
//    of time) we fall back to `mediaTime * framesPerSecond`, which is exact only
//    if the clip really is constant-frame-rate.
// ==================================================================
export class NativeVideoEngine extends EventTarget {
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

    // Declared-frame-rate verification (only when there is no index and a rate
    // was supplied — see load()'s verifyDeclaredRate). The anchor is the first
    // frame's real timestamp, against which the k/rate grid is measured; strikes
    // count consecutive presented frames that miss it during playback; _probing
    // suppresses the runtime watcher while the load-time seek-probe drives its own
    // seeks; _frameMappingInexact latches once playback disproves the rate.
    this._verifyDeclaredRateEnabled = false;
    this._declaredAnchor = null;
    this._declaredStrikes = 0;
    this._probing = false;
    this._probeResolver = null;
    this._frameMappingInexact = false;

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
  // Same contract as VideoEngine.codecString. Null when no index is available
  // or the index carries no decoder configuration (WebM's does not).
  get codecString() {
    return (this._index && this._index.decoderConfig)
      ? this._index.decoderConfig.codec : null;
  }
  // True only when frame indices come from the container's real timestamps.
  // With a declared frame rate they are exact for constant-frame-rate clips and
  // approximate otherwise, and a host that must not mislabel a frame (an
  // annotation tool, say) should check this and say so. Never promoted on the
  // strength of the declared-rate probe: sampling can disprove constant frame
  // rate but cannot prove it (see frame-rate-check.js), so the honest answer for
  // a declared-rate clip stays false.
  get frameIndexIsExact() { return this._index !== null; }

  // True once a declared-frame-rate clip is caught mid-playback presenting frames
  // that no longer sit on the declared grid — i.e. the rate the host supplied is
  // wrong and the frame numbers this engine reports are unreliable. Stays false
  // for indexed clips (their numbers come from real timestamps) and for a
  // declared-rate clip whose timestamps have so far stayed on the grid. A host
  // can poll this or listen for the fatal 'errormessage' (detail.inexact) it is
  // set alongside.
  get frameMappingInexact() { return this._frameMappingInexact; }

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
        // The calibrated offset can push the table past the range the element
        // will actually seek to. WebKit runs currentTime on the MEDIA timeline
        // for a trimming edit list (so the offset it calibrates is the trim) but
        // reports the shorter EDITED duration, which leaves the late frames
        // unreachable — a seek to them clamps. Trusting the index then would hand
        // back exact frame numbers for frames the element can never show. Drop to
        // the declared rate, which is honestly approximate rather than confidently
        // wrong. (Chromium keeps currentTime and duration on the same timeline, so
        // this never fires there and its trimmed clips stay frame-exact.)
        if (this._index && !this._calibratedTimelineReachable()) {
          console.warn('NativeVideoEngine: the calibrated container timeline runs '
            + 'past what this element will seek to (an edit-list clip whose '
            + 'currentTime and duration disagree, seen on WebKit). Falling back to '
            + 'the declared frame rate rather than report frame numbers the element '
            + 'cannot reach.');
          this._index = null;
          this._timeOffset = 0;
        }
      }
      if (!this._index) {
        if (options.frameRate) this.framesPerSecond = options.frameRate;
        this.numFrames = options.numFrames
          || Math.round(this.duration * this.framesPerSecond);
        // No container index means frames are mapped from the declared rate,
        // which is exact only if the clip really is constant-frame-rate at that
        // rate. Verify it against the real presented timestamps before handing
        // back an engine that would otherwise report guessed frame numbers
        // silently: a disproven rate throws out of load() (createBestEngine turns
        // that into a clear bail), and a rate that survives the probe is then
        // policed for the rest of playback by _checkDeclaredRate.
        //
        // Gate on options.frameRate, not framesPerSecond: the probe verifies a
        // rate the HOST asserted. An index dropped mid-load (a trimming edit list
        // the element mis-times, a WebM whose scan fell short) leaves framesPerSecond
        // set to the index's own average, but the host never claimed that as a
        // constant rate — so there is nothing of theirs to verify or bail on, and
        // the pre-existing honest-approximate fallback stands.
        if (options.verifyDeclaredRate && options.frameRate > 0) {
          await this._verifyDeclaredFrameRate();
          this._verifyDeclaredRateEnabled = true;
        }
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

  // Does the calibrated timeline stay within the range the element will seek to?
  //
  // Calibration anchors the first presented frame; this checks the far end. The
  // last frame's presentation time, shifted by the offset, must be a currentTime
  // the element can actually reach — i.e. within its duration. It usually is (the
  // offset is zero or the duration accommodates it), but a trimming edit list on
  // WebKit breaks the assumption: WebKit puts currentTime on the media timeline
  // (nonzero offset) yet reports the shorter edited duration, so the tail frames
  // sit past the end and clamp. A generous slack keeps the ordinary last-frame
  // rounding (which the presented-frame clamp already rescues) from tripping it.
  _calibratedTimelineReachable() {
    const elementDuration = this.video.duration;
    if (!isFinite(elementDuration) || elementDuration <= 0) return true;
    const n = this._index.numFrames;
    if (!n) return true;
    const lastFrameStart = this._index.presentationTimes[n - 1];
    const slack = 1.5 / this.framesPerSecond;
    return this._timeOffset + lastFrameStart <= elementDuration + slack;
  }

  // Whether the element can be seeked at all. A live stream or a container the
  // browser cannot random-access cannot be probed; seekable stays empty until the
  // element knows, so an empty range means "cannot verify", not "seekable to 0".
  _elementIsSeekable() {
    const ranges = this.video.seekable;
    if (!ranges || ranges.length === 0) return false;
    try { return ranges.end(ranges.length - 1) > ranges.start(0); }
    catch (e) { return false; }
  }

  // Try to disprove a declared constant frame rate against the clip's real frame
  // timestamps, on our own timeline (paused seeks, no playthrough — seek latency
  // is bounded by group-of-pictures length, not clip duration). Seeks to the
  // points frame-rate-check plans and requires each landed timestamp to sit on the
  // k/rate grid; a single miss beyond tolerance means the rate is wrong or the
  // clip is variable, and we throw rather than hand back guessed frame numbers.
  //
  // Returns without throwing where we simply cannot check — no presented-frame
  // clock, an unseekable source, or no frame to anchor on — because the host
  // explicitly accepted declared-rate mapping by supplying a rate; we add a safety
  // net where one is possible and never make that opted-into case worse.
  async _verifyDeclaredFrameRate() {
    if (!this.hasPresentedFrameClock) {
      console.warn('NativeVideoEngine: cannot verify the declared frame rate — this '
        + 'browser has no requestVideoFrameCallback, so there are no frame timestamps '
        + 'to check. Frame numbers are exact only if the clip is constant-frame-rate.');
      return;
    }
    if (!this._elementIsSeekable()) {
      console.warn('NativeVideoEngine: cannot verify the declared frame rate — the '
        + 'source is not seekable. Frame numbers are exact only if the clip is '
        + 'constant-frame-rate.');
      return;
    }
    const anchor = await this._nextPresentedMediaTime(2000);
    if (anchor === null) {
      console.warn('NativeVideoEngine: cannot verify the declared frame rate — no frame '
        + 'was presented to anchor on. Frame numbers are exact only if the clip is '
        + 'constant-frame-rate.');
      return;
    }
    this._declaredAnchor = anchor;

    const rate = this.framesPerSecond;
    const duration = this.video.duration;
    const frames = predictedFrameCount(
      (isFinite(duration) && duration > 0) ? duration : (this.numFrames / rate) || 1, rate);
    const plan = buildDeclaredRateProbePlan(rate, frames);
    const tolerance = declaredRateTolerance(rate);

    this._probing = true;
    let disproof = null;
    try {
      // Calibrate the signal before trusting it. Seek to a point safely inside
      // frame 0 (0.4 of a frame in — still frame 0 for any true rate up to ~2.5x
      // the declared one) and check the reported timestamp is frame 0's, i.e. the
      // anchor. A browser that reports a seeked frame's real presentation timestamp
      // (Chromium, WebKit) returns the anchor; Firefox instead ECHOES the time we
      // seeked to, which would make every probe look like a disproof. When the
      // timestamps are unreadable this way we cannot verify — so proceed with the
      // declared rate honestly rather than bail on a signal known to be unreliable
      // (the same clock imprecision that makes Firefox drop the container index).
      const calibrated = await this._seekAndReadPresentedTime(anchor + 0.4 / rate);
      if (calibrated === null || Math.abs(calibrated - anchor) > tolerance) {
        console.warn('NativeVideoEngine: cannot verify the declared frame rate — this '
          + "browser's requestVideoFrameCallback does not report a seeked frame's "
          + 'presentation timestamp (it echoes the seek target), so the real frame '
          + 'timestamps are unreadable. Frame numbers are exact only if the clip is '
          + 'constant-frame-rate.');
        this._declaredAnchor = null;   // the same clock drives the runtime watcher; leave it off too
        return;
      }
      for (const step of plan) {
        const landed = await this._seekAndReadPresentedTime(anchor + step.seekOffsetSeconds);
        if (landed === null) continue;   // inconclusive seek; do not hold it against the rate
        const residual = Math.abs((landed - anchor) - step.expectedTimeSeconds);
        if (residual > tolerance) { disproof = { step, landed, residual }; break; }
      }
    } finally {
      this._probing = false;
      // Leave the element on its first frame so the host starts from a clean state.
      try { this.video.currentTime = anchor; } catch (e) { /* seek back not available */ }
    }

    if (disproof) {
      const { step, landed, residual } = disproof;
      this._frameMappingInexact = true;
      throw new Error(
        `declared frame rate ${rate} fps is inconsistent with this video's real frame `
        + `timestamps: seeking to ${(anchor + step.seekOffsetSeconds).toFixed(4)}s presented a `
        + `frame at ${landed.toFixed(4)}s, but a ${rate} fps clip would present frame `
        + `${step.expectedFrameIndex} at ${(anchor + step.expectedTimeSeconds).toFixed(4)}s `
        + `(off by ${(residual * 1000).toFixed(1)} ms). The clip is variable-frame-rate or the `
        + 'declared rate is wrong, so frame numbers cannot be trusted. Pass '
        + 'allowApproximate: true to play it anyway without frame accuracy.');
    }
  }

  // Seek the paused element to a time and resolve with the timestamp of the frame
  // that ends up on screen — or null if the seek could not be read. Registers the
  // one-shot resolver BEFORE moving the playhead so it cannot miss the repaint,
  // and treats "seek settled but no new frame painted within a grace window" (the
  // same frame still covers the target — exactly what two probes inside one frame
  // should see) as the frame already on screen rather than a failure.
  _seekAndReadPresentedTime(target, timeoutMs = 3000, graceMs = 150) {
    const before = this._presentedMediaTime;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        this._probeResolver = null;
        this.video.removeEventListener('seeked', onSeeked);
        clearTimeout(overall);
        resolve(value);
      };
      // A repaint after the seek resolves with the new frame's timestamp.
      this._probeResolver = (mediaTime) => finish(mediaTime);
      // The seek completing with no repaint within a short grace means the same
      // frame still covers the target; report the frame already on screen.
      const onSeeked = () => setTimeout(() => finish(before), graceMs);
      this.video.addEventListener('seeked', onSeeked);
      // A seek that never settles (an unseekable region) is inconclusive.
      const overall = setTimeout(() => finish(null), timeoutMs);
      try { this.video.currentTime = target; }
      catch (e) { finish(null); }
    });
  }

  // The declared-rate sibling of _checkPresentedFrame: for a clip mapped from a
  // declared rate, each presented frame's timestamp must sit on the k/rate grid.
  // Sustained misses mean the rate is wrong — the clip changed rate partway, or
  // the load-time probe's samples happened to miss the irregularity — so latch the
  // inexact flag and emit a fatal errormessage the host can bail on. Suppressed
  // while the load-time probe is driving its own seeks.
  _checkDeclaredRate() {
    if (this._index || this._probing || !this._verifyDeclaredRateEnabled) return;
    if (this._frameMappingInexact) return;   // already reported
    if (this._declaredAnchor === null || this._presentedMediaTime === null) return;
    const rate = this.framesPerSecond;
    const { onGrid, residual } = isPresentedTimeOnGrid(
      this._presentedMediaTime - this._declaredAnchor, rate);
    if (onGrid) { this._declaredStrikes = 0; return; }
    if (++this._declaredStrikes < 5) return;   // tolerate a transient straggler
    this._frameMappingInexact = true;
    console.warn('NativeVideoEngine: presented frames no longer sit on the declared '
      + `${rate} fps grid (off by ${(residual * 1000).toFixed(1)} ms); the clip is not `
      + 'constant-frame-rate at that rate, so frame numbers are unreliable.');
    this.dispatchEvent(new CustomEvent('errormessage', { detail: {
      message: 'This video is not constant-frame-rate at the declared rate; '
        + 'frame numbers are unreliable.',
      fatal: true,
      inexact: true,
      declaredFrameRate: rate,
    } }));
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

    // The load-time seek-probe, if one is waiting, takes this frame first.
    if (this._probeResolver) {
      const resolveProbe = this._probeResolver;
      this._probeResolver = null;
      resolveProbe(metadata.mediaTime);
    }

    this._checkPresentedFrame();
    this._checkDeclaredRate();

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
    this._verifyDeclaredRateEnabled = false;
    this._declaredAnchor = null;
    this._declaredStrikes = 0;
    this._probing = false;
    this._probeResolver = null;
    this._frameMappingInexact = false;
    this._hideError();
  }

  _showError(message) {
    this.dispatchEvent(new CustomEvent('errormessage', { detail: { message } }));
  }
  _hideError() {
    this.dispatchEvent(new CustomEvent('errormessage', { detail: { message: null } }));
  }
}

