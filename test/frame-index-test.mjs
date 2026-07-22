// Drives test-frame-index.html through the browser named by TEST_BROWSER
// (chromium, webkit, or firefox) and checks, frame by frame, that asking an
// engine for frame n both PUTS frame n on screen and gets frame n reported back.
// Ground truth comes from the pixels (the clips identify each frame by the
// position of a white bar), not from any clock. Each case carries explicit
// per-browser expectations; see the CASES comment for the platform differences.
//
// What is being proved, per container family:
//
// counter-vfr.mp4: the <video> element cannot map a variable-frame-rate clip
// without the container's real timestamp table — the same table WebCodecs
// decodes from. That is why ContainerIndex is built even when WebCodecs is not
// in play.
//
// counter-vfr.webm: the same claim for a container mp4box cannot parse. Passing
// here means the engine's own Matroska scan really did read the frame
// timestamps out of the clusters.
//
// counter-vfr-fragmented.mp4: the same claim for a fragmented MP4, whose sample
// table lives in moof boxes scattered through the file rather than a central
// moov. Passing here means the fragment pass really assembled the per-frame
// table out of the truns.
//
// counter-cfr.ogv: the engine's own Ogg page scan (src/ogg.js). Only walkable
// where the browser still decodes Theora; elsewhere the page reports
// { unplayable: true } and the case is skipped (the parser itself is pinned
// browser-independently by test/ogg-table-test.mjs).
//
// counter-elst.mp4: the element's timeline does not always start at zero. This
// clip's first frame reports mediaTime 0.133, so an engine that assumed the two
// timelines coincided would report every frame number shifted. Passing here
// means the calibration in NativeVideoEngine is genuinely finding the offset,
// not just getting away with a zero one.
//
// There are no approximate cases anymore: a clip the engine cannot index is
// refused at load ("index or refuse", see plan_always_build_an_index.md), which
// robustness-test.mjs pins.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install playwright).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchBrowser, serverBase, browserName } from './harness.mjs';

// firstBar: the bar position of the clip's own frame 0. It is the frame index
// within the SOURCE clip the frames were drawn from, so it is 0 for clips that
// start at the beginning and 10 for counter-elst.mp4, whose head was cut (see
// make-test-clips.sh). Pinning it is what turns "the frames advance one for
// one" into "the frames are the right frames".
// Every case pins TWO things per browser: `exact`, whether all frames land on
// screen and are reported correctly, and `indexExact`, whether the engine kept
// the container's real timestamp table (engine.frameIndexIsExact).
//
// The `chromium` values are the reference. `webkit` and `firefox` inherit them
// unless they name an override, and every override below is a REAL, empirically
// confirmed platform difference, never a loosened assertion:
//
//   * Firefox's requestVideoFrameCallback echoes a SEEK TARGET rather than the
//     landed frame's true presentation timestamp. The engine's runtime index
//     watcher now ignores post-seek presentations (they are not evidence
//     against the table — see _checkPresentedFrame), so Firefox keeps the index
//     and these cases expect full exactness. If a case fails only on Firefox,
//     that suppression has regressed.
//
//   * WebKit fires no requestVideoFrameCallback for a <video> seek that resolves
//     to the frame already on screen. test-frame-index.html primes the element
//     off frame 0 before its loop, which covers the once-per-clip collision at
//     the start, but cases that collide MID-loop (the edit-list clips'
//     calibrated in-frame seeks) would hang the presented-frame wait, so they
//     are skipped with the reason inline; the behaviour they would show is
//     covered by a sibling case that does run on WebKit.
const CASES = [
  { file: 'counter-cfr.mp4', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true },
  { file: 'counter-cfr.mp4', mode: 'native-index', firstBar: 0, exact: true, indexExact: true },

  { file: 'counter-vfr.mp4', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true },
  { file: 'counter-vfr.mp4', mode: 'native-index', firstBar: 0, exact: true, indexExact: true },

  { file: 'counter-elst.mp4', mode: 'webcodecs', firstBar: 10, exact: true, indexExact: true },
  { file: 'counter-elst.mp4', mode: 'native-index', firstBar: 10, exact: true, indexExact: true,
    // Skipped on WebKit: the edit list makes the calibrated first seek land
    // inside the frame the element already presents, and WebKit fires no
    // requestVideoFrameCallback for it, so the wait hangs. The edit-list
    // calibration itself is covered on WebKit via the webcodecs case above
    // (same clip, same firstBar 10).
    webkit: { skip: 'WebKit fires no requestVideoFrameCallback for the edit-list '
      + "clip's calibrated in-frame seek; calibration covered by the webcodecs case" } },

  // A TRIMMING edit list. Unlike counter-elst above (a shifting list that still
  // presents every frame in the file), this clip's container holds all 30 source
  // frames but the edit list presents only 20 of them, starting at source frame 5
  // — mid-group-of-pictures, so the four frames before it are decoded (to
  // reconstruct frame 5) but never shown. The index numbers frames over just the
  // presented window, so display frame 0 IS source frame 5 (firstBar 5) and there
  // are 20 frames. Passing on the pixels proves the trim is applied identically on
  // both engines: the same 20 frames, correctly numbered, whichever path plays.
  { file: 'counter-trimming-elst.mp4', mode: 'webcodecs', firstBar: 5, exact: true, indexExact: true },
  { file: 'counter-trimming-elst.mp4', mode: 'native-index', firstBar: 5, exact: true, indexExact: true,
    // Gecko presents a trimmed clip UNTRIMMED (source frame k where the
    // container's presentation window says k + trim) while reporting the trimmed
    // duration — a whole-frame shift no runtime check can see, empirically
    // confirmed by this very case (all 20 frames landed exactly 5 early). The
    // native engine now refuses that combination up front
    // (index.trimmedByEditList + Gecko), so this case cannot walk frames on
    // Firefox; the webcodecs case above proves the trim frame-exact there.
    firefox: { skip: 'Gecko presents a trimming edit list untrimmed; the native '
      + 'path refuses it (frame numbers would all be shifted by the trim). The '
      + 'trim is proven frame-exact on Firefox by the webcodecs case.' },
    // WebKit runs a trimmed clip's currentTime on the media timeline yet reports
    // the shorter edited duration, so the calibrated timeline overruns what the
    // element will seek to and the engine REFUSES the clip (index-or-refuse; see
    // _calibratedTimelineReachable). The in-frame-seek hang above also applies,
    // so the case is skipped rather than asserted as a refusal here;
    // the trim is proven frame-exact on WebKit by the webcodecs case.
    webkit: { skip: 'WebKit maps a trimmed clip\'s <video> timeline inconsistently '
      + '(media-timeline currentTime, edited duration); the native path refuses it '
      + 'and the in-frame-seek hang applies. The trim is proven frame-exact on '
      + 'WebKit by the webcodecs case.' } },

  // WebM, which mp4box cannot parse at all: these run on the engine's own
  // Matroska cluster scan. The VFR clip is the one an assumed constant frame
  // rate would mismap; it must be exact from the real cluster timestamps.
  { file: 'counter-cfr.webm', mode: 'native-index', firstBar: 0, exact: true, indexExact: true },
  { file: 'counter-vfr.webm', mode: 'native-index', firstBar: 0, exact: true, indexExact: true },
  // Asking for WebCodecs on a WebM: the index has timestamps but no sample table
  // to decode from, so the ladder must fall back to the <video> element and keep
  // the index — exact frames, native tier. (If this ever reports the webcodecs
  // tier, the gate on supportsWebCodecs has stopped working.)
  { file: 'counter-vfr.webm', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true },

  // Fragmented MP4 (empty_moov: every sample lives in a moof fragment, not the
  // moov). The engine detects fragmentation and reads the whole file so every
  // moof's samples are in the table. The constant-rate clip pins the plumbing on
  // both engines; the VARIABLE-rate twin is the real proof — its frames mismap
  // under any assumed constant rate, so exactness means the per-frame timestamps
  // really came out of the truns.
  { file: 'counter-fragmented.mp4', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true },
  { file: 'counter-fragmented.mp4', mode: 'native-index', firstBar: 0, exact: true, indexExact: true },
  { file: 'counter-vfr-fragmented.mp4', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true },
  { file: 'counter-vfr-fragmented.mp4', mode: 'native-index', firstBar: 0, exact: true, indexExact: true },

  // AVI, indexed by the engine's own RIFF parser (src/avi.js). AVI has NO native
  // <video> tier — no browser plays it through a <video> element — so the only
  // mode is 'webcodecs', and the engine's own H.264 decode is what puts pixels on
  // screen. counter-idx1.avi carries the legacy idx1 index; counter-opendml.avi
  // the OpenDML indx/ix00 hierarchical index that the real >2 GB captures use.
  // Both are the 30 counter frames (bar at x = 5n), so exact frames prove the
  // engine read the right byte ranges out of the index and decoded the H.264 the
  // AVI carries. The engine converts AVI's Annex B H.264 to AVCC and configures an
  // avcC description (WebKit's WebCodecs claims to support Annex-B-no-description
  // and then fails the decode — see the decode-support matrix), and AVCC decodes
  // on all three engines, so there is no per-browser override: all three play via
  // the webcodecs tier, exactly like the MP4 H.264 webcodecs cases.
  { file: 'counter-idx1.avi', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true },
  { file: 'counter-opendml.avi', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true },

  // A WebM whose FIRST track entry is audio and whose second is the video (the
  // 30 counter frames). The Matroska cluster scan must skip the audio track and
  // index only the video blocks; an off-by-one that indexed the first track would
  // count audio packets as frames and every mapping here would be wrong. Exact
  // frames prove the scan really keyed on the video track number. firstBar is 0:
  // the video frames are the counter frames, unshifted.
  { file: 'counter-audio-first.webm', mode: 'native-index', firstBar: 0, exact: true, indexExact: true },

  // Ogg/Theora, indexed by the engine's own page scan (src/ogg.js). Only the
  // native path exists for Ogg (no sample table for WebCodecs), and only where
  // the browser still ships a Theora decoder — the page reports
  // { unplayable: true } elsewhere and the case is counted as a skip. The
  // audio-muxed variant additionally proves Vorbis pages are not counted as
  // video frames. Browser-independent parser correctness is pinned by
  // test/ogg-table-test.mjs; what this adds is timeline agreement with a real
  // element's demuxer where one exists.
  { file: 'counter-cfr.ogv', mode: 'native-index', firstBar: 0, exact: true, indexExact: true,
    skipIfUnplayable: true },
  { file: 'counter-vorbis-audio.ogv', mode: 'native-index', firstBar: 0, exact: true, indexExact: true,
    skipIfUnplayable: true },
];

// Resolve a case's expectation for the browser under test: the base (chromium)
// values, overridden by any browser-specific entry. Returns null to signal skip.
function expectationFor(testCase) {
  const override = testCase[browserName] || {};
  if (override.skip) {
    console.log(`SKIP ${testCase.file} ${testCase.mode} on ${browserName}: ${override.skip}`);
    return null;
  }
  return {
    exact: override.exact !== undefined ? override.exact : testCase.exact,
    indexExact: override.indexExact !== undefined ? override.indexExact : testCase.indexExact,
  };
}

const clipsDirectory = join(dirname(fileURLToPath(import.meta.url)), 'clips');

const browser = await launchBrowser();
let failures = 0;

async function runCase(file, mode) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${serverBase}/test/test-frame-index.html?file=${file}&mode=${mode}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 60000 })
    .catch(() => {});
  const outcome = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();
  return outcome;
}

// A load-time race in NativeVideoEngine (not specific to this test matrix, and
// present before it) can make an edit-list clip's duration read transiently
// wrong right after 'loadeddata' on Chromium. The engine now waits for the
// duration to settle before judging the index (see _indexDescribesElement), but
// a genuinely slow settle can still lose the race, and under index-or-refuse
// that surfaces as a load refusal rather than a fallback. It resolves one way
// or the other per load, so a case that unexpectedly refused gets a fresh roll
// by reloading. We retry ONLY that signature — expected a walk, got a refusal
// or a dropped index — so a real regression still fails every attempt.
const MAX_ATTEMPTS = 4;
async function runCaseExpectingIndex(file, mode, wantIndex) {
  let outcome = await runCase(file, mode);
  let attempts = 1;
  while (wantIndex && attempts < MAX_ATTEMPTS
      && ((outcome.result && outcome.result.frameIndexIsExact === false) || outcome.err)) {
    attempts += 1;
    outcome = await runCase(file, mode);
  }
  return outcome;
}

for (const testCase of CASES) {
  const { file, mode, firstBar } = testCase;
  const expectation = expectationFor(testCase);
  if (!expectation) continue;   // skipped on this browser, with a reason printed

  // A fixture that could not be generated on this machine (no Theora encoder
  // anywhere — see make-test-clips.sh) is a skip, not a failure.
  if (!existsSync(join(clipsDirectory, file))) {
    console.log(`SKIP ${file} ${mode}: fixture not generated on this machine`);
    continue;
  }

  const { result, err } = await runCaseExpectingIndex(file, mode, expectation.indexExact);

  if (result && result.unplayable) {
    if (testCase.skipIfUnplayable) {
      console.log(`SKIP ${file} ${mode}: ${browserName} cannot decode ${result.mime}`);
    } else {
      console.log(`FAIL ${file} ${mode}: ${browserName} reports ${result.mime} unplayable`);
      failures += 1;
    }
    continue;
  }

  if (err || !result) {
    console.log(`FAIL ${file} ${mode}: ${err || 'no result (timed out)'}`);
    failures += 1;
    continue;
  }

  const wrongPixels = result.rows.filter((r) => r.visible !== r.asked + firstBar);
  const wrongReports = result.rows.filter((r) => r.reported !== r.asked);
  const exact = wrongPixels.length === 0 && wrongReports.length === 0;
  const exactOk = exact === expectation.exact;
  const indexOk = result.frameIndexIsExact === expectation.indexExact;
  const pass = exactOk && indexOk;
  if (!pass) failures += 1;

  const count = result.rows.length;
  const detail = exact
    ? `all ${count} frames exact`
    : `${wrongPixels.length}/${count} wrong frame on screen, `
      + `${wrongReports.length}/${count} misreported`;
  const mismatch = indexOk ? ''
    : ` — frameIndexIsExact=${result.frameIndexIsExact}, expected ${expectation.indexExact}`;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${file} ${mode}: ${detail}`
    + ` [${result.tier}, frameIndexIsExact=${result.frameIndexIsExact}]${mismatch}`);

  if (!exactOk) {
    const show = (expectation.exact ? [...wrongPixels, ...wrongReports] : result.rows).slice(0, 6);
    for (const r of show) {
      console.log(`       asked ${r.asked} -> on screen `
        + `${r.visible - firstBar} (bar ${r.visible}), reported ${r.reported}`);
    }
  }
}

await browser.close();
process.exit(failures ? 1 : 0);
