// Drives test-progressive.html: plays a WebM through the WebCodecs engine while
// its index is still being built, and checks that the frames named early stay
// exactly the frames they were once the whole container has been read.
//
// progressive-index-test.mjs holds the TABLE to that promise in Node. This holds
// the PICTURE to it in a browser: the pixels of every early frame are read
// before and after the pass finishes, and they have to match. A table that is
// right and an engine that shows the wrong frame from it would pass one and fail
// the other.
//
// Chromium-first, like the other decode-driven drivers: the certification rules
// are engine-independent and their proof lives in the Node test, so running this
// under three browsers would only re-test WebCodecs itself.
//
// Expects the repo root to be served at http://localhost:8798 (run-tests.sh
// handles that) and Playwright to be installed (npm install playwright).
import { launchBrowser, serverBase, browserName } from './harness.mjs';

// VP9 and VP8 do not reorder, so these certify a prefix as soon as the next
// frame is read — the case a host actually gets to use. A reordering codec's
// honest watermark is the full 32768-tick block-offset window, which a
// one-second fixture never clears; that behaviour is pinned in the Node test.
const CLIPS = ['counter-cfr.webm', 'counter-vp8.webm'];

const browser = await launchBrowser();
let failures = 0;

let clipFailures = 0;
const check = (label, condition, detail) => {
  if (condition) return true;
  failures += 1;
  clipFailures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
  return false;
};

for (const file of CLIPS) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`${serverBase}/test/test-progressive.html`);
  const result = await page.evaluate(async (name) => {
    try {
      await window.run(name);
      return window.__result;
    } catch (err) {
      return { error: err && err.message ? err.message : String(err) };
    }
  }, file);

  console.log(`${file} (${browserName}):`);
  clipFailures = 0;
  if (result && result.skipped) {
    console.log(`  SKIP ${result.skipped}`);
    await page.close();
    continue;
  }
  if (!result || result.error) {
    failures += 1;
    console.log(`  FAIL threw: ${result && result.error}`);
    await page.close();
    continue;
  }

  // The engine really did come back before the index was finished — otherwise
  // everything below passes vacuously.
  check('engine loaded against a still-growing index',
    result.stateAtLoad === 'growing', `state was ${result.stateAtLoad}`);
  check('only part of the clip was indexed at that point',
    result.framesAtLoad > 0 && result.framesAtLoad < result.framesAfter,
    `${result.framesAtLoad} of ${result.framesAfter}`);
  check('frame numbers were exact from the start', result.frameIndexIsExact === true);
  check('it played on the WebCodecs tier', result.tier === 'webcodecs', result.tier);

  // Every frame named early showed the picture it named.
  for (const row of result.earlyRows) {
    check(`early frame ${row.asked} painted the right picture`,
      row.visible === row.asked, `pixels showed frame ${row.visible}`);
    check(`early frame ${row.asked} was reported as itself`,
      row.reported === row.asked, `engine said ${row.reported}`);
  }

  // A frame past the frontier is not nameable yet, and asking for one clamps
  // rather than inventing a number.
  check('seeking past the frontier clamps', result.clampedWithin,
    `landed on ${result.clampedFrame}`);

  // The pass finished, and the clip grew rather than restarting.
  check('the index completed', result.settled === 'complete', result.settled);
  check('state settled to complete', result.stateAfter === 'complete', result.stateAfter);
  check('the whole clip is indexed now', result.framesAfter === 30, `${result.framesAfter}`);
  check('duration only grew',
    result.durationAfter >= result.durationAtLoad,
    `${result.durationAtLoad} -> ${result.durationAfter}`);

  // THE POINT: the frames named while the index was growing are still exactly
  // the same frames now that it is finished.
  for (let i = 0; i < result.earlyRows.length; i++) {
    const before = result.earlyRows[i], after = result.lateRows[i];
    check(`frame ${before.asked} means the same picture after the pass finished`,
      before.visible === after.visible,
      `showed frame ${before.visible} while growing, ${after.visible} once complete`);
  }

  if (pageErrors.length) {
    failures += 1;
    clipFailures += 1;
    console.log(`  FAIL page errors: ${pageErrors.join('; ')}`);
  }
  if (!clipFailures) console.log('  PASS');
  await page.close();
}

await browser.close();
process.exit(failures ? 1 : 0);
