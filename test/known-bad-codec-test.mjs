// Drives test-known-bad-codec.html to prove createBestEngine's PROACTIVE routing
// wiring: on a browser whose WebCodecs is known to accept a codec and then die
// mid-stream (WebKit + 10-bit HEVC), the ladder must route straight to the native
// <video> element BEFORE attempting WebCodecs, so the user never sees the crash.
//
// The decision logic itself (which codec/engine pairs are unsafe) is guaranteed
// exhaustively by the Node unit test decode-support-test.mjs. What THIS test adds
// is the wiring: that createBestEngine actually consults it, keyed on
// navigator.vendor, and skips the WebCodecs engine when it fires. It runs on
// Chromium and spoofs navigator.vendor to stand in for WebKit, so it needs no
// WebKit build and no real 10-bit-HEVC decode support — the routing decision is
// made from the container's declared codec string, which mp4box reads without
// decoding. The observable signal is the one console line createBestEngine emits
// only on the proactive-route path.
//
// Expects the repo root served at http://localhost:8798 and Playwright.
import { chromium } from 'playwright';
import { serverBase } from './harness.mjs';

const ROUTE_SIGNATURE = 'routing this clip to the native';
const CLIP = 'counter-hevc10.mp4';

const browser = await chromium.launch();
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} known-bad-codec ${name}: ${detail}`);
}

// Load the 10-bit HEVC clip with navigator.vendor optionally spoofed, and report
// both what the page saw and whether createBestEngine emitted its proactive-route
// console line.
async function load(spoofVendor) {
  const page = await browser.newPage();
  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(msg.text()));
  page.on('pageerror', (e) => consoleLines.push('PAGEERROR ' + e.message));
  const query = `file=${CLIP}` + (spoofVendor ? `&spoofVendor=${spoofVendor}` : '');
  await page.goto(`${serverBase}/test/test-known-bad-codec.html?${query}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 30000 })
    .catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();
  return { result, err, routed: consoleLines.some((l) => l.includes(ROUTE_SIGNATURE)) };
}

// --- WebKit (spoofed): the clip must be routed away from WebCodecs up front ----
const webkitRun = await load('webkit');
check('the vendor spoof is seen as webkit',
  webkitRun.result && webkitRun.result.detectedEngine === 'webkit',
  webkitRun.result ? webkitRun.result.detectedEngine : `no result (err: ${webkitRun.err})`);
check('WebKit + 10-bit HEVC is routed straight to native (no mid-stream crash)',
  webkitRun.routed === true,
  webkitRun.routed ? 'proactive-route console line emitted' : 'engine did NOT route around WebCodecs');
// If the native <video> could actually decode HEVC in this browser, the engine
// loaded natively AND stayed frame-exact (the index is codec-agnostic). Chromium
// ships without HEVC, so this commonly does not load — which is fine: the routing
// decision, the thing under test, already happened. Only assert when it loaded.
if (webkitRun.result && webkitRun.result.loaded) {
  check('routed engine is the native one, still frame-exact',
    /native/.test(webkitRun.result.tier) && webkitRun.result.frameIndexIsExact === true,
    `tier='${webkitRun.result.tier}', frameIndexIsExact=${webkitRun.result.frameIndexIsExact}`);
} else {
  console.log(`INFO known-bad-codec: native HEVC not decodable in this browser `
    + `(error: ${webkitRun.result && webkitRun.result.error}); routing already verified above`);
}

// --- Blink (real vendor): the SAME clip must NOT be routed away ----------------
// Chromium decodes 10-bit HEVC in WebCodecs fine, so routing it away would need-
// lessly cost the owned-clock path. The proactive-route line must not appear.
const blinkRun = await load(null);
check('the real vendor is seen as blink (control)',
  blinkRun.result && blinkRun.result.detectedEngine === 'blink',
  blinkRun.result ? blinkRun.result.detectedEngine : `no result (err: ${blinkRun.err})`);
check('Chromium + 10-bit HEVC is NOT routed away (WebCodecs handles it)',
  blinkRun.routed === false,
  blinkRun.routed ? 'engine wrongly routed a Chromium clip away from WebCodecs'
    : 'no proactive-route line, as expected');

await browser.close();
process.exit(failures ? 1 : 0);
