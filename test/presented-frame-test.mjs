// Drives test-presented-frame.html through the browser named by TEST_BROWSER
// and checks that `presentedFrame` genuinely tracks the pixels on screen,
// distinctly from `currentFrame` where the two tiers differ. See the harness
// page's own comment for the full rationale.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install).
import { launchBrowser, serverBase } from './harness.mjs';

const CASES = [
  { mode: 'webcodecs' },
  { mode: 'native' },
];

const browser = await launchBrowser();
let failures = 0;

for (const { mode } of CASES) {
  const file = 'counter-cfr.mp4';
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${serverBase}/test/test-presented-frame.html?file=${file}&mode=${mode}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 60000 })
    .catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();

  if (err || !result) {
    console.log(`FAIL presented-frame ${mode}: ${err || 'no result (timed out)'}`);
    failures += 1;
    continue;
  }

  const problems = [];
  const { baselineFrame, targetFrame, immediatelyAfterSeek, afterWaiting } = result;

  // Right after the seek, before anything waited for it: presentedFrame must
  // not have jumped to the target yet on either tier.
  if (immediatelyAfterSeek.presentedFrame !== baselineFrame) {
    problems.push(`presentedFrame read ${immediatelyAfterSeek.presentedFrame} immediately `
      + `after seeking to ${targetFrame}, expected it to still read the baseline `
      + `frame ${baselineFrame} until the seek actually lands`);
  }
  // The WebCodecs tier's currentFrame is the raw playhead target and moves the
  // instant seekToFrame is called. The native tier's currentFrame is clamped to
  // the hold interval [presented, presented + 1] of the frame actually on
  // screen (see NativeVideoEngine.currentFrameFloat) — a forward seek past that
  // interval lands on its upper edge, one past the still-presented baseline,
  // rather than jumping to the target the way WebCodecs does.
  const expectedImmediateCurrentFrame = (result.tier === 'webcodecs')
    ? targetFrame : baselineFrame + 1;
  if (immediatelyAfterSeek.currentFrame !== expectedImmediateCurrentFrame) {
    problems.push(`currentFrame read ${immediatelyAfterSeek.currentFrame} immediately after `
      + `seeking, expected ${expectedImmediateCurrentFrame} for tier ${result.tier}`);
  }

  // Once actually waited for: both properties, and the real pixels, must
  // agree on the target frame.
  if (afterWaiting.presentedFrame !== targetFrame) {
    problems.push(`presentedFrame ${afterWaiting.presentedFrame} after waiting, expected ${targetFrame}`);
  }
  if (afterWaiting.currentFrame !== targetFrame) {
    problems.push(`currentFrame ${afterWaiting.currentFrame} after waiting, expected ${targetFrame}`);
  }
  if (afterWaiting.visible !== targetFrame) {
    problems.push(`frame ${afterWaiting.visible} visible on screen after waiting, expected ${targetFrame}`);
  }

  if (problems.length) {
    failures += 1;
    console.log(`FAIL presented-frame ${mode} [${result.tier}]: ${problems.join('; ')}`);
  } else {
    console.log(`PASS presented-frame ${mode} [${result.tier}]: presentedFrame lagged through the `
      + `stall and caught up to frame ${afterWaiting.presentedFrame} on screen`);
  }
}

await browser.close();
process.exit(failures ? 1 : 0);
