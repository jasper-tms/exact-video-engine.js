// Drives test-source-unavailable.html through headless Chromium: a local file
// renamed while it is open. Before this was handled, the WebCodecs engine's
// decode driver hit NotFoundError on its next read, logged it, and was started
// again by the very next update() — about sixty failed reads and console errors
// a second, forever — while the picture froze on its last frame, looking like
// a pause, with nothing telling the host. The native engine froze just as
// silently: its element fired 'error', and nothing was listening once load()
// had finished.
//
// For each tier this pins that the engine (a) latches `failed` and fires one
// fatal errormessage carrying sourceUnavailable, so a host can ask the person
// to open the file again rather than rebuild an engine on a missing file,
// (b) then goes quiet instead of retrying every tick, and (c) for the WebCodecs
// tier, makes ensureFrame() reject off the failed flag rather than time out.
//
// The file is picked through a real file input from a real path, so the File
// is disk-backed exactly as a person's would be, and the rename is a real
// rename. The clip is hd-long.mp4 so that the seek lands on bytes neither tier
// read while loading.
// Chromium-only: Playwright hands a file input a real path only there, and the
// behavior pinned is engine bookkeeping, not a decode-path difference.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, serverBase } from './harness.mjs';

const CLIP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clips', 'hd-long.mp4');
// Seconds, not milliseconds, for the native tier: Chromium retries the read a
// few times itself before the element gives up and fires 'error'.
const FAILURE_BUDGET_MILLISECONDS = { webcodecs: 3000, native: 20000 };
// A handful of errors around the failure is fine (the engine's own report, the
// browser's failed-resource lines); sixty a second is the bug.
const QUIET_ERROR_BUDGET = 5;

const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-unavailable-'));
const browser = await launchBrowser();
let failures = 0;

for (const tier of ['webcodecs', 'native']) {
  const clipPath = path.join(workDirectory, `${tier}.mp4`);
  fs.copyFileSync(CLIP, clipPath);
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  const problems = [];
  try {
    await page.goto(`${serverBase}/test/test-source-unavailable.html`);
    await page.setInputFiles('#picker', clipPath);
    const loaded = await page.evaluate((prefer) => window.loadEngine(prefer), tier);
    if (!loaded.tier.startsWith(tier)) problems.push(`wanted the ${tier} engine, got '${loaded.tier}'`);

    fs.renameSync(clipPath, clipPath + '.renamed');
    const result = await page.evaluate(
      (timeout) => window.observeFailure(timeout), FAILURE_BUDGET_MILLISECONDS[tier]);

    if (!result.detail) {
      problems.push(`no fatal errormessage within ${FAILURE_BUDGET_MILLISECONDS[tier]} ms`);
    } else {
      if (result.detail.sourceUnavailable !== true) problems.push('detail.sourceUnavailable !== true');
      if (!result.detail.message) problems.push('detail.message missing');
      if (typeof result.detail.frame !== 'number') problems.push('detail.frame missing');
      if (tier === 'webcodecs' && result.detail.errorName !== 'NotFoundError') {
        problems.push(`detail.errorName '${result.detail.errorName}', wanted 'NotFoundError'`);
      }
    }
    if (!result.failed) problems.push('engine.failed was not set');
    if (result.errorsAfterFailure > QUIET_ERROR_BUDGET) {
      problems.push(`${result.errorsAfterFailure} console errors in the 2 s after the `
        + 'failure — the engine is still retrying a source that is gone');
    }
    if (tier === 'webcodecs') {
      if (result.ensureError !== 'decoder failed') {
        problems.push(`ensureFrame rejected with '${result.ensureError}', wanted 'decoder failed'`);
      } else if (result.ensureMilliseconds > 1000) {
        problems.push(`ensureFrame took ${result.ensureMilliseconds.toFixed(0)} ms to reject — `
          + 'that is the decode timeout, not the failed flag');
      }
    }
    if (problems.length) {
      console.log(`FAIL source-unavailable (${tier}): ${problems.join('; ')}`);
      failures++;
    } else {
      console.log(`PASS source-unavailable (${tier}): fatal sourceUnavailable event after `
        + `${result.failureMilliseconds.toFixed(0)} ms at frame ${result.detail.frame}, `
        + `${result.errorsAfterFailure} console errors in the 2 s after`);
    }
  } catch (e) {
    console.log(`FAIL source-unavailable (${tier}): ${e && e.stack || e}`);
    failures++;
  }
  await page.close();
}

await browser.close();
fs.rmSync(workDirectory, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
