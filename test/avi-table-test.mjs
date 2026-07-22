// Unit test for the AVI frame table (src/avi.js). Runs in plain Node — the RIFF
// parse needs no browser — against the generated AVI fixtures, whose ground truth
// is fully known (make-test-clips.sh):
//
//   counter-idx1.avi      30 H.264 frames, 30 fps, 150x90, legacy idx1 index
//   counter-opendml.avi   the same 30 frames, but an OpenDML indx/ix00 index
//   counter-avi-25fps.avi 25 H.264 frames, 25 fps, 170x94, idx1 (a second rate
//                         and non-multiple-of-16 dimensions)
//   counter-rawvideo.avi  uncompressed — must be refused (no decoderConfig)
//   counter-mjpeg.avi     MJPEG — must be refused (no decoderConfig)
//
// This is the KEY difference from the Ogg/Matroska table tests: those assert an
// index that CANNOT feed WebCodecs (supportsWebCodecs === false, no sample table,
// no decoderConfig), because they fall back to the native <video> element. AVI has
// no native fallback, so a decodable AVI must index into a FULL sample table with a
// decoderConfig and supportsWebCodecs === true — and an undecodable one must be
// refused cleanly, in bounded time, never crash or hang.
//
// If the fixtures are absent (no ffmpeg on this machine — see make-test-clips.sh)
// the test skips rather than fails.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readAviFrameTable, convertAnnexBToAvcc } from '../src/avi.js';
import { IndexBudgetExceededError } from '../src/matroska.js';
import { ContainerIndex } from '../src/container-index.js';

const here = dirname(fileURLToPath(import.meta.url));
const clip = (name) => join(here, 'clips', name);
const IDX1 = clip('counter-idx1.avi');
const OPENDML = clip('counter-opendml.avi');
const ODDRATE = clip('counter-avi-25fps.avi');
const RAWVIDEO = clip('counter-rawvideo.avi');
const MJPEG = clip('counter-mjpeg.avi');

if (!existsSync(IDX1)) {
  console.log('SKIP avi-table: fixtures not generated on this machine '
    + '(no ffmpeg; see make-test-clips.sh)');
  process.exit(0);
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} avi-table ${name}: ${detail}`);
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

async function readerFor(path) {
  return new MemoryRangeReader(new Uint8Array(await readFile(path)));
}

// --- the two decodable index flavors, checked identically --------------------
// The whole point is that idx1 and OpenDML produce the SAME table for the same
// content, so one helper pins both. 30 frames, 150x90, 30 fps, and keyframes at
// 0/10/20 (encoded with -g 10). The byte ranges must be strictly increasing and
// non-overlapping (a real, ordered enumeration of the movi chunks).
async function checkDecodableTable(label, path) {
  const table = await readAviFrameTable(await readerFor(path));
  check(`${label} frame count`, table.frames.length === 30,
    `${table.frames.length} frames (want 30)`);
  check(`${label} dimensions`, table.videoWidth === 150 && table.videoHeight === 90,
    `${table.videoWidth}x${table.videoHeight}`);
  check(`${label} frame rate`,
    table.frameRateNumerator === 30 && table.frameRateDenominator === 1,
    `dwRate/dwScale = ${table.frameRateNumerator}/${table.frameRateDenominator}`);
  check(`${label} FourCC is H.264`, table.fourCc === 'H264',
    `fourCc=${JSON.stringify(table.fourCc)}`);

  // Keyframe flags: the first frame is a keyframe, the second is not, and with
  // -g 10 there are exactly three keyframes (0, 10, 20).
  const syncFrames = table.frames.filter((f) => f.isSync).length;
  check(`${label} keyframe flags read`,
    table.frames[0].isSync === true && table.frames[1].isSync === false && syncFrames === 3,
    `frame0=${table.frames[0].isSync} frame1=${table.frames[1].isSync} totalKeyframes=${syncFrames}`);

  // Byte ranges strictly increasing and non-overlapping, and each keyframe entry
  // is present with a positive size — a genuine ordered chunk enumeration.
  let ordered = true;
  for (let n = 1; n < table.frames.length; n++) {
    const prev = table.frames[n - 1], cur = table.frames[n];
    if (!(cur.size > 0) || cur.offset < prev.offset + prev.size) ordered = false;
  }
  check(`${label} byte ranges ordered and non-overlapping`, ordered,
    ordered ? 'all 30 ranges ascending' : 'a range overlapped or ran backwards');

  // A WebCodecs-decodable AVI must yield a decoderConfig with an avc1 codec string
  // and, now, an `avcC` description (AVCC mode — Annex B without a description
  // fails on WebKit, so the engine converts to AVCC). The description is the avcC
  // box body, so it begins with configurationVersion = 1.
  const config = table.decoderConfig;
  const description = config && config.description;
  check(`${label} decoderConfig present with avcC description`,
    !!config && /^avc1\./.test(config.codec)
    && description instanceof Uint8Array && description.length > 8 && description[0] === 1
    && config.codedWidth === 150 && config.codedHeight === 90,
    config ? `codec=${config.codec} description=${description && description.length}B `
      + `${config.codedWidth}x${config.codedHeight}` : 'no decoderConfig');
  check(`${label} samples flagged as Annex B`, table.samplesAreAnnexB === true,
    `samplesAreAnnexB=${table.samplesAreAnnexB}`);
}

await checkDecodableTable('idx1', IDX1);
await checkDecodableTable('opendml', OPENDML);

// --- Annex B -> AVCC conversion is well-formed -------------------------------
// The decode path converts each frame's start-code Annex B to length-prefixed
// AVCC. Read the first keyframe's actual bytes and check the conversion: every
// NAL is a 4-byte big-endian length followed by that many bytes, the lengths tile
// the buffer exactly, and the keyframe still carries an SPS (type 7) and PPS
// (type 8) — the parameter sets the avcC was built from.
{
  const bytes = new Uint8Array(await readFile(IDX1));
  const table = await readAviFrameTable(new MemoryRangeReader(bytes));
  const keyframe = table.frames.find((f) => f.isSync);
  const annexB = bytes.subarray(keyframe.offset, keyframe.offset + keyframe.size);
  const avcc = convertAnnexBToAvcc(annexB);

  const nalTypes = [];
  let offset = 0, wellFormed = true;
  while (offset + 4 <= avcc.length) {
    const nalLength = (avcc[offset] << 24) | (avcc[offset + 1] << 16)
      | (avcc[offset + 2] << 8) | avcc[offset + 3];
    if (nalLength <= 0 || offset + 4 + nalLength > avcc.length) { wellFormed = false; break; }
    nalTypes.push(avcc[offset + 4] & 0x1F);
    offset += 4 + nalLength;
  }
  wellFormed = wellFormed && offset === avcc.length;
  check('AVCC conversion tiles the buffer with length-prefixed NALs', wellFormed,
    wellFormed ? `${nalTypes.length} NAL units, exact fit` : 'lengths did not tile the buffer');
  check('AVCC keyframe carries SPS and PPS',
    nalTypes.includes(7) && nalTypes.includes(8),
    `NAL types: ${nalTypes.join(',')}`);
}

// --- a second frame rate and odd dimensions ----------------------------------
{
  const table = await readAviFrameTable(await readerFor(ODDRATE));
  check('25fps frame count', table.frames.length === 25,
    `${table.frames.length} frames (want 25)`);
  check('25fps dimensions', table.videoWidth === 170 && table.videoHeight === 94,
    `${table.videoWidth}x${table.videoHeight}`);
  check('25fps rate/scale', table.frameRateNumerator === 25 && table.frameRateDenominator === 1,
    `${table.frameRateNumerator}/${table.frameRateDenominator}`);
}

// --- exact constant frame spacing, via the normalized ContainerIndex ---------
// The table itself carries only the rational rate; ContainerIndex turns it into
// the per-frame presentation times, which must be an exact 1/30-second arithmetic
// sequence (AVI is constant-frame-rate with no B-frames, so this is exact up to
// float division).
{
  const index = await ContainerIndex.load(await readerFor(IDX1));
  const spacingExact = Array.from(index.presentationTimes).every((t, n) =>
    Math.abs(t - n / 30) < 1e-9);
  check('idx1 presentation times are n/30 exactly', spacingExact,
    spacingExact ? 'all 30 times exact'
      : `first few: ${Array.from(index.presentationTimes.slice(0, 5)).join(', ')}`);
  check('idx1 duration', Math.abs(index.duration - 1) < 1e-9, `duration=${index.duration}`);
}

// --- budget: no time / a tiny byte ceiling means a refusal, never a hang ------
const timedOut = await readAviFrameTable(await readerFor(IDX1),
  { timeoutMilliseconds: 0 }).then(() => null, (e) => e);
check('a zero time budget throws IndexBudgetExceededError',
  timedOut instanceof IndexBudgetExceededError,
  timedOut ? timedOut.name : 'resolved without throwing');

const tooBig = await readAviFrameTable(await readerFor(IDX1),
  { maxBytes: 16 }).then(() => null, (e) => e);
check('a tiny maxBytes throws IndexBudgetExceededError',
  tooBig instanceof IndexBudgetExceededError,
  tooBig ? tooBig.name : 'resolved without throwing');

// --- progress reports, same contract as the other passes ---------------------
const reports = [];
await readAviFrameTable(await readerFor(IDX1), { onProgress: (p) => reports.push(p) });
check('emitted several progress ticks', reports.length >= 2,
  `${reports.length} report(s)`);
const bytes = (await readFile(IDX1)).length;
const shapeOk = reports.every((p) =>
  p.totalBytes === bytes
  && p.bytesRead >= 0
  && p.fraction >= 0 && p.fraction <= 1
  && Number.isFinite(p.elapsedMs) && Number.isFinite(p.etaMs)
  && Number.isInteger(p.framesFound));
check('every report is well-formed', shapeOk,
  shapeOk ? 'bytesRead/fraction/elapsedMs/etaMs/framesFound all in range'
    : 'a malformed report was emitted');
const last = reports[reports.length - 1];
check('final tick is 100%', last && last.fraction === 1,
  last ? `fraction=${last.fraction}` : 'no reports');

// --- ContainerIndex routes RIFF/AVI to the AVI parser, WebCodecs-capable ------
// The crucial difference from the Ogg/Matroska tests: an AVI index MUST be able to
// feed WebCodecs (a populated sample table AND a decoderConfig), because AVI has no
// native fallback.
for (const [label, path] of [['idx1', IDX1], ['opendml', OPENDML]]) {
  const index = await ContainerIndex.load(await readerFor(path));
  check(`${label} ContainerIndex reports the avi format`, index.containerFormat === 'avi',
    `containerFormat=${index.containerFormat}`);
  check(`${label} index has the frames`, index.numFrames === 30,
    `numFrames=${index.numFrames}`);
  check(`${label} an AVI index CAN feed WebCodecs`, index.supportsWebCodecs === true,
    `supportsWebCodecs=${index.supportsWebCodecs}`);
  check(`${label} sample table and decoderConfig populated`,
    !!index.samples && index.samples.length === 30 && !!index.decoderConfig
    && /^avc1\./.test(index.decoderConfig.codec),
    index.decoderConfig ? `samples=${index.samples && index.samples.length} `
      + `codec=${index.decoderConfig.codec}` : 'no decoderConfig');
}

// --- undecodable codecs are refused cleanly, in bounded time -----------------
// rawvideo (uncompressed) and MJPEG have no WebCodecs decoder here, and AVI has no
// native fallback, so both must be refused: the parse declines to produce a
// decoderConfig, and ContainerIndex.load surfaces a clear error rather than a
// crash or a hang. A watchdog proves "bounded time".
async function withinTime(promise, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('did not settle in time')), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

for (const [label, path, present] of [
  ['rawvideo', RAWVIDEO, existsSync(RAWVIDEO)],
  ['mjpeg', MJPEG, existsSync(MJPEG)],
]) {
  if (!present) { console.log(`SKIP avi-table ${label}: fixture absent`); continue; }

  // The parser itself declines to produce a decoderConfig for an undecodable codec.
  const table = await withinTime(readAviFrameTable(await readerFor(path)), 5000)
    .then((t) => t, (e) => e);
  check(`${label} parse declines to produce a decoderConfig`,
    table && table.decoderConfig === null,
    table instanceof Error ? `threw ${table.message}` : `decoderConfig=${table && table.decoderConfig}`);

  // ContainerIndex.load surfaces a clear error (it will not hand back an index
  // that cannot play), in bounded time.
  const loaded = await withinTime(ContainerIndex.load(await readerFor(path)), 5000)
    .then(() => null, (e) => e);
  check(`${label} ContainerIndex.load refuses with a clear error`,
    loaded instanceof Error && !(loaded.message === 'did not settle in time')
    && /AVI|codec|decode/i.test(loaded.message),
    loaded ? `${loaded.name}: ${loaded.message}` : 'resolved without refusing');
}

process.exit(failures ? 1 : 0);
