// Drives test-frame-index.html through headless Chromium and checks, frame by
// frame, that asking an engine for frame n both PUTS frame n on screen and gets
// frame n reported back. Ground truth comes from the pixels (the clips identify
// each frame by the position of a white bar), not from any clock.
//
// Two things are being proved here.
//
// counter-vfr.mp4: the <video> element mismaps a variable-frame-rate clip when
// it can only assume a constant frame rate, and stops mismapping it the moment
// it is handed the container's real timestamp table — the same table WebCodecs
// decodes from. That is why ContainerIndex is built even when WebCodecs is not
// in play.
//
// counter-elst.mp4: the element's timeline does not always start at zero. This
// clip's first frame reports mediaTime 0.133, so an engine that assumed the two
// timelines coincided would report every frame number shifted. Passing here
// means the calibration in NativeVideoEngine is genuinely finding the offset,
// not just getting away with a zero one.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install playwright).
import { chromium } from 'playwright';

// firstBar: the bar position of the clip's own frame 0. It is the frame index
// within the SOURCE clip the frames were drawn from, so it is 0 for clips that
// start at the beginning and 10 for counter-elst.mp4, whose head was cut (see
// make-test-clips.sh). Pinning it is what turns "the frames advance one for
// one" into "the frames are the right frames".
const CASES = [
  { file: 'counter-cfr.mp4', mode: 'webcodecs', firstBar: 0, expectExact: true },
  { file: 'counter-cfr.mp4', mode: 'native-index', firstBar: 0, expectExact: true },
  // A constant-frame-rate clip is the one case where assuming a constant frame
  // rate is right, so this passes — it is here to show the declared-rate path
  // is not simply broken.
  { file: 'counter-cfr.mp4', mode: 'native-declared', firstBar: 0, expectExact: true },

  { file: 'counter-vfr.mp4', mode: 'webcodecs', firstBar: 0, expectExact: true },
  { file: 'counter-vfr.mp4', mode: 'native-index', firstBar: 0, expectExact: true },
  // ...and here it is wrong. If this ever starts passing, the VFR clip has
  // stopped being variable-frame-rate and the two cases above prove nothing.
  { file: 'counter-vfr.mp4', mode: 'native-declared', firstBar: 0, expectExact: false },

  { file: 'counter-elst.mp4', mode: 'webcodecs', firstBar: 10, expectExact: true },
  { file: 'counter-elst.mp4', mode: 'native-index', firstBar: 10, expectExact: true },
];

const browser = await chromium.launch();
let failures = 0;

for (const { file, mode, firstBar, expectExact } of CASES) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`http://localhost:8798/test/test-frame-index.html?file=${file}&mode=${mode}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 60000 })
    .catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();

  if (err || !result) {
    console.log(`FAIL ${file} ${mode}: ${err || 'no result (timed out)'}`);
    failures += 1;
    continue;
  }

  const wrongPixels = result.rows.filter((r) => r.visible !== r.asked + firstBar);
  const wrongReports = result.rows.filter((r) => r.reported !== r.asked);
  const exact = wrongPixels.length === 0 && wrongReports.length === 0;
  const pass = exact === expectExact;
  if (!pass) failures += 1;

  const count = result.rows.length;
  const detail = exact
    ? `all ${count} frames exact`
    : `${wrongPixels.length}/${count} wrong frame on screen, `
      + `${wrongReports.length}/${count} misreported`;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${file} ${mode}: ${detail}`
    + ` [${result.tier}, frameIndexIsExact=${result.frameIndexIsExact}]`);

  if (!pass) {
    const show = (expectExact ? [...wrongPixels, ...wrongReports] : result.rows).slice(0, 6);
    for (const r of show) {
      console.log(`       asked ${r.asked} -> on screen `
        + `${r.visible - firstBar} (bar ${r.visible}), reported ${r.reported}`);
    }
  }
}

await browser.close();
process.exit(failures ? 1 : 0);
