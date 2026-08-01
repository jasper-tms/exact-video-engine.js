// Drives test-sync-benchmark.html across a matrix of clip sizes and engine
// counts and prints the numbers that decide whether exact synchronized
// multi-video playback is feasible in the annotator with no engine change.
//
// Not part of run-tests.sh — an investigation tool. Expects the repo root
// served at http://localhost:8798 (this script starts serve.py itself) and
// Playwright (npm install).
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

// This driver runs its own server so it works standalone. Inside run-tests.sh
// the shared server already holds TEST_PORT (default 8798), so take the next
// port up — distinct from that one, and still unique per checkout when two run
// their suites at once with different TEST_PORT values.
const PORT = (Number(process.env.TEST_PORT) || 8798) + 1;
const BASE = `http://localhost:${PORT}`;

const MATRIX = [
  { file: 'counter-cfr.mp4', engines: 2 },   // tiny, exactness-checked
  { file: 'counter-cfr.mp4', engines: 3 },
  { file: 'midsize.mp4', engines: 2 },       // 320x180
  { file: 'midsize.mp4', engines: 3 },
  { file: 'midsize.mp4', engines: 4 },
  { file: 'hd.mp4', engines: 2 },            // 1920x1080 — the real stress
  { file: 'hd.mp4', engines: 3 },
  { file: 'hd.mp4', engines: 4 },
];

const server = spawn('python3', ['test/serve.py', String(PORT)], {
  stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 800));

const browser = await chromium.launch();
let failures = 0;
try {
  for (const config of MATRIX) {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.log('  pageerror:', error.message));
    const url = `${BASE}/test/test-sync-benchmark.html`
      + `?file=${config.file}&engines=${config.engines}`;
    await page.goto(url);
    await page.waitForFunction(() => window.__result || window.__err, { timeout: 120000 })
      .catch(() => {});
    const { result, err } = await page.evaluate(
      () => ({ result: window.__result, err: window.__err }));
    await page.close();

    const label = `${config.file} x${config.engines}`;
    if (err || !result) {
      console.log(`\n${label}: FAILED — ${err || 'no result (timed out)'}`);
      failures += 1;
      continue;
    }

    const a = result.asFastAsExact;
    const b = result.realTime;
    console.log(`\n${label}  [${result.tier}, ${result.width}x${result.height}, `
      + `${result.fps}fps native, ${result.numFrames} frames]`);
    console.log(`  as-fast-as-exact : ${a.compositeFps} composite fps  `
      + `(${a.meanTicksPerFrame} mean ticks/frame, ${a.maxTicksPerFrame} max)  `
      + `sustains real-time: ${a.sustainsRealtime ? 'YES' : 'NO'}`);
    console.log(`  real-time drop   : ${(b.stallFraction * 100).toFixed(1)}% ticks held, `
      + `${b.droppedFrames}/${b.targetFramesSeen} frames dropped `
      + `(${(b.droppedFraction * 100).toFixed(1)}%), `
      + `max consecutive hold ${b.maxConsecutiveStall} ticks`);
    // Regression gate, deliberately loose so machine speed never flakes it. A
    // forward step should cost ~1 tick because seekToFrame(currentFrame+1) reuses
    // the warm decode pipeline (same-GOP, read-ahead cache); if that property
    // broke — e.g. seekToFrame started flushing every call — ticks/frame would
    // blow past this. Observed on real runs is ~1.0, even at four 1080p engines.
    const TICKS_PER_FRAME_CEILING = 3;
    if (a.meanTicksPerFrame > TICKS_PER_FRAME_CEILING) {
      failures += 1;
      console.log(`  forward-seek     : FAIL — ${a.meanTicksPerFrame} mean ticks/frame `
        + `exceeds ${TICKS_PER_FRAME_CEILING}; a forward-by-one seek is no longer cheap`);
    }
    if (result.exactness) {
      const { checked, mismatches } = result.exactness;
      if (mismatches.length === 0) {
        console.log(`  exactness        : PASS — every engine showed the exact `
          + `target frame at all ${checked} sampled composites`);
      } else {
        failures += 1;
        console.log(`  exactness        : FAIL — ${JSON.stringify(mismatches)}`);
      }
    }
  }
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${failures ? `${failures} config(s) had failures` : 'all configs completed'}`);
process.exit(failures ? 1 : 0);
