// Drives test-memory.html: how much memory does the engine hold in decoded
// frames while a clip plays?
//
// The bug this guards: the frame cache was budgeted in FRAMES (82 of them), and
// a frame's cost is its resolution. 82 frames of the 360p clips this suite is
// built from is 75 MB; 82 frames of a customer's 1080p phone clip is 680 MB. On
// iOS that exhausts the pool the decoder allocates its output from, and WebKit
// kills the decode session a second or two into playback -- "Decoder failure",
// on the big clips only, which reads like a codec problem and is not one.
//
// Nothing else in the suite can see this: the frames are correct at any window
// size, and the startup test counts bytes off the NETWORK, not bytes held in
// memory. Test against a genuinely large-framed clip (clips/hd.mp4) or it proves
// nothing -- at 360p the old frame-counted budget fits inside the byte budget
// anyway and passes.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install playwright).
import { chromium } from 'playwright';

const LARGE_FILE = 'hd.mp4';        // 1920x1080: ~8.3 MB per decoded frame
const SMALL_FILE = 'startup.mp4';   // 640x360: ~0.9 MB per decoded frame

const DEFAULT_CACHE_BYTES = 96 << 20;   // the engine's default, unstated by the host
// A host that asks for less. Tried against the 1080p clip first, which starved
// it to four resident frames and made playback stutter -- correct behaviour for
// a 32 MB ceiling on 8 MB frames, and a useless test of the option. Asked of a
// small-framed clip the same ceiling still buys a workable window, so what the
// assertion sees is the option being honoured rather than the clip drowning.
const CUSTOM_CACHE_BYTES = 16 << 20;
// The engine's own read-ahead default. A byte budget could be honoured by simply
// caching nothing, which would make every clip stutter; on a small-framed clip
// the full window fits, so it must still be there.
const DEFAULT_WINDOW_AHEAD = 56;
// The fixture has to have big frames, or the old frame-counted cache fits inside
// the byte budget by accident and this test passes against the bug.
const MINIMUM_FIXTURE_WIDTH = 1920;
// Playback has to actually get somewhere: an engine that decoded nothing holds
// no memory and would sail through any budget.
const MINIMUM_FRAMES_PLAYED = 30;

const browser = await chromium.launch();
let failures = 0;

function report(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} memory ${name}: ${detail}`);
}

async function measure(file, cacheBytes) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  const query = cacheBytes ? `&cacheBytes=${cacheBytes}` : '';
  await page.goto(`http://localhost:8798/test/test-memory.html?file=${file}${query}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 120000 })
    .catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();
  if (err || !result) throw new Error(err || 'no result (timed out)');
  return result;
}

const megabytes = (bytes) => `${(bytes / (1 << 20)).toFixed(0)} MB`;

// A frame or so over the ceiling is fine: eviction runs as each frame lands, so
// the cache can sit one arrival above its budget for an instant.
function overBudget(result, budget) {
  const oneFrame = result.videoWidth * result.videoHeight * 4;
  return result.peakBytes > budget + oneFrame;
}

function playedProperly(result) {
  return result.frameShown && result.playedToFrame >= MINIMUM_FRAMES_PLAYED;
}

// The regression itself: big frames, default settings, and the memory the engine
// holds while playing them. This is the number that took the iPhone decoder down.
try {
  const name = '1080p stays inside the budget';
  const result = await measure(LARGE_FILE, undefined);
  if (result.videoWidth < MINIMUM_FIXTURE_WIDTH) {
    report(name, false, `${LARGE_FILE} is only ${result.videoWidth}px wide; a `
      + 'memory budget against small frames proves nothing (regenerate test/clips)');
  } else {
    const ok = !overBudget(result, DEFAULT_CACHE_BYTES) && playedProperly(result);
    report(name, ok,
      `playing ${result.videoWidth}x${result.videoHeight} held at most `
      + `${megabytes(result.peakBytes)} in ${result.peakFrames} frames `
      + `(budget ${megabytes(DEFAULT_CACHE_BYTES)}), window ${result.windowBack} `
      + `back / ${result.windowAhead} ahead, reached frame ${result.playedToFrame} `
      + `of ${result.numFrames}`
      + (playedProperly(result) ? '' : ' — PLAYBACK STALLED'));
  }
} catch (error) {
  report('1080p stays inside the budget', false, String(error.message || error));
}

// The other half of the budget: it must still buy a BIG window when frames are
// small. A cache sized in bytes could be "honoured" by shrinking every clip's
// window to nothing, and then 360p playback would stutter for no reason.
try {
  const name = 'small frames keep full read-ahead';
  const result = await measure(SMALL_FILE, undefined);
  const kept = result.windowAhead === DEFAULT_WINDOW_AHEAD;
  const ok = kept && !overBudget(result, DEFAULT_CACHE_BYTES) && playedProperly(result);
  report(name, ok,
    `${result.videoWidth}x${result.videoHeight} kept ${result.windowAhead} frames `
    + `of read-ahead (want ${DEFAULT_WINDOW_AHEAD}) and held `
    + `${megabytes(result.peakBytes)}`
    + (kept ? '' : ' — the byte budget cut a window that fits'));
} catch (error) {
  report('small frames keep full read-ahead', false, String(error.message || error));
}

// And the ceiling is the host's to set: the same small clip, told to hold less,
// must hold less -- and must cut its read-ahead to do it, since that is where
// the memory goes.
try {
  const name = 'host lowers the ceiling';
  const result = await measure(SMALL_FILE, CUSTOM_CACHE_BYTES);
  const cut = result.windowAhead < DEFAULT_WINDOW_AHEAD;
  const ok = cut && !overBudget(result, CUSTOM_CACHE_BYTES) && playedProperly(result);
  report(name, ok,
    `cacheBytes ${megabytes(CUSTOM_CACHE_BYTES)} held at most `
    + `${megabytes(result.peakBytes)} in ${result.peakFrames} frames, read-ahead `
    + `cut to ${result.windowAhead}`
    + (cut ? '' : ' — the option did nothing')
    + (playedProperly(result) ? '' : ' — PLAYBACK STALLED'));
} catch (error) {
  report('host lowers the ceiling', false, String(error.message || error));
}

await browser.close();
process.exit(failures ? 1 : 0);
