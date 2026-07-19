// ==================================================================
// frame-rate-check — verify a declared constant frame rate against the video's
// real frame timestamps, so a clip we could not index never SILENTLY plays with
// guessed frame numbers.
//
// When a container cannot be indexed (not MP4/MOV, not WebM/MKV — Ogg, HLS, and
// anything else), the native <video> engine has no per-frame timestamp table and
// falls back to mapping frames as `mediaTime * declaredFrameRate`. That mapping
// is exact only if the clip really is constant-frame-rate at exactly that rate,
// and nothing so far checked whether it is. This module is that check.
//
// The tool is `requestVideoFrameCallback`, whose `mediaTime` is the EXACT
// presentation timestamp of the frame on screen. Seeking a paused element to a
// chosen time and reading the landed mediaTime lets us sample the real timestamp
// lattice on our own timeline (seek latency is bounded by group-of-pictures
// length, not clip duration — so this costs the same on a 10-second or a 2-hour
// clip), and a truly constant-frame-rate clip has every frame k at time
// anchor + k/rate. Two failure modes matter and the probe plan below targets
// both:
//
//   * a WRONG or DRIFTING rate (e.g. 30 declared for a 29.97 clip, or a variable
//     clip that skips a frame): any dropped or extra frame shifts every LATER
//     frame by a whole slot permanently, so the residual grows toward the end of
//     the clip. Sampling spread across the clip — and decisively at the last
//     slot — catches an integer frame-count mismatch a near-the-start sample
//     would miss.
//   * a HIGHER true rate (60 declared as 30, telecine): every declared grid
//     point still sits on a real frame, so the intruders hide exactly BETWEEN
//     the points a single midpoint probe would check. Sampling two points INSIDE
//     one predicted frame's interval and requiring both to resolve to the same
//     frame flushes them out.
//
// This is falsification, not proof: passing every probe cannot prove constant
// frame rate (a pathological rate hiding entirely between the sample points
// survives — only decoding every frame proves it), but it disproves the
// realistic wrong-rate, dropped-frame, and doubled-rate cases. The engine treats
// a pass as "not disproven, proceed" and never upgrades frameIndexIsExact on the
// strength of it.
// ==================================================================

// The tolerance, in seconds, within which a presented timestamp must sit on the
// declared-rate grid to count as on it. A quarter of a frame: tight enough that a
// whole-frame mislabel (the thing we are guarding against) always exceeds it,
// loose enough to absorb the container's sub-millisecond timestamp rounding.
export function declaredRateTolerance(rate) {
  return 0.25 / rate;
}

// How many frames a clip of this many seconds holds at this rate — the frame
// count the declared-rate mapping implies, used to place the spread probe points
// (and, at the last slot, to catch a clip that holds fewer frames than its
// duration-times-rate would suggest).
export function predictedFrameCount(durationSeconds, rate) {
  if (!(rate > 0) || !(durationSeconds > 0)) return 1;
  return Math.max(1, Math.round(durationSeconds * rate));
}

// The seek plan: where to seek (in seconds from the first frame's timestamp) and
// which frame a constant-rate clip must present there. Each step is
// { frameUnits, seekOffsetSeconds, expectedFrameIndex, expectedTimeSeconds };
// the engine seeks to anchor + seekOffsetSeconds, reads the landed mediaTime, and
// requires |landed - anchor - expectedTimeSeconds| <= declaredRateTolerance.
//
// `frameUnits` is the seek position measured in declared-frame widths; the
// expected frame is floor(frameUnits), so two sub-frame points in the same
// interval (0.33 and 0.66) share an expected frame and disagree only if a hidden
// higher-rate boundary splits them.
export function buildDeclaredRateProbePlan(rate, predictedFrames) {
  if (!(rate > 0)) return [];
  const frameDuration = 1 / rate;
  const lastFrame = Math.max(0, (predictedFrames | 0) - 1);
  const points = new Set();

  // Inside the first frame: catches a doubled/telecined rate whose extra frame
  // boundary falls between these two points (a single midpoint would miss it).
  points.add(0.33);
  points.add(0.66);

  // Consecutive early frames pin the base interval spacing precisely.
  points.add(1.5);
  points.add(2.5);
  points.add(3.5);

  // Spread across the clip. A single dropped or extra frame shifts every later
  // frame by one whole slot permanently, so the residual GROWS toward the end;
  // sampling at 1/4, 1/2, 3/4 (each as a .33/.66 pair, to also catch a rate that
  // changes partway) and decisively at the last slot catches any integer
  // frame-count mismatch.
  for (const fraction of [0.25, 0.5, 0.75]) {
    const anchorFrame = Math.round(fraction * lastFrame);
    points.add(anchorFrame + 0.33);
    points.add(anchorFrame + 0.66);
  }
  points.add(lastFrame + 0.5);

  return Array.from(points)
    .filter((frameUnits) => frameUnits >= 0 && Math.floor(frameUnits) <= lastFrame)
    .sort((a, b) => a - b)
    .map((frameUnits) => ({
      frameUnits,
      seekOffsetSeconds: frameUnits * frameDuration,
      expectedFrameIndex: Math.floor(frameUnits),
      expectedTimeSeconds: Math.floor(frameUnits) * frameDuration,
    }));
}

// Does a landed timestamp (measured from the first frame's timestamp) sit within
// tolerance of where a constant-rate clip would present the expected frame?
export function probeStepPasses(observedTimeFromAnchor, expectedTimeSeconds, rate) {
  return Math.abs(observedTimeFromAnchor - expectedTimeSeconds) <= declaredRateTolerance(rate);
}

// The runtime check, for a frame presented during ordinary playback: snap the
// timestamp to the nearest declared-rate slot and report whether it landed on it.
// A clip that is constant-rate at the declared rate keeps every presented frame
// on a slot; sustained misses mean the mapping is wrong.
export function isPresentedTimeOnGrid(observedTimeFromAnchor, rate) {
  const frameIndex = Math.round(observedTimeFromAnchor * rate);
  if (frameIndex < 0) return { onGrid: false, frameIndex, residual: Infinity };
  const residual = Math.abs(observedTimeFromAnchor - frameIndex / rate);
  return { onGrid: residual <= declaredRateTolerance(rate), frameIndex, residual };
}
