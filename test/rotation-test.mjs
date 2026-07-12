// Drives test-rotation.html through headless Chromium for each rotation clip
// and asserts the engine's rendering matches the native <video> element's.
// Expects the repo root to be served at http://localhost:8798 (run-tests.sh
// handles that) and Playwright to be installed (npm install playwright).
import { chromium } from 'playwright';

const browser = await chromium.launch();
let failures = 0;
for (const file of ['plain.mp4', 'rot90.mp4', 'rot180.mp4', 'rot270.mp4']) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`http://localhost:8798/test/test-rotation.html?file=${file}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 20000 });
  const d = await page.evaluate(() => ({ engine: window.__engine, result: window.__result, err: window.__err }));
  const redAt = Object.entries(d.result?.engine || {}).filter(([, v]) => v === 'red').map(([k]) => k);
  const match = d.result && JSON.stringify(d.result.engine) === JSON.stringify(d.result.video);
  if (!match || d.err) failures += 1;
  console.log(`${match && !d.err ? 'PASS' : 'FAIL'} ${file}: rotation=${d.engine?.rotation} `
    + `dims=${d.engine?.videoWidth}x${d.engine?.videoHeight} redAt=${redAt} err=${d.err}`);
  await page.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
