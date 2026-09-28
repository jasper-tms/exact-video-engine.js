// Drives test-pixel-aspect.html through the browser named by TEST_BROWSER
// (chromium, webkit, or firefox) for each anamorphic fixture and the square
// plain.mp4 control, and asserts that:
//
//   * both engines report videoWidth/videoHeight in STORED pixels and the same
//     pixelAspectRatio — the native engine used to report the <video>
//     element's display-shaped size, so one file's coordinates depended on
//     which tier played it;
//   * the WebCodecs engine caches stored pixels one for one (bitmapForFrame),
//     whatever a decoder folds into VideoFrame.displayWidth;
//   * its canvas letterboxes at the display shape by default and at the stored
//     shape with applyPixelAspectRatio: false;
//   * where this browser can play the clip in a bare <video>, the element's own
//     display shape agrees with the engine's.
//
// The fixtures (make-test-clips.sh) store 320x180 with a 1:2 pixel shape, in an
// MP4 `pasp` box and in WebM DisplayWidth/DisplayHeight; the rotated one is
// upright 180x320 with 2:1 pixels.
// Expects the repo root to be served at http://localhost:8798 (run-tests.sh
// handles that) and Playwright to be installed (npm install).
import { launchBrowser, browserName, serverBase } from './harness.mjs';

const FIXTURES = [
  { file: 'plain.mp4', width: 320, height: 180, pixelAspectRatio: 1, bitmap: [320, 180] },
  { file: 'anamorphic.mp4', width: 320, height: 180, pixelAspectRatio: 0.5, bitmap: [320, 180] },
  { file: 'anamorphic-rot90.mp4', width: 180, height: 320, pixelAspectRatio: 2, bitmap: [320, 180] },
  { file: 'anamorphic.webm', width: 320, height: 180, pixelAspectRatio: 0.5, bitmap: [320, 180] },
];
// The painted shape is measured in whole canvas pixels of a 200-pixel pane, so
// allow a pixel or so of rounding at each edge.
const SHAPE_TOLERANCE = 0.03;

const browser = await launchBrowser();
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} pixel-aspect ${browserName} ${name}: ${detail}`);
}
const close = (a, b) => Math.abs(a / b - 1) <= SHAPE_TOLERANCE;
const shape = ({ width, height }) => width / height;

for (const fixture of FIXTURES) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${serverBase}/test/test-pixel-aspect.html?file=${fixture.file}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 30000 });
  const { result, err } = await page.evaluate(() => ({ result: window.__result, err: window.__err }));
  await page.close();
  if (!result) { check(fixture.file, false, `page error: ${err}`); continue; }

  const storedShape = fixture.width / fixture.height;
  const displayShape = storedShape * fixture.pixelAspectRatio;
  const { webCodecsDisplay, webCodecsStored, native, groundTruth } = result;

  check(`${fixture.file} WebCodecs geometry`,
    webCodecsDisplay.videoWidth === fixture.width
      && webCodecsDisplay.videoHeight === fixture.height
      && webCodecsDisplay.pixelAspectRatio === fixture.pixelAspectRatio,
    `${webCodecsDisplay.videoWidth}x${webCodecsDisplay.videoHeight} `
      + `pixelAspectRatio=${webCodecsDisplay.pixelAspectRatio}`);
  check(`${fixture.file} cached bitmap holds stored pixels`,
    webCodecsDisplay.bitmap?.width === fixture.bitmap[0]
      && webCodecsDisplay.bitmap?.height === fixture.bitmap[1],
    `bitmap ${webCodecsDisplay.bitmap?.width}x${webCodecsDisplay.bitmap?.height}`);
  check(`${fixture.file} painted at display shape by default`,
    close(shape(webCodecsDisplay.painted), displayShape),
    `painted ${webCodecsDisplay.painted.width}x${webCodecsDisplay.painted.height}, `
      + `want shape ${displayShape.toFixed(3)}`);
  check(`${fixture.file} painted at stored shape with applyPixelAspectRatio false`,
    close(shape(webCodecsStored.painted), storedShape),
    `painted ${webCodecsStored.painted.width}x${webCodecsStored.painted.height}, `
      + `want shape ${storedShape.toFixed(3)}`);

  if (native.error) {
    console.log(`SKIP pixel-aspect ${browserName} ${fixture.file} native engine: ${native.error}`);
  } else {
    check(`${fixture.file} native engine geometry`,
      native.videoWidth === fixture.width && native.videoHeight === fixture.height
        && native.pixelAspectRatio === fixture.pixelAspectRatio,
      `${native.videoWidth}x${native.videoHeight} pixelAspectRatio=${native.pixelAspectRatio} `
        + `(${native.tier})`);
  }

  if (!groundTruth) {
    console.log(`SKIP pixel-aspect ${browserName} ${fixture.file} <video> ground truth: `
      + 'this browser cannot play the clip natively');
  } else {
    check(`${fixture.file} agrees with the <video> element's display shape`,
      close(shape(groundTruth), displayShape),
      `<video> ${groundTruth.width}x${groundTruth.height}, `
        + `engine shape ${displayShape.toFixed(3)}`);
  }
}
await browser.close();
process.exit(failures ? 1 : 0);
