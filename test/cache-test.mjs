// Drives test-cache.html through headless Chromium: the IndexedDB index cache
// must hit only on a proven-identical source and miss on every doubtful one
// (changed lastModified, identity-less Blob, wrong schema version), because a
// stale cached index is a wrong index — see src/index-cache.js. IndexedDB
// behaves the same across engines, so one engine covers it (run-tests.sh).
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install playwright).
import { launchBrowser, serverBase } from './harness.mjs';

const browser = await launchBrowser();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`${serverBase}/test/test-cache.html`);
await page.waitForFunction(() => window.__result || window.__err, { timeout: 60000 })
  .catch(() => {});
const { result, err } = await page.evaluate(
  () => ({ result: window.__result, err: window.__err }));
await page.close();
await browser.close();

if (err || !result) {
  console.log(`FAIL index-cache: ${err || 'no result (timed out)'}`);
  process.exit(1);
}

let failures = 0;
for (const { name, ok, detail } of result.checks) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} index-cache ${name}${detail ? `: ${detail}` : ''}`);
}
process.exit(failures ? 1 : 0);
