// Drives test-display.html through headless Chromium and checks that a frame
// actually reaches the screen.
//
// This is a regression test for a bug the frame-index test could never have
// caught, because that test asserts only on frame NUMBERS. The engine was
// loaded into a pane that was still display:none, so the pane measured 0x0, so
// the canvas backing store was clamped to 1x1 — one pixel holding the frame's
// average colour, which CSS then stretched across the pane as a flat wash. It
// looked like a decode failure. Every frame index was still correct, and the
// whole suite still passed.
//
// So the assertions here are on pixels: the backing store must match the pane
// it was revealed into, the painted image must have real spread (a flat wash
// has none), and the frame on screen must be the one that was asked for.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install playwright).
import { chromium } from 'playwright';

// Neither case calls resizeCanvas() after the pane is revealed. That is the
// point: doing so repairs the canvas even in the broken engine, so a case that
// did would pass either way. Both of these fail against the original bug.
const CASES = [
  // A host that sizes the canvas while the pane is still hidden and never
  // again — what demo.html did, and how the bug was reported.
  { mode: 'resize-while-hidden' },
  // A host that never calls resizeCanvas() at all. update() runs every
  // animation frame and re-syncs the backing store, so the pane can gain its
  // box at any time without the host having to get the timing right.
  { mode: 'self-heal' },
];

// A white bar on black. A correctly painted frame lands well above this; the
// 1x1 bug produces a single flat colour, whose spread is 0.
const MINIMUM_PIXEL_SPREAD = 20;

const browser = await chromium.launch();
let failures = 0;

for (const { mode } of CASES) {
  const file = 'counter-cfr.mp4';
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`http://localhost:8798/test/test-display.html?file=${file}&mode=${mode}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 60000 })
    .catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();

  if (err || !result) {
    console.log(`FAIL display ${mode}: ${err || 'no result (timed out)'}`);
    failures += 1;
    continue;
  }

  const problems = [];
  const [width, height] = result.backingStore;
  const [expectedWidth, expectedHeight] = result.expectedBackingStore;
  if (width !== expectedWidth || height !== expectedHeight) {
    problems.push(`backing store ${width}x${height}, expected `
      + `${expectedWidth}x${expectedHeight} (the revealed pane's size)`);
  }
  if (result.pixelSpread < MINIMUM_PIXEL_SPREAD) {
    problems.push(`canvas is a flat wash (pixel spread `
      + `${result.pixelSpread.toFixed(1)} < ${MINIMUM_PIXEL_SPREAD})`);
  }
  if (result.visible !== result.askedFor) {
    problems.push(`frame ${result.visible} on screen, asked for ${result.askedFor}`);
  }

  if (problems.length) {
    failures += 1;
    console.log(`FAIL display ${mode}: ${problems.join('; ')}`);
    console.log(`       backing store while pane was hidden: `
      + `${result.measuredWhileHidden.join('x')}`);
  } else {
    console.log(`PASS display ${mode}: frame ${result.visible} painted at `
      + `${width}x${height}, pixel spread ${result.pixelSpread.toFixed(1)}`
      + ` [${result.tier}]`);
  }
}

await browser.close();
process.exit(failures ? 1 : 0);
