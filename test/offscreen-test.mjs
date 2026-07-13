// Drives test-offscreen.html through headless Chromium: a host that never puts
// the engine's canvas in the document, and only wants pixels out of it.
//
// Regression test for a crash that was invisible because it still worked.
// _syncCanvasSize() read clientWidth off a null parentElement, throwing out of
// load(); createBestEngine caught that and fell back to the <video> element, so
// every offscreen host got a working thumbnail from the WRONG engine, forever.
// Hence the tier assertion: a test that only checked the pixels would pass
// against the bug.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install playwright).
import { chromium } from 'playwright';

const CASES = [
  // The canvas is never appended to anything: parentElement is null. This is
  // what threw.
  { mode: 'no-parent' },
  // The canvas sits in a detached div, so it has a parent that measures 0x0.
  // This one always worked, and is the workaround a host stumbles into when
  // no-parent crashes; it must keep working.
  { mode: 'detached' },
];

const browser = await chromium.launch();
let failures = 0;

for (const { mode } of CASES) {
  const file = 'counter-cfr.mp4';
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`http://localhost:8798/test/test-offscreen.html?file=${file}&mode=${mode}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 60000 })
    .catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();

  if (err || !result) {
    console.log(`FAIL offscreen ${mode}: ${err || 'no result (timed out)'}`);
    failures += 1;
    continue;
  }

  const problems = [];
  if (result.tier !== 'webcodecs') {
    problems.push(`fell back to '${result.tier}' — load() threw and `
      + `createBestEngine swallowed it as an unplayable clip`);
  }
  if (!result.hasBitmap) {
    problems.push('no bitmap for the requested frame');
  } else if (result.frameInBitmap !== result.askedFor) {
    problems.push(`bitmap holds frame ${result.frameInBitmap}, `
      + `asked for ${result.askedFor}`);
  }

  if (problems.length) {
    failures += 1;
    console.log(`FAIL offscreen ${mode}: ${problems.join('; ')}`);
  } else {
    console.log(`PASS offscreen ${mode}: frame ${result.frameInBitmap} decoded `
      + `[${result.tier}], canvas left at ${result.canvasSize.join('x')}`);
  }
}

await browser.close();
process.exit(failures ? 1 : 0);
