// Drives test-stall.html: does playback hold still over a slow link?
//
// The bug this guards: the encoded-byte buffer was a single 4 MB block, and
// refilling it blocked the decode driver for a round trip plus the transfer.
// The dozen decoded frames a 1080p clip can afford under cacheBytes cover a
// fifth of a second of that, so against a bucket a few hundred milliseconds
// away playback held still and then skipped forward once every 4 MB of file.
// And on a link only a few times the clip's bitrate, reads shrank to a 256 KB
// floor whenever the target frame was uncached -- during playback, exactly when
// the engine had fallen behind -- and playback collapsed to a round trip per
// quarter megabyte. Now the next block is prefetched while playing, and reads
// only shrink while landing on a frame (see performance.md).
//
// Nothing else in the suite can see either: every frame is correct whether or
// not it arrived in time, the startup test opens a clip and stops, and localhost
// serves 4 MB in milliseconds. So the clip is served through serve.py's per-
// request latency and rate caps -- not the DevTools protocol's throttling, which
// only Chromium has -- and the page plays it on real animation frames.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install).
import { launchBrowser, serverBase } from './harness.mjs';

// 1080p, so the decoded read-ahead is a handful of frames and the encoded-byte
// prefetch is the only thing covering a read; long enough to cross several block
// boundaries; at a real bitrate, since the freeze period is block size divided
// by bitrate. See make-test-clips.sh.
const FILE = 'hd-long.mp4';
const MINIMUM_FIXTURE_WIDTH = 1920;
const PLAY_SECONDS = 15;

// A bucket a few hundred milliseconds away on an otherwise fast link, and the
// same bucket on a link a few times the clip's bitrate.
const CONDITIONS = [
  { name: '150 ms latency', latencyMilliseconds: 150 },
  { name: '150 ms latency, 4 MB/s', latencyMilliseconds: 150, bytesPerSecond: 4e6 },
];

// The bug is one freeze per 4 MB block, and 15 s of this clip is three to four
// blocks; one is a hiccup from elsewhere (garbage collection, the machine),
// which a suite should not fail on.
const FREEZE_BUDGET = 1;
// The playback read size. A median below it means the reads shrank mid-playback.
const PLAYBACK_READ_KILOBYTES = 4096;
// Frames actually reaching the screen, as a fraction of the frames due. The
// collapse showed 13 of 660 here.
const MINIMUM_PRESENTED_FRACTION = 0.95;

const browser = await launchBrowser();
let failures = 0;

function report(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} stall ${name}: ${detail}`);
}

async function measure(condition) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  const query = new URLSearchParams({ file: FILE, playSeconds: String(PLAY_SECONDS) });
  for (const name of ['latencyMilliseconds', 'bytesPerSecond']) {
    if (condition[name]) query.set(name, String(condition[name]));
  }
  await page.goto(`${serverBase}/test/test-stall.html?${query}`);
  await page.waitForFunction(() => window.__result || window.__err,
    { timeout: (PLAY_SECONDS + 120) * 1000 }).catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();
  if (err || !result) throw new Error(err || 'no result (timed out)');
  return result;
}

for (const condition of CONDITIONS) {
  try {
    const result = await measure(condition);
    if (result.videoWidth < MINIMUM_FIXTURE_WIDTH) {
      report(condition.name, false, `${FILE} is only ${result.videoWidth} wide; the `
        + `read-ahead then covers the reads and this proves nothing`);
      continue;
    }
    const presentedFraction = result.framesPresented / result.framesExpected;
    const ok = result.freezeCount <= FREEZE_BUDGET
      && result.readMedianKilobytes >= PLAYBACK_READ_KILOBYTES
      && presentedFraction >= MINIMUM_PRESENTED_FRACTION;
    report(condition.name, ok,
      `${result.freezeCount} freeze(s) in ${result.playedSeconds}s `
      + `(budget ${FREEZE_BUDGET}; median ${result.freezeMedianMilliseconds} ms, `
      + `${result.freezesOverlappingRead} on a read, ${result.freezesWithRestart} `
      + `with a restart), reads median ${result.readMedianKilobytes} KB `
      + `(want ${PLAYBACK_READ_KILOBYTES}), presented ${result.framesPresented}/`
      + `${result.framesExpected} frames (want ${MINIMUM_PRESENTED_FRACTION * 100}%)`);
    if (!ok) {
      // The first reads say which failure this is: a 4 MB read the driver waited
      // on, or a run of 256 KB ones.
      const SHOWN_READS = 12;
      for (const read of result.reads.slice(0, SHOWN_READS)) {
        console.log(`  read at ${String(read.atMilliseconds).padStart(7)} ms  `
          + `${String(read.durationMilliseconds).padStart(6)} ms  `
          + `${read.startMegabytes.toFixed(2)} MB  ${read.kilobytes} KB`);
      }
      if (result.reads.length > SHOWN_READS) {
        console.log(`  … ${result.reads.length - SHOWN_READS} more read(s)`);
      }
      for (const freeze of result.freezes) {
        console.log(`  freeze at ${String(freeze.startedAt).padStart(7)} ms  `
          + `${freeze.durationMilliseconds} ms, held frame ${freeze.heldFrame}, `
          + `skipped ${freeze.skippedFrames}, fed ${freeze.samplesFed}, `
          + `${(freeze.readBytes / (1 << 20)).toFixed(2)} MB read, `
          + `restart ${freeze.restarted ? 'yes' : 'no'}`);
      }
    }
  } catch (e) {
    report(condition.name, false, e.message);
  }
}

await browser.close();
process.exit(failures ? 1 : 0);
