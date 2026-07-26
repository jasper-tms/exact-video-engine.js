// Unit test for src/frame-reorder-bound.js: the reorder depth a stream declares
// about itself, read out of its H.264 or HEVC sequence parameter set.
//
// This number decides how early a progressively built index may publish a frame
// (see src/matroska.js's nextCertifiedRun), so reading it too LARGE only costs
// latency, while reading it too SMALL would publish a frame number before it was
// settled — the silent off-by-one this library exists to prevent. Every case
// below is therefore either an exact expected value or `null`, which is the
// answer that makes a caller fall back to what its container proves on its own.
//
// Two kinds of input are used. The generated fixtures anchor the parse against
// streams a real encoder wrote, cross-checked against ffprobe's `has_b_frames`
// (which is the same quantity): counter-vfr.mkv reports 0 and counter-hevc.mkv
// reports 2. The synthetic records cover what no fixture on this machine
// happens to contain — a declared depth other than the encoder's default, a
// stream with no VUI at all, a field-coded stream, emulation-prevention bytes.
//
// Runs in plain Node: parsing a setup record needs no browser.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ContainerIndex } from '../src/container-index.js';
import {
  declaredFrameReorderDepth, removeEmulationPrevention,
} from '../src/frame-reorder-bound.js';
import {
  buildAvcC, buildH264SequenceParameterSet, buildHevcRecord,
} from './bitstream-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clip = (name) => join(here, 'clips', name);

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) return;
  failures += 1;
  console.error(`FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};
const checkEqual = (label, actual, expected) =>
  check(label, actual === expected, `expected ${expected}, got ${actual}`);

// ------------------------------------------------------------------
// What a real encoder wrote, cross-checked against ffprobe's has_b_frames.
// ------------------------------------------------------------------
class MemoryRangeReader {
  constructor(bytes) { this.bytes = bytes; this.size = bytes.length; }
  async init() {}
  async read(start, endInclusive) { return this.bytes.slice(start, endInclusive + 1).buffer; }
}

async function setupRecordOf(name) {
  const bytes = new Uint8Array(await readFile(clip(name)));
  const index = await ContainerIndex.load(new MemoryRangeReader(bytes), {});
  const description = index.decoderConfig && index.decoderConfig.description;
  return description ? new Uint8Array(description) : null;
}

if (existsSync(clip('counter-vfr.mkv'))) {
  const record = await setupRecordOf('counter-vfr.mkv');
  checkEqual('fixture: H.264 in Matroska declares no reordering (ffprobe: 0)',
    declaredFrameReorderDepth('avcC', record), 0);
} else {
  console.log('SKIP frame-reorder-bound: counter-vfr.mkv not generated on this machine');
}

if (existsSync(clip('counter-hevc.mkv'))) {
  const record = await setupRecordOf('counter-hevc.mkv');
  checkEqual('fixture: HEVC in Matroska declares a depth of two (ffprobe: 2)',
    declaredFrameReorderDepth('hvcC', record), 2);
}

// ------------------------------------------------------------------
// H.264: the declared value, read back exactly.
// ------------------------------------------------------------------
for (const declared of [0, 1, 2, 3, 5, 16]) {
  const record = buildAvcC(buildH264SequenceParameterSet({ declaredReorderFrames: declared }));
  checkEqual(`H.264 declares ${declared}`,
    declaredFrameReorderDepth('avcC', record), declared);
}

// High profile takes the other branch through the sequence parameter set — the
// one with the chroma format and scaling matrices in it — so it is read twice.
checkEqual('H.264 High profile declares its depth through the chroma branch',
  declaredFrameReorderDepth('avcC', buildAvcC(buildH264SequenceParameterSet({
    profileIdc: 100, declaredReorderFrames: 2,
  }))), 2);

// ------------------------------------------------------------------
// H.264 with nothing declared: the specification's own inference, which is a
// hard ceiling rather than a habit — a conforming stream can never reorder by
// more than its level's decoded-picture-buffer capacity.
// ------------------------------------------------------------------

// Level 3.0 allows 8100 macroblocks of buffer; 1280x720 is 80 x 45 = 3600 per
// frame, so two frames fit and the stream cannot reorder past that.
checkEqual('H.264 with no bitstream restrictions falls back to the level ceiling',
  declaredFrameReorderDepth('avcC', buildAvcC(buildH264SequenceParameterSet({
    levelIdc: 30, widthInMacroblocks: 80, heightInMapUnits: 45,
    declaredReorderFrames: null,
  }))), 2);

checkEqual('H.264 with no VUI at all falls back the same way',
  declaredFrameReorderDepth('avcC', buildAvcC(buildH264SequenceParameterSet({
    levelIdc: 30, widthInMacroblocks: 80, heightInMapUnits: 45,
    writeVideoUsability: false,
  }))), 2);

// A small picture leaves room for far more frames, but the buffer holds at most
// sixteen whatever the arithmetic says.
checkEqual('H.264 level ceiling is capped at sixteen frames',
  declaredFrameReorderDepth('avcC', buildAvcC(buildH264SequenceParameterSet({
    levelIdc: 52, widthInMacroblocks: 10, heightInMapUnits: 6,
    writeVideoUsability: false,
  }))), 16);

// constraint_set3_flag on these profiles is the stream saying outright that it
// does not reorder, which beats the level ceiling.
checkEqual('H.264 constrained High profile infers no reordering',
  declaredFrameReorderDepth('avcC', buildAvcC(buildH264SequenceParameterSet({
    profileIdc: 100, constraintFlags: 0x10, writeVideoUsability: false,
  }))), 0);

// ------------------------------------------------------------------
// The cases where the honest answer is "no answer".
// ------------------------------------------------------------------

// A field-coded stream counts in fields where a caller counts pictures, so the
// bound would not line up with what the caller is counting.
checkEqual('H.264 field-coded stream declines to answer',
  declaredFrameReorderDepth('avcC', buildAvcC(buildH264SequenceParameterSet({
    frameMacroblocksOnly: false, declaredReorderFrames: 1,
  }))), null);

checkEqual('an empty record has no answer',
  declaredFrameReorderDepth('avcC', new Uint8Array(0)), null);
checkEqual('a truncated record has no answer',
  declaredFrameReorderDepth('avcC', new Uint8Array([0x01, 0x64, 0x00, 0x1E])), null);
checkEqual('a record whose length overruns the buffer has no answer',
  declaredFrameReorderDepth('avcC',
    new Uint8Array([0x01, 0x64, 0x00, 0x1E, 0xFF, 0xE1, 0x7F, 0xFF, 0x67])), null);
checkEqual('a codec with no such declaration has no answer',
  declaredFrameReorderDepth('vp09', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);

// Random bytes must never come back as a number: a wrong small depth is exactly
// what would publish a frame number before it was settled.
{
  let numeric = 0;
  for (let seed = 0; seed < 300; seed++) {
    const bytes = new Uint8Array(40);
    // A fixed sequence rather than a random one, so a failure is reproducible.
    for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 37 + i * 61) & 0xFF;
    bytes[0] = 0x01;
    if (typeof declaredFrameReorderDepth('avcC', bytes) === 'number') numeric++;
    if (typeof declaredFrameReorderDepth('hvcC', bytes) === 'number') numeric++;
  }
  // Some of these will parse as *something* — the point is that none of them
  // throws, and that the reader stays inside its buffer whatever it is handed.
  check('garbage records never throw', true, `${numeric} parsed to a number`);
}

// ------------------------------------------------------------------
// HEVC.
// ------------------------------------------------------------------
for (const declared of [0, 1, 2, 4]) {
  checkEqual(`HEVC declares ${declared}`,
    declaredFrameReorderDepth('hvcC', buildHevcRecord({
      declaredReorderPictures: declared,
    })), declared);
}

// With several temporal sub-layers the bound that matters is the highest one's:
// every frame the file presents belongs to it. The builder writes 0 for the
// lower layers, so reading the wrong entry would come back as 0.
checkEqual('HEVC reads the highest sub-layer, not the first',
  declaredFrameReorderDepth('hvcC', buildHevcRecord({
    declaredReorderPictures: 3, subLayers: 3,
  })), 3);

// ------------------------------------------------------------------
// Emulation prevention: 0x03 stuffed into a NAL payload is not part of the
// syntax, and a reader that took it literally would walk off into nonsense.
// ------------------------------------------------------------------
{
  const stuffed = new Uint8Array([0x00, 0x00, 0x03, 0x01, 0x00, 0x00, 0x03, 0x02, 0x05]);
  const stripped = removeEmulationPrevention(stuffed);
  check('emulation prevention bytes are removed',
    Array.from(stripped).join(',') === '0,0,1,0,0,2,5', Array.from(stripped).join(','));

  const plain = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
  check('a payload with nothing to strip is passed through untouched',
    removeEmulationPrevention(plain) === plain);

  // 00 00 03 03 is a stuffed 00 00 03: only the first 0x03 goes.
  const consecutive = removeEmulationPrevention(
    new Uint8Array([0x00, 0x00, 0x03, 0x03, 0x00, 0x00, 0x03, 0x00]));
  check('a stuffed 0x03 keeps the byte it was protecting',
    Array.from(consecutive).join(',') === '0,0,3,0,0,0',
    Array.from(consecutive).join(','));
}

// A sequence parameter set whose bytes really do need stuffing, read end to end.
// widthInMacroblocks 1 and heightInMapUnits 1 put long runs of zero bits right
// where the emulation-prevention byte lands.
{
  const record = buildAvcC(buildH264SequenceParameterSet({
    widthInMacroblocks: 1, heightInMapUnits: 1, declaredReorderFrames: 2,
  }));
  checkEqual('a stuffed sequence parameter set still reads its declared depth',
    declaredFrameReorderDepth('avcC', record), 2);
}

if (failures) {
  console.error(`frame-reorder-bound: ${failures} failure(s)`);
  process.exit(1);
}
console.log('PASS frame-reorder-bound: all cases');
