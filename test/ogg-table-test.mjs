// Unit test for the Ogg/Theora frame table (src/ogg.js). Runs in plain Node —
// the page scan needs no browser — against the generated counter-cfr.ogv
// fixture, whose ground truth is fully known: 30 Theora frames at exactly 30
// frames per second, picture 150x90 (make-test-clips.sh).
//
// Browsers are dropping Theora decoders, so the frame-index browser walk may
// skip Ogg everywhere; this test is what pins the parser's correctness
// regardless. It checks the table itself (frame count, exact 1/30-second
// spacing, dimensions), the budget contract (an out-of-time pass throws
// IndexBudgetExceededError, never hangs), the progress reports, the multiplexed
// case (Vorbis audio pages must not be counted as video frames), and the
// ContainerIndex routing (the "OggS" magic reaches the Ogg parser and the
// normalized index looks like the Matroska-built ones).
//
// If the fixtures are absent (no ffmpeg with libtheora on this machine — see
// make-test-clips.sh), the test skips rather than fails.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readOggFrameTable } from '../src/ogg.js';
import { IndexBudgetExceededError } from '../src/matroska.js';
import { ContainerIndex } from '../src/container-index.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLIP = join(here, 'clips', 'counter-cfr.ogv');
const CLIP_WITH_AUDIO = join(here, 'clips', 'counter-vorbis-audio.ogv');
const EXPECTED_FRAMES = 30;
const EXPECTED_FRAME_DURATION = 1 / 30;

if (!existsSync(CLIP)) {
  console.log('SKIP ogg-table: fixtures not generated on this machine '
    + '(no ffmpeg with libtheora; see make-test-clips.sh)');
  process.exit(0);
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ogg-table ${name}: ${detail}`);
}

// Matches the range-reader contract in range-readers.js: a .size, an async
// .init(), and .read(start, endInclusive) -> ArrayBuffer.
class MemoryRangeReader {
  constructor(bytes) { this.bytes = bytes; this.size = bytes.length; }
  async init() {}
  async read(start, endInclusive) {
    return this.bytes.slice(start, endInclusive + 1).buffer;
  }
}

const bytes = new Uint8Array(await readFile(CLIP));

// --- the table itself --------------------------------------------------------
const table = await readOggFrameTable(new MemoryRangeReader(bytes));
check('frame count', table.presentationTimes.length === EXPECTED_FRAMES,
  `${table.presentationTimes.length} frames (want ${EXPECTED_FRAMES})`);
check('dimensions', table.videoWidth === 150 && table.videoHeight === 90,
  `${table.videoWidth}x${table.videoHeight}`);
check('declared frame duration',
  Math.abs(table.defaultFrameDuration - EXPECTED_FRAME_DURATION) < 1e-12,
  `${table.defaultFrameDuration} (want ${EXPECTED_FRAME_DURATION})`);

// Theora's timestamps are an exact rational (frameIndex * FRD / FRN), so the
// comparison is essentially exact — the tolerance only absorbs float division.
const timesExact = table.presentationTimes.every((t, n) =>
  Math.abs(t - n * EXPECTED_FRAME_DURATION) < 1e-9);
check('every frame at n/30 seconds', timesExact,
  timesExact ? 'all 30 presentation times exact'
    : `first few: ${Array.from(table.presentationTimes.slice(0, 5)).join(', ')}`);

// --- multiplexed audio does not pollute the video table ----------------------
if (existsSync(CLIP_WITH_AUDIO)) {
  const audioMuxedBytes = new Uint8Array(await readFile(CLIP_WITH_AUDIO));
  const audioMuxedTable = await readOggFrameTable(new MemoryRangeReader(audioMuxedBytes));
  check('Vorbis pages are not counted as frames',
    audioMuxedTable.presentationTimes.length === EXPECTED_FRAMES,
    `${audioMuxedTable.presentationTimes.length} frames with audio muxed in `
    + `(want ${EXPECTED_FRAMES})`);
} else {
  console.log('SKIP ogg-table audio-muxed case: fixture absent');
}

// --- budget: no time means a refusal, never a hang ---------------------------
const timedOut = await readOggFrameTable(new MemoryRangeReader(bytes),
  { timeoutMilliseconds: 0 }).then(() => null, (e) => e);
check('a zero time budget throws IndexBudgetExceededError',
  timedOut instanceof IndexBudgetExceededError,
  timedOut ? timedOut.name : 'resolved without throwing');

const tooBig = await readOggFrameTable(new MemoryRangeReader(bytes),
  { maxBytes: 16 }).then(() => null, (e) => e);
check('an over-budget size throws IndexBudgetExceededError',
  tooBig instanceof IndexBudgetExceededError,
  tooBig ? tooBig.name : 'resolved without throwing');

// --- progress reports, same contract as the Matroska pass --------------------
const reports = [];
await readOggFrameTable(new MemoryRangeReader(bytes), {
  chunkBytes: 256,   // tiny, so a few-KB clip refills several times
  onProgress: (p) => reports.push(p),
});
check('emitted several progress ticks', reports.length >= 2,
  `${reports.length} report(s) at 256 B/chunk`);
const shapeOk = reports.every((p) =>
  p.totalBytes === bytes.length
  && p.bytesRead >= 0 && p.bytesRead <= bytes.length
  && p.fraction >= 0 && p.fraction <= 1
  && Number.isFinite(p.elapsedMs) && Number.isFinite(p.etaMs)
  && Number.isInteger(p.framesFound));
check('every report is well-formed', shapeOk,
  shapeOk ? 'bytesRead/fraction/elapsedMs/etaMs/framesFound all in range'
    : 'a malformed report was emitted');
const last = reports[reports.length - 1];
check('final tick is 100%', last && last.fraction === 1,
  last ? `fraction=${last.fraction}` : 'no reports');

// --- ContainerIndex routes "OggS" to the Ogg parser --------------------------
const index = await ContainerIndex.load(new MemoryRangeReader(bytes));
check('ContainerIndex reports the ogg format', index.containerFormat === 'ogg',
  `containerFormat=${index.containerFormat}`);
check('normalized index has the frames', index.numFrames === EXPECTED_FRAMES
  && Math.abs(index.duration - 1) < 1e-9,
  `numFrames=${index.numFrames}, duration=${index.duration}`);
check('an Ogg index cannot feed WebCodecs', index.supportsWebCodecs === false,
  `supportsWebCodecs=${index.supportsWebCodecs}`);

process.exit(failures ? 1 : 0);
