// Drives test-startup.html: how many bytes does the engine pull before it can
// show a frame?
//
// The bug this guards: _ensureBytes fetched a flat 4 MB block on every miss, so
// showing frame 0 -- which needs one keyframe -- blocked on 4 MB. Every other
// test in the suite passed throughout, because the frames were all correct; they
// just took seconds to arrive on a real network, and the cost grew with the
// clip's bitrate. Correctness tests cannot see this. Byte counts can.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install playwright).
import { chromium } from 'playwright';

const FILE = 'startup.mp4';

// One keyframe of 640x360 noise, plus slack. The old engine spent 4 MB + the
// index here; anything near that means the flat block is back.
const FRAME_BUDGET_BYTES = 1.5e6;
// The fixture has to be big enough that a 4 MB block is not simply the whole
// file, or this test would pass against the bug.
const MINIMUM_FIXTURE_BYTES = 8e6;

// Measured over a throttled link, for two reasons. It is the condition the bug
// actually hurt in — on localhost a 4 MB blocking read costs milliseconds and
// looks free, which is how it survived this long. And it keeps the measurement
// honest: ensureFrame() resolves by polling, and on an infinitely fast link the
// background read-ahead pulls megabytes during a single 8 ms poll interval, so
// the byte count picks up bytes the viewer never waited for.
const DOWNLOAD_BITS_PER_SECOND = 20e6;
const LATENCY_MS = 50;
// What the viewer actually experiences. The frame needs ~0.5 MB at 20 Mbps;
// the old engine needed 4 MB + index and blew straight through this.
const FRAME_BUDGET_SECONDS = 2.0;

const browser = await chromium.launch();
let failures = 0;

function report(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} startup ${name}: ${detail}`);
}

async function measure(mode) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  const client = await page.context().newCDPSession(page);
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: DOWNLOAD_BITS_PER_SECOND / 8,
    uploadThroughput: DOWNLOAD_BITS_PER_SECOND / 8,
    latency: LATENCY_MS,
  });
  await page.goto(`http://localhost:8798/test/test-startup.html?file=${FILE}&mode=${mode}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 180000 })
    .catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();
  if (err || !result) throw new Error(err || 'no result (timed out)');
  return result;
}

const megabytes = (bytes) => `${(bytes / 1e6).toFixed(2)} MB`;

for (const mode of ['first-frame', 'keyframe-seek']) {
  try {
    const result = await measure(mode);
    if (result.fileBytes < MINIMUM_FIXTURE_BYTES) {
      report(mode, false, `fixture is only ${megabytes(result.fileBytes)}; `
        + `a byte budget against it proves nothing (regenerate test/clips)`);
      continue;
    }
    const withinBytes = result.bytesForFrame <= FRAME_BUDGET_BYTES;
    const withinSeconds = result.secondsForFrame <= FRAME_BUDGET_SECONDS;
    report(mode, withinBytes && withinSeconds && result.decoded,
      `frame ${result.frame} of a ${megabytes(result.fileBytes)} clip cost `
      + `${megabytes(result.bytesForFrame)} and ${result.secondsForFrame.toFixed(1)}s `
      + `(budgets ${megabytes(FRAME_BUDGET_BYTES)}, ${FRAME_BUDGET_SECONDS}s @ `
      + `${DOWNLOAD_BITS_PER_SECOND / 1e6}Mbps), index ${megabytes(result.bytesForIndex)}`
      + (result.decoded ? '' : ' — FRAME NOT DECODED'));
  } catch (error) {
    report(mode, false, String(error.message || error));
  }
}

try {
  const result = await measure('window-ahead');
  // A host that turns read-ahead off must actually stop paying for it: after the
  // frame it asked for has landed, an idle engine with windowAhead:0 should not
  // still be pulling video down.
  //
  // The assertion is an absolute bound, not "0 pulled less than 56". That
  // comparison looked reasonable and was worthless: an engine that ignores the
  // option entirely still produces two different numbers, because how much
  // read-ahead lands inside a fixed idle window depends on timing. It passed
  // against the very bug it was written to catch.
  const quiet = result.bytesIdleWindow0 <= FRAME_BUDGET_BYTES;
  report('window-ahead', quiet,
    `windowAhead:0 pulled ${megabytes(result.bytesIdleWindow0)} `
    + `(budget ${megabytes(FRAME_BUDGET_BYTES)}); the default 56 pulled `
    + `${megabytes(result.bytesIdleWindow56)}`
    + (quiet ? '' : ' — read-ahead ran anyway, so the option did nothing'));
} catch (error) {
  report('window-ahead', false, String(error.message || error));
}

await browser.close();
process.exit(failures ? 1 : 0);
