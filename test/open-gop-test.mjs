// A cold seek must land on every frame of an OPEN-GOP clip — the shape of every
// iPhone HEVC video, where each keyframe after the first is a recovery point
// followed in decode order by "leading" frames that display before it and
// predict from the previous group of pictures. A decode run started at that
// keyframe cannot produce them: the decoder drops them by design. Before the
// engine learned to start such a run one group further back, seeking straight
// to a leading frame left the picture on the previous frame forever ("cannot
// decode frame N; holding"), while playing through the same frame worked.
//
// Blink adds a second constraint: its H.264 decoder cannot begin a run at a
// recovery point at all (a non-IDR I frame), only at an IDR frame, so there the
// run must step back to the nearest IDR frame — and no further.
//
// Drives test-open-gop.html on counter-open-gop.mp4 (IDR frames at display
// frames 0 and 10, a recovery point at 20, and frame 19 leading it; see
// make-test-clips.sh), which builds a fresh engine per frame and seeks straight
// to it, then checks the bar the PIXELS show and where the decode run began.
// Only the WebCodecs tier owns the decode run, so that is the tier pinned here;
// every browser under test decodes this H.264 clip there.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install).
import { launchBrowser, serverBase, browserName } from './harness.mjs';

const LEADING_FRAMES = [19];
// Where a cold seek to frame 25 must begin its decode run: the recovery point at
// 20 where a run may start there, else the IDR frame at 10 (Blink).
const EXPECTED_RUN_START_FOR_FRAME_25 = browserName === 'chromium' ? 10 : 20;

const browser = await launchBrowser();
const page = await browser.newPage();
page.on('pageerror', (error) => console.log('pageerror:', error.message));
await page.goto(`${serverBase}/test/test-open-gop.html?prefer=webcodecs`);
await page.waitForFunction(() => window.__result || window.__err, { timeout: 300000 })
  .catch(() => {});
const { result, err } = await page.evaluate(
  () => ({ result: window.__result, err: window.__err }));
await browser.close();

let failures = 0;
function report(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} open-gop [${browserName}] ${name}: ${detail}`);
}

if (err || !result) {
  report('cold seeks', false, err || 'no result (timed out)');
} else {
  report('runs on the WebCodecs tier', result.tier === 'webcodecs', `tier ${result.tier}`);
  const wrong = result.rows.filter((row) => !row.decoded || row.visible !== row.frame);
  report('every frame shows after a cold seek to it', wrong.length === 0,
    `${result.rows.length} frames, ${wrong.length} wrong`
    + (wrong.length ? ` (${wrong.map((row) => row.decoded
      ? `${row.frame} showed ${row.visible}` : `${row.frame} never decoded`).join(', ')})` : ''));
  const frame25 = result.rows.find((row) => row.frame === 25);
  report('a run steps back only as far as it must',
    frame25?.runStartFrame === EXPECTED_RUN_START_FOR_FRAME_25,
    `cold seek to 25 began its run at frame ${frame25?.runStartFrame}, `
    + `expected ${EXPECTED_RUN_START_FOR_FRAME_25}`);
  // The clip must still have the shape under test, or the check above passes
  // without testing anything.
  report('fixture has leading frames where expected',
    JSON.stringify(result.leadingFrames) === JSON.stringify(LEADING_FRAMES),
    `leading frames ${JSON.stringify(result.leadingFrames)}, `
    + `expected ${JSON.stringify(LEADING_FRAMES)}`);
}

process.exit(failures ? 1 : 0);
