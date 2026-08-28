// Drives test-stall.html on a link too slow to sustain real time: does playback
// BUFFER (hold the clock on the last frame and wait) rather than DROP (run the
// clock on and skip every frame that did not arrive)?
//
// This is the behaviour ordinary online players show, and the thing that would
// silently regress if VideoEngine.update() went back to advancing its clock
// through an undecoded frame. stall-test.mjs cannot see it: it runs on links
// where the encoded-byte prefetch keeps playback fed, so nothing ever stalls and
// the hold never engages. So this test throttles the body well below the clip's
// bitrate, which forces genuine byte stalls, and reads two things back:
//
//   - with rebuffering ON (the default), the picture never jumps more than one
//     frame across a freeze (the clock HELD — no frames were dropped), the
//     `rebuffering` flag was observed true, and playback still made real
//     forward progress rather than deadlocking;
//   - with rebuffering OFF (rebufferSeconds=0, the older behaviour), the same
//     link drops a run of frames in a single jump — the collapse the hold
//     exists to prevent, and the proof that the ON result is the feature working
//     rather than the link simply keeping up.
//
// Chromium only, for the same reason as stall-test: this pins engine
// bookkeeping (the owned clock), not a browser-specific decode path, and it
// leans on VideoEngine internals the page traces. The <video> tier buffers on
// its own clock and is a different subject.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install).
import { launchBrowser, serverBase } from './harness.mjs';

// 1080p at a real bitrate (so the decoded read-ahead is a handful of frames and
// the encoded-byte prefetch is the only cover), long enough to cross several
// block boundaries. Same fixture as stall-test.
const FILE = 'hd-long.mp4';
const MINIMUM_FIXTURE_WIDTH = 1920;
const PLAY_SECONDS = 12;
// serve.py's per-request latency and rate cap (which reach any browser, unlike
// CDP throttling). 1.2 MB/s is below this clip's bitrate, so the byte prefetch
// cannot stay ahead and playback genuinely stalls for data.
const LATENCY_MILLISECONDS = 150;
const BYTES_PER_SECOND = 1_200_000;

// A freeze that jumps more than this many frames dropped the frames in between;
// one frame is the next frame doing its job (see findFreezes in test-stall.html).
const HELD_SKIP_CEILING = 1;
// The dropped run the OFF case must show to prove the link really is stalling —
// far above the ON ceiling, comfortably below what the collapse produces (~200+).
const DROPPED_SKIP_FLOOR = 10;
// Some real frames must reach the screen in the ON case, or a "no drops" pass
// would be vacuous (a deadlocked clock drops nothing either).
const MINIMUM_FRAMES_PRESENTED = 60;

const browser = await launchBrowser();
let failures = 0;

function report(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} rebuffer ${name}: ${detail}`);
}

async function measure(rebufferSeconds) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  const query = new URLSearchParams({
    file: FILE,
    playSeconds: String(PLAY_SECONDS),
    latencyMilliseconds: String(LATENCY_MILLISECONDS),
    bytesPerSecond: String(BYTES_PER_SECOND),
  });
  if (rebufferSeconds != null) query.set('rebufferSeconds', String(rebufferSeconds));
  await page.goto(`${serverBase}/test/test-stall.html?${query}`);
  await page.waitForFunction(() => window.__result || window.__err,
    { timeout: (PLAY_SECONDS + 120) * 1000 }).catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();
  if (err || !result) throw new Error(err || 'no result (timed out)');
  if (result.videoWidth < MINIMUM_FIXTURE_WIDTH) {
    throw new Error(`${FILE} is only ${result.videoWidth} wide; the read-ahead `
      + `then covers the reads and this proves nothing`);
  }
  return result;
}

// ON (default hold): the clock waits, so no freeze drops frames.
try {
  const on = await measure(null);
  const ok = on.everRebuffered
    && on.maxSkippedFrames <= HELD_SKIP_CEILING
    && on.framesPresented >= MINIMUM_FRAMES_PRESENTED;
  report('holds instead of dropping', ok,
    `rebuffered ${on.everRebuffered}, worst jump ${on.maxSkippedFrames} frame(s) `
    + `(ceiling ${HELD_SKIP_CEILING}), ${on.freezeCount} freeze(s), presented `
    + `${on.framesPresented}/${on.framesExpected} in ${on.playedSeconds}s`);
} catch (e) {
  report('holds instead of dropping', false, e.message);
}

// OFF (rebufferSeconds=0): the clock runs on, so the same link drops a run of
// frames — the contrast that proves the ON pass is the hold working.
try {
  const off = await measure(0);
  const ok = !off.everRebuffered && off.maxSkippedFrames >= DROPPED_SKIP_FLOOR;
  report('rebufferSeconds:0 restores frame-dropping', ok,
    `rebuffered ${off.everRebuffered}, worst jump ${off.maxSkippedFrames} frame(s) `
    + `(floor ${DROPPED_SKIP_FLOOR}), presented ${off.framesPresented}/${off.framesExpected}`);
} catch (e) {
  report('rebufferSeconds:0 restores frame-dropping', false, e.message);
}

await browser.close();
process.exit(failures ? 1 : 0);
