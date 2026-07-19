// Drives test-robustness.html through headless Chromium to pin the engine's
// CURRENT behavior on input classes that upcoming feature work will touch:
// a trimming edit list, a fragmented MP4, and four malformed/truncated files.
//
// Two kinds of pin live here.
//
//   1. Graceful degradation with HONEST signals. A trimming edit list and a
//      fragmented MP4 both load and play; what matters is that tier and
//      frameIndexIsExact tell the truth about how exact the frame numbers are, so
//      a host (an annotation tool, say) knows whether it may trust them. When the
//      edit-list and fragmented-MP4 features land they will deliberately change
//      some of these expectations — the cases marked WILL-CHANGE flag which.
//
//   2. SOFT failure on malformed bytes. A corrupt or truncated file must settle
//      in bounded time, never crash the page (no uncaught error), and end in
//      either a human-readable error the host can show or a graceful fallback —
//      never a hang. That contract is what the corrupt cases assert, without
//      pinning the exact wording, so a defensible change to the error text does
//      not fail the suite but a hang or a page crash does.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install playwright).
import { launchBrowser, serverBase } from './harness.mjs';

// Anything slower than this is treated as a hang: every path here is a handful
// of range reads over localhost, so a real answer arrives in well under a second
// and the only way to spend ten is to be stuck.
const SETTLE_BUDGET_MILLISECONDS = 10000;

const CASES = [
  // --- Graceful degradation, honest signals --------------------------------

  // Trimming edit list, native path: the container sample table spans 30 frames
  // but the element presents a 20-frame window starting mid-group-of-pictures.
  // NativeVideoEngine._indexDescribesElement must REFUSE that index (it cannot be
  // trusted without shifting every frame number) and fall back to the declared
  // frame rate, saying so through both a console.warn and frameIndexIsExact
  // going false. This is the whole reason the duration check exists.
  {
    name: 'trimming edit list refused (native)',
    file: 'counter-trimming-elst.mp4', mode: 'native',
    expect: {
      loaded: true, frameReachable: true, frameIndexIsExact: false,
      tierIncludes: 'declared frame rate', warningIncludes: 'trimming edit list',
    },
  },
  // Trimming edit list, WebCodecs path: the decoder reads the sample table and
  // IGNORES the edit list entirely, so it decodes all 30 source frames from frame
  // 0 and reports them as exact. That is not what the trim asks for, but it is
  // today's behavior. CURRENT-BEHAVIOR-WILL-CHANGE: applying edit lists in the
  // WebCodecs path is planned, and when it lands this clip should present the
  // trimmed 20-frame window and numFrames should drop to 20.
  {
    name: 'trimming edit list ignored by WebCodecs (WILL-CHANGE)',
    file: 'counter-trimming-elst.mp4', mode: 'auto',
    expect: {
      loaded: true, frameReachable: true, frameIndexIsExact: true,
      tierIncludes: 'webcodecs', numFrames: 30,
    },
  },
  // Fragmented MP4 (empty_moov: samples live in moof fragments). mp4box.js
  // reassembles the fragments' sample table when it can read the whole file, so
  // today this small clip is indexed as fully as an unfragmented one and decodes
  // on WebCodecs, exact. Pinning webcodecs + exact + 30 frames is what would
  // catch fragmented-MP4 feature work regressing the small-file path that already
  // works. (frame-index-test.mjs additionally proves the frames are pixel-exact.)
  {
    name: 'fragmented MP4 indexes fully today',
    file: 'counter-fragmented.mp4', mode: 'auto',
    expect: {
      loaded: true, frameReachable: true, frameIndexIsExact: true,
      tierIncludes: 'webcodecs', numFrames: 30,
    },
  },

  // --- Soft failure on malformed input -------------------------------------
  // Each of these must settle in bounded time, raise no page error, and end
  // either loaded (graceful fallback) or with a human-readable error. The exact
  // outcome observed today is noted, but only { soft: true } is asserted so the
  // pin survives a defensible change in wording while still catching a hang or a
  // page crash.

  // A WebM truncated partway through its clusters. Today the partial Matroska
  // scan builds an index for only the frames it could read; that index's duration
  // falls short of the element's, so it is refused (the same duration check the
  // trimming edit list trips) and the clip plays on the element at the declared
  // frame rate — loaded, frameIndexIsExact false.
  { name: 'WebM truncated mid-cluster', file: 'corrupt-webm-truncated-cluster.webm', mode: 'auto', expect: { soft: true } },
  // EBML magic then noise: announces itself as Matroska, then has no usable
  // element tree. The index build fails, the element cannot play noise, and the
  // load rejects with a human-readable message.
  { name: 'EBML magic then garbage', file: 'corrupt-ebml-magic-then-garbage.webm', mode: 'auto', expect: { soft: true } },
  // Intact front moov, truncated mdat: the index parses cleanly but the frame
  // bytes are past end-of-file, so decoding fails and the load rejects.
  { name: 'MP4 with intact moov, truncated mdat', file: 'corrupt-mp4-truncated-mdat.mp4', mode: 'auto', expect: { soft: true } },
  // Pure noise, no container magic: nothing to index and nothing the element can
  // play, so the load rejects with a human-readable message.
  { name: 'pure garbage, no magic', file: 'corrupt-pure-garbage.bin', mode: 'auto', expect: { soft: true } },
];

const browser = await launchBrowser();
let failures = 0;

for (const { name, file, mode, expect } of CASES) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const startedAt = Date.now();
  await page.goto(`${serverBase}/test/test-robustness.html?file=${file}&mode=${mode}`);
  const settled = await page
    .waitForFunction(() => window.__result || window.__err, { timeout: SETTLE_BUDGET_MILLISECONDS })
    .then(() => true).catch(() => false);
  const elapsed = Date.now() - startedAt;
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();

  const problems = [];

  // A hang shows up as never settling; catch it before anything else, because it
  // is the single worst outcome for a malformed input.
  if (!settled) problems.push(`did not settle within ${SETTLE_BUDGET_MILLISECONDS}ms (hang?)`);
  if (err) problems.push(`test harness threw: ${err}`);
  if (pageErrors.length) problems.push(`uncaught page error(s): ${pageErrors.join(' | ')}`);
  if (settled && !err && !result) problems.push('settled but produced no result');

  if (result) {
    if (expect.soft) {
      // Soft = ended in a human-readable error OR a graceful load; either is
      // acceptable, a silent no-op is not.
      const softlyHandled = result.loaded === true
        || (typeof result.error === 'string' && result.error.length > 0);
      if (!softlyHandled) {
        problems.push('neither loaded nor produced a human-readable error');
      }
      if (result.loaded && !result.frameReachable) {
        problems.push('loaded but no frame was reachable');
      }
    } else {
      if (expect.loaded !== undefined && result.loaded !== expect.loaded) {
        problems.push(`loaded=${result.loaded}, wanted ${expect.loaded} (error: ${result.error})`);
      }
      if (expect.frameReachable !== undefined && result.frameReachable !== expect.frameReachable) {
        problems.push(`frameReachable=${result.frameReachable}, wanted ${expect.frameReachable}`);
      }
      if (expect.frameIndexIsExact !== undefined && result.frameIndexIsExact !== expect.frameIndexIsExact) {
        problems.push(`frameIndexIsExact=${result.frameIndexIsExact}, wanted ${expect.frameIndexIsExact}`);
      }
      if (expect.numFrames !== undefined && result.numFrames !== expect.numFrames) {
        problems.push(`numFrames=${result.numFrames}, wanted ${expect.numFrames}`);
      }
      if (expect.tierIncludes && !(result.tier || '').includes(expect.tierIncludes)) {
        problems.push(`tier '${result.tier}' does not include '${expect.tierIncludes}'`);
      }
      if (expect.warningIncludes
          && !result.warnings.some((w) => w.includes(expect.warningIncludes))) {
        problems.push(`no warning included '${expect.warningIncludes}' `
          + `(warnings: ${JSON.stringify(result.warnings)})`);
      }
    }
    // Bounded time applies to every case, however it resolved.
    if (result.elapsedMilliseconds > SETTLE_BUDGET_MILLISECONDS) {
      problems.push(`took ${result.elapsedMilliseconds.toFixed(0)}ms in-page`);
    }
  }

  const outcome = result
    ? (result.loaded
        ? `loaded [${result.tier}, exact=${result.frameIndexIsExact}, ${result.numFrames} frames]`
        : `refused: "${result.error}"`)
    : '(no result)';
  if (problems.length) {
    failures += 1;
    console.log(`FAIL ${name}: ${problems.join('; ')}`);
  } else {
    console.log(`PASS ${name}: ${outcome} in ${elapsed}ms`);
  }
}

await browser.close();
process.exit(failures ? 1 : 0);
