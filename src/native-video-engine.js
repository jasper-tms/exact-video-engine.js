import { ContainerIndex } from './container-index.js';
import { detectBrowserEngine } from './decode-support.js';

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
// 2. The container index, which is mandatory. `mediaTime` is an exact timestamp,
//    but turning a timestamp into a frame *index* needs the table of every
//    frame's PTS, which a <video> element never exposes. Given a ContainerIndex
//    we binary-search it and the index is exact on variable-frame-rate clips —
//    MP4 and WebM alike, which is the whole reason both are indexed. This engine
//    has no inexact mode to fall back to: load() requires both an index (built
//    here if the caller did not supply one) and the presented-frame clock, and
//    refuses the clip otherwise rather than report guessed frame numbers.
// ==================================================================
export class NativeVideoEngine extends EventTarget {
  constructor(videoElement) {
    super();
    this.video = videoElement;
    this.ready = false;
    this.numFrames = 0;
    this.rotation = 0;
    // Latched true if the runtime watcher later catches the index disagreeing
    // with the frames the element presents during playback (see
    // _checkPresentedFrame). Mirrors VideoEngine.failed: the API stays functional
    // but frameIndexIsExact goes false and a fatal errormessage fires.
    this.failed = false;

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
    // first frame presents. requestVideoFrameCallback is required (load() refuses
    // without it), so unlike VideoEngine there is no clockless mode here.
    this._presentedMediaTime = null;
    this._presentedAt = 0;
    this._presentWaiters = [];

    videoElement.muted = true;
    videoElement.playsInline = true;   // iOS: play inline, no auto-fullscreen
    videoElement.addEventListener('dblclick', (e) => e.preventDefault());

    // Reset the runtime index-vs-reality strike counter the instant a seek
    // begins: post-seek presented frames are not evidence against the table (see
    // _checkPresentedFrame). Registered once on the element so it cannot pile up
    // across load()s.
    videoElement.addEventListener('seeking', () => { this._indexStrikes = 0; });

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

  // What this engine got, for dev labels and host-side diagnostics. Always the
  // exact pairing now — the only native tier that exists.
  get tier() {
    return 'native (container index, presented clock)';
  }
  // Same contract as VideoEngine.codecString. Null when the index carries no
  // decoder configuration (WebM's does not).
  get codecString() {
    return (this._index && this._index.decoderConfig)
      ? this._index.decoderConfig.codec : null;
  }
  // Informational only, never a mapping input: the clip's average frame rate,
  // derived from the index (numFrames / duration). A host may show it; frame
  // indices come from the index's real per-frame timestamps, not from this.
  // Zero when the index is unavailable or reports no duration.
  get framesPerSecond() {
    if (!this._index || !this._index.duration) return 0;
    return this._index.numFrames / this._index.duration;
  }

  // Average frame duration in seconds, for slack/tolerance computations that need
  // a per-frame scale. Derived straight from the index and guarded against a zero
  // frame count so tolerances never blow up to Infinity.
  _averageFrameDuration() {
    if (!this._index || !this._index.numFrames) return 0;
    return this._index.duration / this._index.numFrames;
  }

  // The permanent invariant guard. True for every engine createBestEngine hands
  // back — it never returns an unindexed native engine. Goes false only if the
  // runtime watcher later catches the index disagreeing with the frames the
  // element actually presents during playback (see _checkPresentedFrame), which
  // also latches `failed` and fires a fatal errormessage.
  get frameIndexIsExact() { return this._index !== null && !this.failed; }

  frameAtTime(t) {
    return this._index.frameAtTime(t);
  }

  // Frame index + fraction, for a time on the *element's* timeline.
  _frameFloatAtVideoTime(videoSeconds) {
    return this._index.frameFloatAtTime(videoSeconds - this._timeOffset);
  }

  // The frame on screen, from its own presentation timestamp. Null until one has
  // been presented. Integer and exact, read from the container index.
  _presentedFrame() {
    if (this._presentedMediaTime === null) return null;
    const t = this._presentedMediaTime - this._timeOffset;
    return this._index.frameOfPresentedTime(t);
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
    // can land on frame n-1. The interval is the frame's real one, from the index.
    const midpoint = this._index.midpointOfFrame(n) + this._timeOffset;
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

  // options.index: a ContainerIndex already built for this source (createBestEngine
  // builds one up front and hands the same one to whichever engine plays, so the
  // container is never parsed twice). Omit it and the engine builds its own. The
  // index is mandatory: this engine has no inexact mode without it. The import of
  // ContainerIndex is safe because the shipped bundle orders container-index
  // before this file (mirroring VideoEngine.load).
  async load(source, options = {}) {
    this._teardown();
    this._startPresentedFrameClock();   // in case a previous destroy() stopped it
    // Enforce item 1b's invariant at the engine level too, since a host can
    // construct a NativeVideoEngine directly rather than through createBestEngine.
    // Without requestVideoFrameCallback there is no exact presented-frame clock to
    // tell us which frame is on screen, and this engine no longer has any inexact
    // mapping to fall back to — so refuse rather than play inexactly.
    if (!this.hasPresentedFrameClock) {
      throw new Error('NativeVideoEngine: this browser lacks requestVideoFrameCallback, '
        + 'so there is no exact presented-frame clock and no inexact mode to fall back '
        + 'to. Use a current browser (Safari 15.4+, Firefox 132+, or any recent '
        + 'Chromium).');
    }
    try {
      this._index = options.index || await ContainerIndex.fromSource(source);
      this.numFrames = this._index.numFrames;
      this.rotation = this._index.rotation;

      // Gecko does not honor a trimming edit list: it presents the untrimmed
      // frames while reporting the trimmed duration, so the element shows frame
      // k where the table (and every other browser) shows frame k + trim. That
      // is a whole-frame shift, which no residual or duration check can see —
      // the shifted timestamps still land exactly on table entries — so it must
      // be refused up front, the same way the WebKit reachability guard below
      // refuses that browser's inconsistent trimmed timeline. The WebCodecs path
      // decodes the trim itself and plays it frame-exact on Firefox, so the auto
      // ladder still plays these clips there; only the native fallback refuses.
      if (this._index.trimmedByEditList && detectBrowserEngine() === 'gecko') {
        throw new Error('NativeVideoEngine: this browser (Gecko) presents a clip '
          + 'with a trimming edit list untrimmed, shifting every frame relative to '
          + 'the container\'s presentation window, so exact frame numbers are '
          + 'impossible on the native path. The clip is refused here rather than '
          + 'mislabeled; the WebCodecs path plays the trim frame-exact.');
      }

      await this._loadElement(source);

      // The container's frame table must describe the same content the element
      // presents; a trimming edit list makes it describe frames the element never
      // shows, which would shift every reported index. Refuse if so — but only
      // after the element's duration has settled (see the race handling inside).
      if (!(await this._indexDescribesElement())) {
        throw new Error('NativeVideoEngine: the container\'s frame table does not '
          + 'describe what this element presents — the element\'s duration is '
          + 'shorter, the signature of a trimming edit list that cuts frames the '
          + 'decoder still needs but never shows. Reporting frame numbers from the '
          + 'table would shift every index, so the clip is refused rather than '
          + 'played with wrong frame numbers.');
      }

      await this._calibrateTimeOffset();
      // WebKit runs currentTime on the MEDIA timeline for a trimming edit list (so
      // the calibrated offset is the trim) but reports the shorter EDITED duration,
      // which leaves the late frames past the end and unreachable — a seek to them
      // clamps. Trusting the index then would report exact frame numbers for frames
      // the element can never show, so refuse rather than be confidently wrong.
      // (Chromium keeps currentTime and duration on the same timeline, so this
      // never fires there and its trimmed clips play fine.)
      if (!this._calibratedTimelineReachable()) {
        throw new Error('NativeVideoEngine: the calibrated container timeline runs '
          + 'past what this element will seek to (an edit-list clip whose currentTime '
          + 'and duration disagree, seen on WebKit), so its late frames are '
          + 'unreachable. The clip is refused rather than played with frame numbers '
          + 'the element cannot reach.');
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
  //
  // Async, and it rides out a known Chromium race before believing a
  // disagreement: right after 'loadeddata', video.duration for an edit-list clip
  // is transiently the (shorter) MEDIA duration and only later updates to the
  // longer edit-list-extended value (see the long note in
  // test/frame-index-test.mjs around MAX_ATTEMPTS). Under the old design this
  // race caused an occasional silent drop to the declared rate; now that a
  // disagreement is fatal, believing the transient would instead spuriously
  // REFUSE a perfectly good clip, which is unacceptable. So on an initial
  // disagreement we wait for the element's duration to settle and re-check,
  // throwing only if it still disagrees.
  async _indexDescribesElement() {
    const agrees = () => {
      const elementDuration = this.video.duration;
      if (!isFinite(elementDuration) || elementDuration <= 0) return true;
      const slack = 2 * this._averageFrameDuration();
      return Math.abs(this._index.duration - elementDuration) <= slack;
    };
    if (agrees()) return true;
    await this._waitForDurationToSettle(700);
    if (agrees()) return true;
    console.warn('NativeVideoEngine: the container\'s frame table spans '
      + `${this._index.duration.toFixed(3)}s but the element presents `
      + `${(this.video.duration || 0).toFixed(3)}s even after its duration `
      + 'settled, so the table describes frames the element never shows (a '
      + 'trimming edit list?).');
    return false;
  }

  // Wait until the element's reported duration stops changing, up to a timeout.
  // Resolves on the first 'durationchange' after now, or when a short poll sees
  // the value change, or on timeout — whichever comes first. Used only to ride
  // out the Chromium edit-list duration race above before judging agreement.
  _waitForDurationToSettle(timeoutMilliseconds) {
    return new Promise((resolve) => {
      const startDuration = this.video.duration;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.video.removeEventListener('durationchange', onChange);
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      };
      const onChange = () => finish();
      const poll = setInterval(() => {
        if (this.video.duration !== startDuration) finish();
      }, 50);
      const timer = setTimeout(finish, timeoutMilliseconds);
      this.video.addEventListener('durationchange', onChange);
    });
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
    const slack = 1.5 * this._averageFrameDuration();
    return this._timeOffset + lastFrameStart <= elementDuration + slack;
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
      // The presented-frame clock exists (load() refuses without it) but no frame
      // presented within the timeout — a transient, not a missing feature: an
      // autoplay-blocked or not-yet-painting element. The timelines coincide for
      // ordinary clips, so assume a zero offset, but say so, because an edit list
      // would then silently shift every frame number.
      console.warn('NativeVideoEngine: no presented frame within the calibration '
        + 'timeout; assuming the container timeline matches the element\'s. If this '
        + 'clip carries an edit list, frame numbers may be shifted until a frame '
        + 'presents.');
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
  // it must land essentially on an entry of our table. Persistent misses DURING
  // PLAYBACK mean the table does not describe what the element is actually
  // presenting (a different track, or a container we mis-parsed), and indexing
  // from it would report confidently wrong frame numbers.
  //
  // Only playback frames count. We skip while the element is paused or seeking,
  // and the constructor's 'seeking' listener resets the strike counter, because
  // after a programmatic seek Firefox's requestVideoFrameCallback echoes the seek
  // TARGET rather than the presented frame's true presentation timestamp — so a
  // post-seek readback is not evidence against the table. During real playback
  // mediaTime is exact on every engine, so a sustained miss there is real. (This
  // deliberately replaces the old behavior, where Firefox's post-seek echoes
  // could deterministically knock out the index.)
  //
  // There is no fallback mapping to drop to anymore, so on strike-out we do NOT
  // null the index: we keep it in place so the API stays functional and let the
  // host decide what to do. Instead we latch `failed` (which turns
  // frameIndexIsExact false, mirroring VideoEngine) and fire a fatal errormessage.
  _checkPresentedFrame() {
    if (!this._index || this.failed) return;
    if (this.video.paused || this.video.seeking) return;
    const t = this._presentedMediaTime - this._timeOffset;
    const n = this._index.frameOfPresentedTime(t);
    const residual = Math.abs(t - this._index.presentationTimes[n]);
    const tolerance = 0.25
      * (this._index.frameDurations[n] || this._averageFrameDuration() || 1);
    if (residual <= tolerance) { this._indexStrikes = 0; return; }
    if (++this._indexStrikes < 5) return;   // tolerate a transient straggler
    this.failed = true;
    const message = 'This video\'s container index disagrees with the frames the '
      + 'element is presenting during playback, so its reported frame numbers can '
      + 'no longer be trusted.';
    console.warn('NativeVideoEngine: ' + message);
    this.dispatchEvent(new CustomEvent('errormessage', { detail: {
      message,
      fatal: true,
      inexact: true,
    } }));
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
    this.failed = false;
    this._hideError();
  }

  _showError(message) {
    this.dispatchEvent(new CustomEvent('errormessage', { detail: { message } }));
  }
  _hideError() {
    this.dispatchEvent(new CustomEvent('errormessage', { detail: { message: null } }));
  }
}

