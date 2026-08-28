// The non-negotiable invariant: when playback PAUSES, the image on screen is the
// frame the clock is paused on — never a stale earlier frame left up because the
// picture was lagging the clock. The whole engine exists to hold this, and the
// frame-dropping/rebuffering clock (VideoEngine.update) is the one addition that
// could break it: while playing, the picture may legitimately lag the clock (a
// frame still decoding, or one dropped because decode fell behind), so a pause
// in that moment must repaint the exact frame under the playhead.
//
// frame-index-test.mjs already proves, pixel by pixel, that `presentedFrame`'s
// IMAGE is always correct for its index — but only across seeks, never after
// playback. This fills that gap with two runs of test-paused-frame.html:
//
//   pixels    counter-cfr.mp4 played and paused repeatedly, with the frame the
//             PIXELS show (visibleFrame, ground truth) checked equal to the
//             clock's frame at every pause. Proves pixel-correct pause-after-play
//             with the new clock code live.
//   dropping  hd-long.mp4 over a link below its bitrate with rebufferSeconds=0,
//             which drops frames so the picture genuinely lags the clock mid-
//             playback; every pause must still settle on presentedFrame ===
//             currentFrame with that frame's bitmap in hand, and at least one
//             pause must have caught the picture still behind (staleBefore) so we
//             know the recovery path was exercised, not just already-correct
//             pauses. hd-long carries no counter bars, so pixels are covered by
//             the pixels run above and presentedFrame's own pixel-correctness by
//             frame-index-test.
//
// Chromium only: this pins the WebCodecs engine's owned clock, not a browser
// decode path. Expects the repo root served at http://localhost:8798.
import { launchBrowser, serverBase } from './harness.mjs';

const browser = await launchBrowser();
let failures = 0;

function report(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} paused-frame ${name}: ${detail}`);
}

async function run(query) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${serverBase}/test/test-paused-frame.html?${new URLSearchParams(query)}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 180000 })
    .catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();
  if (err || !result) throw new Error(err || 'no result (timed out)');
  return result;
}

// --- pixels: pause-after-play shows the exact frame, verified by pixels -------
try {
  const r = await run({ file: 'counter-cfr.mp4', playSeconds: '6',
    pauseEveryTicks: '2', warmupTicks: '2' });
  const mismatches = r.rows.filter((row) => row.presentedFrame !== row.currentFrame
    || row.visible !== row.currentFrame || row.currentFrame < 0);
  const ok = r.rows.length >= 5 && mismatches.length === 0;
  report('pixels match the clock at every pause', ok,
    `${r.rows.length} pauses, ${mismatches.length} mismatched`
    + (mismatches.length ? ` (first: clock ${mismatches[0].currentFrame}, `
      + `presented ${mismatches[0].presentedFrame}, pixels ${mismatches[0].visible})` : ''));
} catch (e) {
  report('pixels match the clock at every pause', false, e.message);
}

// --- dropping: the picture lags the clock, yet every pause recovers the frame -
try {
  // Below the clip's ~8 Mbps (1 MB/s) bitrate, so the bytes cannot keep up
  // whatever the machine's decode speed — the picture reliably lags the clock
  // with rebufferSeconds=0, giving the pause a stale frame to recover from.
  const r = await run({ file: 'hd-long.mp4', playSeconds: '14', rebufferSeconds: '0',
    pauseEveryTicks: '10', warmupTicks: '6',
    latencyMilliseconds: '150', bytesPerSecond: '800000' });
  const unrecovered = r.rows.filter((row) => row.presentedFrame !== row.currentFrame
    || !row.hasBitmap || row.currentFrame < 0);
  const everStale = r.rows.some((row) => row.staleBefore);
  const ok = r.rows.length >= 3 && unrecovered.length === 0 && everStale;
  report('a lagging picture recovers the exact frame on pause', ok,
    `${r.rows.length} pauses, ${unrecovered.length} unrecovered, `
    + `caught-behind ${everStale} (dropped ${r.everDropped})`);
} catch (e) {
  report('a lagging picture recovers the exact frame on pause', false, e.message);
}

await browser.close();
process.exit(failures ? 1 : 0);
