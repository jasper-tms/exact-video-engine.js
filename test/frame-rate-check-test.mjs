// Unit test for the declared-frame-rate verification math (src/frame-rate-check.js).
// Pure functions over numbers and a synthetic frame-timestamp lattice, so this
// runs in plain Node with no browser and no fixture. It is the guarantee behind
// the seek-probe in NativeVideoEngine, whose browser wiring the Playwright
// declared-rate-verify-test then exercises end to end against real clips.
//
// Reads directly from src/ so it checks the same code the build concatenates into
// the shipped file.
import {
  declaredRateTolerance, predictedFrameCount, buildDeclaredRateProbePlan,
  probeStepPasses, isPresentedTimeOnGrid,
} from '../src/frame-rate-check.js';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} frame-rate-check ${name}: ${detail}`);
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// --- the basic arithmetic ----------------------------------------------------
eq('tolerance is a quarter frame', declaredRateTolerance(30), 0.25 / 30);
eq('predictedFrameCount rounds duration*rate', predictedFrameCount(1.0, 30), 30);
eq('predictedFrameCount is >= 1 even for a zero-length clip', predictedFrameCount(0, 30), 1);
eq('predictedFrameCount guards a nonsense rate', predictedFrameCount(1.0, 0), 1);

// --- the probe plan ----------------------------------------------------------
const plan30 = buildDeclaredRateProbePlan(30, 30);
check('plan samples inside the first frame (0.33 and 0.66)',
  plan30.some((s) => s.frameUnits === 0.33) && plan30.some((s) => s.frameUnits === 0.66),
  plan30.map((s) => s.frameUnits).join(','));
check('the two first-frame samples expect the SAME frame 0 (intruder detection)',
  plan30.filter((s) => s.frameUnits < 1).every((s) => s.expectedFrameIndex === 0),
  'sub-frame points -> frame 0');
check('plan samples the last slot (end drift)',
  plan30.some((s) => s.expectedFrameIndex === 29),
  `max expected ${Math.max(...plan30.map((s) => s.expectedFrameIndex))}`);
check('no probe seeks past the last frame',
  plan30.every((s) => s.expectedFrameIndex <= 29),
  'all expectedFrameIndex <= 29');
check('seek offset and expected time are in seconds at the rate',
  plan30.every((s) => Math.abs(s.seekOffsetSeconds - s.frameUnits / 30) < 1e-12
    && Math.abs(s.expectedTimeSeconds - Math.floor(s.frameUnits) / 30) < 1e-12),
  'offsets consistent with 1/30 s frames');
check('a tiny clip still produces a (small) plan',
  buildDeclaredRateProbePlan(30, 1).length >= 1, `${buildDeclaredRateProbePlan(30, 1).length} steps`);
eq('a nonsense rate yields no plan', buildDeclaredRateProbePlan(0, 30).length, 0);

// --- probeStepPasses against a synthetic true lattice ------------------------
// Model a real clip as a function from time -> the timestamp of the frame that
// covers that time (what a seek lands on), then run the plan through it exactly
// as the engine will, and assert pass/fail matches the clip's true nature.
function coveredFrameTime(frameStartTimes, seekTime) {
  let landed = frameStartTimes[0];
  for (const t of frameStartTimes) {
    if (t <= seekTime + 1e-9) landed = t; else break;
  }
  return landed;
}
function probeAgainst(rate, frameStartTimes) {
  const plan = buildDeclaredRateProbePlan(rate, frameStartTimes.length);
  const anchor = frameStartTimes[0];
  return plan.every((step) => {
    const landed = coveredFrameTime(frameStartTimes, anchor + step.seekOffsetSeconds);
    return probeStepPasses(landed - anchor, step.expectedTimeSeconds, rate);
  });
}

// A genuinely constant 30 fps clip passes at 30.
const cfr30 = Array.from({ length: 30 }, (_, k) => k / 30);
check('true 30 fps clip passes the 30 fps probe', probeAgainst(30, cfr30) === true, 'CFR@30 -> pass');

// The SAME clip declared at 60 fps: half the 60 fps grid points have no frame, so
// a spacing probe lands a frame short of where a 60 fps clip would put it.
check('30 fps clip declared as 60 fps is disproven',
  probeAgainst(60, cfr30) === false, 'CFR@30 as 60 -> fail (phantom frames)');

// A true 60 fps clip declared at 30: the extra frames hide between the 30 fps
// grid points, and the 0.33/0.66 pair inside frame 0 lands on different frames.
const cfr60 = Array.from({ length: 60 }, (_, k) => k / 60);
check('60 fps clip declared as 30 fps is disproven (hidden intruders)',
  probeAgainst(30, cfr60) === false, 'CFR@60 as 30 -> fail');

// A variable clip: 30 frames at ~33 ms but every 5th frame held for 66 ms (the
// counter-vfr fixture's shape). Declared at 30 fps the dropped slots accumulate,
// so the end-of-clip probe lands well short of the last predicted slot.
const vfr = [];
{
  let t = 0;
  for (let k = 0; k < 30; k++) {
    vfr.push(t);
    t += ((k + 1) % 5 === 0) ? 0.066 : 0.033;
  }
}
check('variable-frame-rate clip declared as 30 fps is disproven',
  probeAgainst(30, vfr) === false, 'VFR as CFR@30 -> fail');

// --- isPresentedTimeOnGrid (the runtime watcher) -----------------------------
check('a frame exactly on a slot is on grid',
  isPresentedTimeOnGrid(5 / 30, 30).onGrid === true, '5/30 s');
check('a frame a hair off a slot is still on grid (rounding slack)',
  isPresentedTimeOnGrid(5 / 30 + 0.001, 30).onGrid === true, '5/30 + 1 ms');
check('a frame a third of a frame off a slot is OFF grid',
  isPresentedTimeOnGrid(5 / 30 + (1 / 3) / 30, 30).onGrid === false, 'off by 1/3 frame');
eq('the snapped frame index is the nearest slot',
  isPresentedTimeOnGrid(5 / 30 + 0.001, 30).frameIndex, 5);

process.exit(failures ? 1 : 0);
