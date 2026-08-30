// Drives test-loop-decode.html: a looped SINGLE-GOP clip must play every loop
// without the decode circuit-breaker giving up on a frame, in both cache
// regimes. See test-loop-decode.html for the full description of the bug.
//
//   FITS    the whole clip fits the budget -> it stays resident across the wrap,
//           so after the first loop nothing re-decodes, and the loop origin is
//           never cold (no origin prefetch needed).
//   EXCEEDS the clip is larger than the budget -> one restart per wrap is
//           inherent and must not warn, and the origin's bytes are prefetched.
//
// Both regimes are the SAME clip; the window/budget the driver is handed puts it
// on one side or the other. Expects the repo root served at http://localhost:8798
// (run-tests.sh handles that) and Playwright (npm install).
import { launchBrowser, serverBase } from './harness.mjs';

const browser = await launchBrowser();
let failures = 0;

function report(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} loop-decode ${name}: ${detail}`);
}

async function measure(query) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${serverBase}/test/test-loop-decode.html?${query}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 120000 })
    .catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();
  if (err || !result) throw new Error(err || 'no result (timed out)');
  return result;
}

// FITS: window 15 back / 15 ahead -> keep-edge 23, budget 39; the 30-frame clip
// fits (30 <= 39) but its tail (24..29) sits past the read-ahead window's forward
// edge, which the wrap used to evict and then re-decode from the keyframe.
try {
  const r = await measure('windowBack=15&windowAhead=15&playSeconds=12&rate=3');
  const fits = r.regionSpan <= r.cacheBudget;
  const ok = fits && r.warningCount === 0 && r.emitsAfterFirstWrap === 0
    && r.prefetchArmed === 0 && r.mismatches.length === 0 && r.wraps >= 3
    && r.presented >= r.regionSpan;
  report('fits-in-budget replays from cache', ok,
    `${r.wraps} wraps, ${r.warningCount} warning(s), ${r.emitsAfterFirstWrap} `
    + `re-decode(s) after loop 1 (want 0), origin prefetch armed ${r.prefetchArmed} `
    + `(want 0), ${r.mismatches.length} pixel mismatch(es), presented ${r.presented} `
    + `frames; budget ${r.cacheBudget} vs span ${r.regionSpan}`
    + (r.warnings.length ? ` — ${r.warnings[0]}` : '')
    + (r.mismatches.length ? ` — e.g. ${JSON.stringify(r.mismatches[0])}` : ''));
} catch (e) {
  report('fits-in-budget replays from cache', false, String(e.message || e));
}

// EXCEEDS: window 4 back / 8 ahead -> budget 21 < the 30-frame clip, so the loop
// origin is cold at every wrap. The restart per wrap must not warn, and every
// frame must still decode to the right pixels. (The origin's BYTES stay resident
// here only because the whole tiny clip fits one read block; the prefetch that
// matters when it does not is the large-clip case below.)
try {
  const r = await measure('windowBack=4&windowAhead=8&playSeconds=12&rate=3');
  const exceeds = r.regionSpan > r.cacheBudget;
  const ok = exceeds && r.warningCount === 0
    && r.mismatches.length === 0 && r.wraps >= 3 && r.presented >= r.regionSpan;
  report('exceeds-budget wraps without a false stall', ok,
    `${r.wraps} wraps, ${r.warningCount} warning(s) (want 0), ${r.mismatches.length} `
    + `pixel mismatch(es), presented ${r.presented} frames; budget ${r.cacheBudget} `
    + `vs span ${r.regionSpan}`
    + (r.warnings.length ? ` — ${r.warnings[0]}` : '')
    + (r.mismatches.length ? ` — e.g. ${JSON.stringify(r.mismatches[0])}` : ''));
} catch (e) {
  report('exceeds-budget wraps without a false stall', false, String(e.message || e));
}

// LARGE: a clip too big to hold in one read block (hd-long.mp4, 30 MB), looped
// over a region that spans several read blocks, so the origin's bytes leave the
// buffer as the playhead reaches the region's end. As the wrap approaches, the
// origin must be prefetched (else the wrap blocks on a read from the start of the
// file). No counter bars here, so exactness is not checked (checkPixels=0).
try {
  const r = await measure('file=hd-long.mp4&loopStart=0&loopEnd=180'
    + '&checkPixels=0&playSeconds=16&rate=3');
  const ok = r.warningCount === 0 && r.prefetchArmed >= 3 && r.wraps >= 4;
  report('large clip prefetches the loop origin', ok,
    `${r.wraps} wraps, ${r.warningCount} warning(s) (want 0), origin prefetch armed `
    + `${r.prefetchArmed} (want >=3), presented ${r.presented} frames`
    + (r.warnings.length ? ` — ${r.warnings[0]}` : ''));
} catch (e) {
  report('large clip prefetches the loop origin', false, String(e.message || e));
}

await browser.close();
process.exit(failures ? 1 : 0);
