// Drives test-declared-rate.html to prove createBestEngine's guarantee-or-bail
// behavior for clips with no usable container index (sharp corner #5): a clip
// that cannot be indexed is played frame-exact only if it comes with a
// declaredFrameRate that SURVIVES verification against the real frame timestamps,
// and otherwise bails rather than reporting silently-guessed frame numbers.
//
// The verification math is guaranteed exhaustively by the Node unit test
// frame-rate-check-test.mjs. What THIS test adds is the real-browser wiring: that
// the seek-probe drives actual paused seeks, reads requestVideoFrameCallback
// timestamps, and lets a wrong rate throw out of load(). It forces the
// declared-rate path with index:null so it can reuse the constant- and
// variable-frame-rate counter clips instead of needing a real un-indexable
// container; the path under test is identical either way (the native engine never
// sees where the missing index went).
//
// Chromium-only: the seek-probe is engine bookkeeping over a standard
// <video>/rVFC surface, not a decode-path difference, so one engine exercises it
// fully — the same rationale as the other chromium-only drivers.
//
// Expects the repo root served at http://localhost:8798 and Playwright.
import { chromium } from 'playwright';
import { serverBase } from './harness.mjs';

const browser = await chromium.launch();
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} declared-rate ${name}: ${detail}`);
}

async function load(query) {
  const page = await browser.newPage();
  const lines = [];
  page.on('console', (msg) => lines.push(msg.text()));
  page.on('pageerror', (e) => lines.push('PAGEERROR ' + e.message));
  await page.goto(`${serverBase}/test/test-declared-rate.html?${query}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 30000 })
    .catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();
  return { result: result || {}, err };
}

// --- a truly constant-rate clip, declared correctly: plays, verification passes -
const cfrOk = await load('file=counter-cfr.mp4&forceNoIndex=1&declaredFrameRate=30');
check('CFR clip declared at its real 30 fps loads (probe passes)',
  cfrOk.result.loaded === true && cfrOk.result.error === null,
  `loaded=${cfrOk.result.loaded}, error=${cfrOk.result.error}`);
check('a declared-rate clip is honestly NOT marked frame-exact',
  cfrOk.result.frameIndexIsExact === false && cfrOk.result.frameMappingInexact === false,
  `frameIndexIsExact=${cfrOk.result.frameIndexIsExact}, `
    + `frameMappingInexact=${cfrOk.result.frameMappingInexact}`);

// --- the same clip declared at DOUBLE its rate: phantom frames disprove it ------
// A 60 fps grid expects a frame at 1/60 s that a 30 fps clip does not have, so a
// spacing probe lands a frame short and load() throws.
const doubled = await load('file=counter-cfr.mp4&forceNoIndex=1&declaredFrameRate=60');
check('30 fps clip declared as 60 fps is rejected (phantom frames)',
  doubled.result.loaded === false && /inconsistent|variable-frame-rate|declared rate/.test(doubled.result.error || ''),
  `error=${doubled.result.error}`);

// --- a genuinely variable clip declared as constant: rejected ------------------
// counter-vfr holds every 5th frame for 66 ms; declared at 30 fps the dropped
// slots accumulate and the late/end probes land well off the grid.
const vfr = await load('file=counter-vfr.mp4&forceNoIndex=1&declaredFrameRate=30');
check('variable-frame-rate clip declared as constant 30 fps is rejected',
  vfr.result.loaded === false && /inconsistent|variable-frame-rate|declared rate/.test(vfr.result.error || ''),
  `error=${vfr.result.error}`);

// --- allowApproximate opts out: the same VFR clip plays best-effort ------------
const vfrAllowed = await load(
  'file=counter-vfr.mp4&forceNoIndex=1&declaredFrameRate=30&allowApproximate=1');
check('allowApproximate lets the VFR clip play without verification',
  vfrAllowed.result.loaded === true && vfrAllowed.result.error === null,
  `loaded=${vfrAllowed.result.loaded}, error=${vfrAllowed.result.error}`);

// --- no index and no rate: bail rather than guess ------------------------------
const bail = await load('file=counter-cfr.mp4&forceNoIndex=1');
check('an unindexable clip with no declaredFrameRate bails',
  bail.result.loaded === false && /could not be indexed|declaredFrameRate/.test(bail.result.error || ''),
  `error=${bail.result.error}`);

// --- allowApproximate lets even that play best-effort --------------------------
const bailAllowed = await load('file=counter-cfr.mp4&forceNoIndex=1&allowApproximate=1');
check('allowApproximate lets an unindexable, rate-less clip play best-effort',
  bailAllowed.result.loaded === true && bailAllowed.result.error === null,
  `loaded=${bailAllowed.result.loaded}, error=${bailAllowed.result.error}`);

// --- the real WebM index-timeout path (sharp corner #4) ------------------------
// indexTimeoutMs=0 makes the Matroska scan give up, so the clip reaches the
// declared-rate path exactly as a big WebM on a slow link would. A CONSTANT-rate
// WebM then plays (the declared rate is right); the VARIABLE-rate twin bails
// rather than silently mismap.
const cfrWebmTimeout = await load(
  'file=counter-cfr.webm&indexTimeoutMs=0&declaredFrameRate=30');
check('CFR WebM whose index times out plays via the declared rate',
  cfrWebmTimeout.result.loaded === true && cfrWebmTimeout.result.frameIndexIsExact === false,
  `loaded=${cfrWebmTimeout.result.loaded}, error=${cfrWebmTimeout.result.error}`);

const vfrWebmTimeout = await load(
  'file=counter-vfr.webm&indexTimeoutMs=0&declaredFrameRate=30');
check('VFR WebM whose index times out bails rather than mismap',
  vfrWebmTimeout.result.loaded === false
    && /inconsistent|variable-frame-rate|declared rate/.test(vfrWebmTimeout.result.error || ''),
  `error=${vfrWebmTimeout.result.error}`);

await browser.close();
process.exit(failures ? 1 : 0);
