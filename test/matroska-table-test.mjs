// Unit test for the Matroska/WebM frame table (src/matroska.js). Runs in plain
// Node — the cluster scan needs no browser — against the generated fixtures,
// whose ground truth is fully known (make-test-clips.sh):
//
//   counter-cfr.webm   30 VP9 frames, constant 30 fps, 150x90
//   counter-vfr.webm   the same 30 frames, variable rate (every 5th held twice)
//   counter-vp8.webm   the same 30 frames, VP8
//   counter-av1.webm   the same 30 frames, AV1
//   counter-hevc.mkv   the same 30 frames, HEVC
//   counter-vfr.mkv    the variable-rate 30 frames, H.264 in Matroska
//
// What this pins is the half of the Matroska index that the browser walk cannot
// see. frame-index-test.mjs proves the frames come out right; it would prove that
// just as well if the sample table were subtly wrong in a way the decoder
// tolerated. So this test asserts the table itself:
//
//   * the DECODE table — every frame's byte range lands inside the file, no two
//     overlap, and (for the length-prefixed codecs) the range tiles exactly into
//     NAL units, which a range off by even one byte cannot do;
//   * the KEYFRAME flags, which decide where a decode run can start;
//   * the CODEC STRING, which is the piece with real room to be wrong — every
//     codec hides its profile/level/bit depth somewhere different, and an
//     over-claimed one is exactly the dishonest-yes this library exists to avoid.
//
// If the fixtures are absent (no ffmpeg on this machine — see make-test-clips.sh)
// the test skips rather than fails.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readMatroskaFrameTable, hevcCodecString, av1CodecString, IndexBudgetExceededError }
  from '../src/matroska.js';
import { ContainerIndex } from '../src/container-index.js';

const here = dirname(fileURLToPath(import.meta.url));
const clip = (name) => join(here, 'clips', name);
const EXPECTED_FRAMES = 30;

if (!existsSync(clip('counter-cfr.webm'))) {
  console.log('SKIP matroska-table: fixtures not generated on this machine '
    + '(no ffmpeg; see make-test-clips.sh)');
  process.exit(0);
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} matroska-table ${name}: ${detail}`);
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

async function tableFor(name) {
  const bytes = new Uint8Array(await readFile(clip(name)));
  return { bytes, table: await readMatroskaFrameTable(new MemoryRangeReader(bytes)) };
}

// --- the codec strings -------------------------------------------------------
//
// One clip per codec, each asserted against the value the container's own
// metadata implies. These are exact-match assertions on purpose: "starts with
// vp09" would pass for a profile or bit depth we invented.
const CODEC_CASES = [
  { file: 'counter-cfr.webm', codecId: 'V_VP9', codec: 'vp09.00.10.08',
    description: false,
    // Profile 0, 8-bit, read from the keyframe's own uncompressed header; level
    // 1.0 because 150x90 at 30 fps is 405,000 luma samples per second, inside
    // level 1.0's 829,440 and its 36,864-sample picture size.
    why: 'VP9 profile/bit depth from the keyframe header, level from the picture size and rate' },
  { file: 'counter-vp8.webm', codecId: 'V_VP8', codec: 'vp8', description: false,
    why: 'VP8 has one profile and one bit depth, so the plain registered string is the whole story' },
  { file: 'counter-av1.webm', codecId: 'V_AV1', codec: 'av01.0.00M.08', description: true,
    why: 'AV1 profile/level/tier/bit depth from the av1C record' },
  { file: 'counter-hevc.mkv', codecId: 'V_MPEGH/ISO/HEVC', codec: 'hvc1.1.6.L30.90',
    description: true,
    why: 'HEVC profile space/idc, reversed compatibility flags, tier+level, constraint bytes from hvcC' },
  { file: 'counter-vfr.mkv', codecId: 'V_MPEG4/ISO/AVC', codec: 'avc1.64000b', description: true,
    why: 'H.264 profile/compatibility/level from the avcC record, exactly as the MP4 path reads it' },
];

for (const testCase of CODEC_CASES) {
  if (!existsSync(clip(testCase.file))) {
    console.log(`SKIP matroska-table ${testCase.file}: fixture not generated on this machine`);
    continue;
  }
  const { table } = await tableFor(testCase.file);
  check(`${testCase.file} CodecID`, table.codecId === testCase.codecId,
    `${table.codecId} (want ${testCase.codecId})`);
  const config = table.decoderConfig;
  check(`${testCase.file} codec string`, !!config && config.codec === testCase.codec,
    `${config ? config.codec : 'no decoderConfig'} (want ${testCase.codec}) — ${testCase.why}`);
  check(`${testCase.file} dimensions`,
    !!config && config.codedWidth === 150 && config.codedHeight === 90,
    config ? `${config.codedWidth}x${config.codedHeight}` : 'no decoderConfig');
  // A description is the codec's out-of-band setup: present exactly for the
  // codecs that have one, absent for the self-describing ones (a description
  // WebCodecs does not expect is a configure() failure).
  check(`${testCase.file} description`,
    !!config && (!!config.description === testCase.description),
    `${config && config.description ? `${config.description.length} bytes` : 'none'} `
    + `(want ${testCase.description ? 'a description' : 'none'})`);
}

// --- the decode table --------------------------------------------------------
//
// The byte ranges are the part a frame-walk cannot falsify on its own, so check
// them structurally: inside the file, non-overlapping, and — for the codecs that
// store length-prefixed NAL units — tiling the sample exactly. The tiling check
// is the strong one: a range whose start or length is off by a byte cannot walk
// its own length prefixes and land precisely on the end.
for (const file of ['counter-cfr.webm', 'counter-vfr.webm', 'counter-vp8.webm',
                    'counter-av1.webm', 'counter-hevc.mkv', 'counter-vfr.mkv']) {
  if (!existsSync(clip(file))) continue;
  const { bytes, table } = await tableFor(file);
  const frames = table.frames;

  check(`${file} frame count`, frames.length === EXPECTED_FRAMES,
    `${frames.length} frames (want ${EXPECTED_FRAMES})`);

  const outside = frames.filter(
    (frame) => frame.offset < 0 || frame.size <= 0 || frame.offset + frame.size > bytes.length);
  check(`${file} byte ranges inside the file`, outside.length === 0,
    `${outside.length} of ${frames.length} out of bounds`);

  const byOffset = [...frames].sort((a, b) => a.offset - b.offset);
  let overlaps = 0;
  for (let i = 0; i + 1 < byOffset.length; i++) {
    if (byOffset[i].offset + byOffset[i].size > byOffset[i + 1].offset) overlaps += 1;
  }
  check(`${file} byte ranges do not overlap`, overlaps === 0,
    `${overlaps} overlapping pairs`);

  // The first frame must be a keyframe (a decode run has to start somewhere) and
  // the fixtures are encoded with -g 10, so 30 frames carry three of them.
  check(`${file} keyframe flags`,
    frames[0].isSync && frames.filter((frame) => frame.isSync).length === 3,
    `first isSync=${frames[0].isSync}, `
    + `${frames.filter((frame) => frame.isSync).length} keyframes (want 3, from -g 10)`);

  if (table.codecId === 'V_MPEG4/ISO/AVC' || table.codecId === 'V_MPEGH/ISO/HEVC') {
    let ragged = 0;
    for (const frame of frames) {
      let position = frame.offset;
      const end = frame.offset + frame.size;
      while (position + 4 <= end) {
        const length = ((bytes[position] << 24) | (bytes[position + 1] << 16)
          | (bytes[position + 2] << 8) | bytes[position + 3]) >>> 0;
        position += 4 + length;
      }
      if (position !== end) ragged += 1;
    }
    check(`${file} samples tile into length-prefixed NAL units`, ragged === 0,
      `${ragged} of ${frames.length} frames do not tile exactly`);
  }
}

// --- the index built on top of it --------------------------------------------
//
// ContainerIndex turns the decode table into the display tables both engines
// read. The variable-rate clip is the one that matters: its frames are 33 ms
// apart except every fifth, which is held for 66 — a spacing no assumed constant
// rate reproduces.
{
  const bytes = new Uint8Array(await readFile(clip('counter-vfr.webm')));
  const index = await ContainerIndex.load(new MemoryRangeReader(bytes), {});
  check('vfr index format', index.containerFormat === 'matroska', index.containerFormat);
  check('vfr index feeds WebCodecs',
    index.supportsWebCodecs === true && !!index.samples && !!index.decoderConfig,
    `supportsWebCodecs=${index.supportsWebCodecs}, `
    + `${index.samples ? index.samples.length : 0} samples, `
    + `decoderConfig=${index.decoderConfig ? index.decoderConfig.codec : 'null'}`);
  check('vfr index frame count', index.numFrames === EXPECTED_FRAMES,
    `${index.numFrames} frames`);
  check('vfr index starts at zero', index.presentationTimes[0] === 0,
    `${index.presentationTimes[0]}`);
  // The clip's frames are 33 ms apart except that every fifth one is held for 66
  // (setpts='33*N + 33*floor(N/5)'), so frames 4, 9, 14, 19 and 24 last twice as
  // long as the rest. Those held frames are exactly what an assumed constant
  // frame rate gets wrong, and seeing them here means the durations came from the
  // container's own timestamps. (Frame 29 is the last one and has no successor to
  // measure against, so its duration falls back to DefaultDuration.)
  const heldFrames = [];
  for (let d = 0; d < index.numFrames; d++) {
    if (index.frameDurations[d] > 0.05) heldFrames.push(d);
  }
  check('vfr index sees the held frames',
    heldFrames.join(',') === '4,9,14,19,24',
    `frames held longer than 50 ms: ${heldFrames.join(', ')} (want 4, 9, 14, 19, 24)`);
  // The display tables and the decode table must agree: every display index maps
  // to a decode index whose composition time is that display time.
  let mismatched = 0;
  for (let d = 0; d < index.numFrames; d++) {
    const sample = index.samples[index.displayToDecode[d]];
    const sampleTime = sample.cts / index.timescale - index.presentationTimes[0];
    if (Math.abs(sampleTime - index.presentationTimes[d]) > 1e-9) mismatched += 1;
  }
  check('vfr display-to-decode mapping', mismatched === 0,
    `${mismatched} of ${index.numFrames} display frames map to the wrong sample`);
  // The samples the WebCodecs engine would feed the decoder must be reachable
  // through microsToDisplay, which is how a decoded frame's timestamp is turned
  // back into a display index.
  const unmapped = [];
  for (let d = 0; d < index.numFrames; d++) {
    const sample = index.samples[index.displayToDecode[d]];
    const micros = Math.round(sample.cts * 1e6 / index.timescale);
    if (index.microsToDisplay.get(micros) !== d) unmapped.push(d);
  }
  check('vfr decoded-frame timestamps map back', unmapped.length === 0,
    `${unmapped.length} display frames unreachable from their sample timestamp`);
}

// --- codecs we will not configure --------------------------------------------
//
// A Matroska track whose codec we cannot configure honestly must yield NO
// decoderConfig rather than a guessed one — and, unlike AVI, must still index,
// because Matroska always has the <video> tier to fall back to. There is no
// fixture for an exotic CodecID (ffmpeg will not write one into WebM), so the
// builders are checked directly on records that cannot produce a valid string.
check('a too-short hvcC yields no codec string',
  hevcCodecString(new Uint8Array([1, 1, 0x60])) === null, 'null');
check('a too-short av1C yields no codec string',
  av1CodecString(new Uint8Array([0x81])) === null, 'null');
check('no record at all yields no codec string',
  hevcCodecString(null) === null && av1CodecString(null) === null, 'null');

// --- the budget contract, unchanged by any of the above ----------------------
{
  const bytes = new Uint8Array(await readFile(clip('counter-cfr.webm')));
  let thrown = null;
  try {
    await readMatroskaFrameTable(new MemoryRangeReader(bytes), { timeoutMilliseconds: 0 });
  } catch (error) { thrown = error; }
  check('no time allowed is refused, not approximated',
    thrown instanceof IndexBudgetExceededError, thrown ? thrown.name : 'no error thrown');
}

process.exit(failures ? 1 : 0);
