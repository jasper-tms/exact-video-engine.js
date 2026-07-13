// Drives test-decoder-failure.html through headless Chromium: the
// dishonest-yes decoder contract. When the VideoDecoder dies AFTER a
// successful load (WebKit with 10-bit HEVC), the engine must mark the
// errormessage event fatal (with the diagnostics a host needs: error name,
// codec string, frame) and make ensureFrame() reject promptly off the failed
// flag rather than sitting out the 5-second decode timeout — that fast
// rejection is also what lets a host rebuild with prefer: 'native' without
// the user watching a stall.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install playwright).
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://localhost:8798/test/test-decoder-failure.html');
await page.waitForFunction(() => window.__result || window.__err, { timeout: 60000 })
  .catch(() => {});
const { result, err } = await page.evaluate(
  () => ({ result: window.__result, err: window.__err }));
await page.close();
await browser.close();

if (err || !result) {
  console.log(`FAIL decoder-failure: ${err || 'no result (timed out)'}`);
  process.exit(1);
}

const problems = [];
if (!result.failedFlag) problems.push('engine.failed was not set');
if (!result.fatalDetail) {
  problems.push('no errormessage event carried detail.fatal');
} else {
  if (result.fatalDetail.fatal !== true) problems.push('detail.fatal !== true');
  if (result.fatalDetail.errorName !== 'EncodingError') {
    problems.push(`detail.errorName '${result.fatalDetail.errorName}', wanted 'EncodingError'`);
  }
  if (!result.fatalDetail.codec) problems.push('detail.codec missing');
  if (typeof result.fatalDetail.frame !== 'number') problems.push('detail.frame missing');
}
if (!result.codecString) problems.push('engine.codecString missing after load');
if (result.ensureError !== 'decoder failed') {
  problems.push(`ensureFrame rejected with '${result.ensureError}', wanted 'decoder failed'`);
}
if (result.ensureMs > 2000) {
  problems.push(`ensureFrame took ${result.ensureMs.toFixed(0)}ms to reject — `
    + 'that is the decode timeout, not the failed flag');
}

if (problems.length) {
  console.log(`FAIL decoder-failure: ${problems.join('; ')}`);
  process.exit(1);
}
console.log(`PASS decoder-failure: fatal event carried `
  + `${result.fatalDetail.errorName} on codec ${result.fatalDetail.codec} `
  + `at frame ${result.fatalDetail.frame}; ensureFrame rejected in `
  + `${result.ensureMs.toFixed(0)}ms`);
