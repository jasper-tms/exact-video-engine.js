// Unit test for the WebM indexing progress reports (createBestEngine's
// onProgress, emitted by readMatroskaFrameTable). Runs in plain Node -- the
// Matroska parser needs no browser -- against the real counter-cfr.webm fixture,
// with a deliberately tiny chunk size so a few-kilobyte clip still produces
// several progress ticks to check the cadence, monotonicity and ETA of.
//
// Expects test/clips/counter-cfr.webm to exist (run-tests.sh / make-test-clips.sh
// build it). Reads directly from src/ so it exercises the same code the build
// concatenates into the shipped file.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readMatroskaFrameTable, formatProgress } from '../src/matroska.js';
import { ContainerIndex } from '../src/container-index.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLIP = join(here, 'clips', 'counter-cfr.webm');
const EXPECTED_FRAMES = 30;   // counter-cfr is 30 frames at a nominal 30 fps

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} progress ${name}: ${detail}`);
}

// A minimal in-memory range reader matching the contract in range-readers.js:
// a .size, an async .init(), and .read(start, endInclusive) -> ArrayBuffer.
class MemoryRangeReader {
  constructor(bytes) { this.bytes = bytes; this.size = bytes.length; }
  async init() {}
  async read(start, endInclusive) {
    return this.bytes.slice(start, endInclusive + 1).buffer;
  }
}

const bytes = new Uint8Array(await readFile(CLIP));
const fileSize = bytes.length;

// --- the pass reports progress, monotonically, ending at 100% ----------------
const reports = [];
const table = await readMatroskaFrameTable(new MemoryRangeReader(bytes), {
  chunkBytes: 256,   // small, so a few-KB clip refills several times
  onProgress: (p) => reports.push(p),
});

check('emitted several ticks', reports.length >= 2,
  `${reports.length} report(s) over ${fileSize} bytes at 256 B/chunk`);

const shapeOk = reports.every((p) =>
  p.totalBytes === fileSize
  && p.bytesRead >= 0 && p.bytesRead <= fileSize
  && p.fraction >= 0 && p.fraction <= 1
  && Number.isFinite(p.elapsedMs) && p.elapsedMs >= 0
  && Number.isFinite(p.etaMs) && p.etaMs >= 0
  && Number.isInteger(p.framesFound) && p.framesFound >= 0);
check('every report is well-formed', shapeOk,
  shapeOk ? 'bytesRead/fraction/elapsedMs/etaMs/framesFound all in range'
    : `bad report: ${JSON.stringify(reports.find((p) => !(p.totalBytes === fileSize
        && p.fraction >= 0 && p.fraction <= 1 && p.etaMs >= 0)))}`);

const fractionsMonotonic = reports.every((p, i) => i === 0 || p.fraction >= reports[i - 1].fraction);
check('fraction never goes backwards', fractionsMonotonic,
  reports.map((p) => p.fraction.toFixed(2)).join(' -> '));

const framesMonotonic = reports.every((p, i) => i === 0 || p.framesFound >= reports[i - 1].framesFound);
check('framesFound never goes backwards', framesMonotonic,
  reports.map((p) => p.framesFound).join(' -> '));

const last = reports[reports.length - 1];
check('final tick is 100%', last && last.fraction === 1 && last.bytesRead === fileSize,
  last ? `fraction=${last.fraction}, bytesRead=${last.bytesRead}/${fileSize}` : 'no reports');
check('final tick has all frames and no ETA',
  last && last.framesFound === EXPECTED_FRAMES && last.etaMs === 0,
  last ? `framesFound=${last.framesFound} (want ${EXPECTED_FRAMES}), etaMs=${last.etaMs}` : 'no reports');

check('table matches the reported frame count', table.presentationTimes.length === EXPECTED_FRAMES,
  `table has ${table.presentationTimes.length} frames`);

// --- a mid-pass ETA is present and formats sensibly --------------------------
const mid = reports.find((p) => p.fraction > 0 && p.fraction < 1);
check('a mid-pass tick carries an ETA', !!mid && mid.etaMs > 0,
  mid ? `at ${(mid.fraction * 100).toFixed(0)}%, etaMs=${mid.etaMs.toFixed(0)}` : 'no strictly-partial tick seen');

const midString = mid ? formatProgress(mid) : '';
check('formatProgress shows percent and ETA mid-pass',
  /^Indexing… \d+% \(~\d+s left\)$/.test(midString), JSON.stringify(midString));
check('formatProgress shows plain percent at 100%',
  formatProgress(last) === 'Indexing… 100%', JSON.stringify(formatProgress(last)));

// --- robustness: omitted callback is fine; a throwing one cannot abort a load -
let noCallbackOk = true;
try {
  await readMatroskaFrameTable(new MemoryRangeReader(bytes), { chunkBytes: 256 });
} catch (e) {
  noCallbackOk = false;
}
check('no onProgress is fine', noCallbackOk, 'indexed without a callback');

const throwingTable = await readMatroskaFrameTable(new MemoryRangeReader(bytes), {
  chunkBytes: 256,
  onProgress: () => { throw new Error('host indicator blew up'); },
}).catch(() => null);
check('a throwing onProgress does not abort the index',
  throwingTable && throwingTable.presentationTimes.length === EXPECTED_FRAMES,
  throwingTable ? `still indexed ${throwingTable.presentationTimes.length} frames`
    : 'the throw took the whole pass down');

// --- the plumbing: ContainerIndex.load forwards onProgress to the scan -------
// (createBestEngine -> ContainerIndex.fromSource -> load -> readMatroskaFrameTable;
// only the createBestEngine hop needs a DOM, so this covers the rest in Node.)
const indexReports = [];
const index = await ContainerIndex.load(new MemoryRangeReader(bytes), {
  chunkBytes: 256,
  onProgress: (p) => indexReports.push(p),
});
check('ContainerIndex.load forwards onProgress', indexReports.length >= 2,
  `${indexReports.length} report(s) through the container layer`);
check('the indexed clip has the expected frames', index.numFrames === EXPECTED_FRAMES,
  `ContainerIndex.numFrames=${index.numFrames}`);

process.exit(failures ? 1 : 0);
