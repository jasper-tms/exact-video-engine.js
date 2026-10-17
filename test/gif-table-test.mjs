// Unit test for the GIF frame table and the JavaScript GIF decoder (src/gif.js).
// Runs in plain Node: the scan and the compositor touch no browser object.
//
// Two kinds of input. The counter fixtures (make-test-clips.sh) pin the table
// against ffmpeg's real output, and are skipped if absent. Everything else is a
// GIF written right here by writeGif(), because the cases that most need
// pinning are the ones ffmpeg never writes — interlaced rows, "restore to
// previous" disposal, a frame with its own colour table, zero delays, a file
// cut off mid-frame — and a hand-built file says exactly what each pixel should
// be.
//
// The browser walk (frame-index-test.mjs) proves the frames land on screen.
// What it cannot see, and this does: that the keyframes the scan marks really
// are frames a decode run can start from. A wrongly marked keyframe decodes to
// a right-looking picture on a forward walk and to a wrong one only on a cold
// seek, so every fixture here is decoded from every keyframe and compared with
// decoding from frame 0.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  readGifFrameTable, GifCompositor, decodeGifLzw, isAnimatedGif, GIF_CODEC,
} from '../src/gif.js';
import { IndexBudgetExceededError } from '../src/matroska.js';
import { ContainerIndex } from '../src/container-index.js';

const here = dirname(fileURLToPath(import.meta.url));
const clip = (name) => join(here, 'clips', name);

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} gif-table ${name}: ${detail}`);
}

// Matches the range-reader contract in range-readers.js.
class MemoryRangeReader {
  constructor(bytes) { this.bytes = bytes; this.size = bytes.length; }
  async init() {}
  async read(start, endInclusive) {
    return this.bytes.slice(start, endInclusive + 1).buffer;
  }
}

// ------------------------------------------------------------------
// A minimal GIF writer, so the tests can say exactly what is in the file.
// ------------------------------------------------------------------

// LZW-compress colour indices the way a GIF encoder does, including the code
// size growing to 12 bits and a clear code once the table is full.
function encodeLzw(indices, minimumCodeSize) {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const output = [];
  let bitBuffer = 0, bitCount = 0;
  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let table = new Map();
  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) { output.push(bitBuffer & 0xFF); bitBuffer >>>= 8; bitCount -= 8; }
  };
  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const key = (prefix << 8) | indices[i];
    if (table.has(key)) { prefix = table.get(key); continue; }
    emit(prefix);
    if (nextCode < 4096) {
      table.set(key, nextCode++);
      if (nextCode > (1 << codeSize) && codeSize < 12) codeSize += 1;
    } else {
      emit(clearCode);
      table = new Map();
      codeSize = minimumCodeSize + 1;
      nextCode = endCode + 1;
    }
    prefix = indices[i];
  }
  emit(prefix);
  emit(endCode);
  if (bitCount > 0) output.push(bitBuffer & 0xFF);
  return output;
}

function subBlocks(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const piece = bytes.slice(i, i + 255);
    out.push(piece.length, ...piece);
  }
  out.push(0);
  return out;
}

const uint16 = (value) => [value & 0xFF, value >> 8];

// A colour table padded to a power of two, as GIF requires; returns the bytes
// and the size field (n, for 2^(n+1) entries).
function colorTable(colors) {
  let sizeField = 0;
  while ((2 << sizeField) < colors.length) sizeField += 1;
  const bytes = [];
  for (let i = 0; i < (2 << sizeField); i++) bytes.push(...(colors[i] || [0, 0, 0]));
  return { bytes, sizeField };
}

// frames: [{ left, top, width, height, indices (row-major, natural order),
//   delay, disposal, transparentIndex, localColors, interlaced, noControl }]
function writeGif({ width, height, colors, frames, trailer = true }) {
  const bytes = [...'GIF89a'].map((c) => c.charCodeAt(0));
  const global = colors ? colorTable(colors) : null;
  bytes.push(...uint16(width), ...uint16(height),
    global ? 0x80 | global.sizeField : 0, 0, 0);
  if (global) bytes.push(...global.bytes);
  for (const frame of frames) {
    if (!frame.noControl) {
      const transparent = frame.transparentIndex !== undefined;
      bytes.push(0x21, 0xF9, 4, ((frame.disposal || 0) << 2) | (transparent ? 1 : 0),
        ...uint16(frame.delay ?? 10), transparent ? frame.transparentIndex : 0, 0);
    }
    const local = frame.localColors ? colorTable(frame.localColors) : null;
    bytes.push(0x2C, ...uint16(frame.left || 0), ...uint16(frame.top || 0),
      ...uint16(frame.width), ...uint16(frame.height),
      (local ? 0x80 | local.sizeField : 0) | (frame.interlaced ? 0x40 : 0));
    if (local) bytes.push(...local.bytes);
    let indices = frame.indices;
    if (frame.interlaced) {
      indices = [];
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
        for (let row = start; row < frame.height; row += step) {
          indices.push(...frame.indices.slice(row * frame.width, (row + 1) * frame.width));
        }
      }
    }
    const minimumCodeSize = Math.max(2, frame.minimumCodeSize || 2);
    bytes.push(minimumCodeSize, ...subBlocks(encodeLzw(indices, minimumCodeSize)));
  }
  if (trailer) bytes.push(0x3B);
  return new Uint8Array(bytes);
}

async function tableOf(bytes, options) {
  return readGifFrameTable(new MemoryRangeReader(bytes), options);
}

// Decode every frame from frame 0, returning a copy of the canvas after each.
function decodeAll(bytes, table, fromFrame = 0) {
  const compositor = new GifCompositor(table.decoderConfig.description,
    table.videoWidth, table.videoHeight);
  const pictures = [];
  for (let k = fromFrame; k < table.frames.length; k++) {
    const frame = table.frames[k];
    pictures[k] = compositor.composite(bytes.subarray(frame.offset, frame.offset + frame.size)).slice();
  }
  return pictures;
}

const RED = [255, 0, 0], GREEN = [0, 255, 0], BLUE = [0, 0, 255], WHITE = [255, 255, 255];
function pixel(picture, width, x, y) {
  const at = (y * width + x) * 4;
  return [picture[at], picture[at + 1], picture[at + 2], picture[at + 3]];
}
const same = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
const opaque = (color) => [...color, 255];
const TRANSPARENT = [0, 0, 0, 0];

// Every keyframe must reproduce, from a fresh decoder, exactly what decoding
// from frame 0 produced for it and for every frame after it.
function checkKeyframesAreRunStarts(label, bytes, table) {
  const reference = decodeAll(bytes, table);
  let wrong = 0, keyframes = 0;
  table.frames.forEach((frame, k) => {
    if (!frame.isSync || k === 0) return;
    keyframes += 1;
    const fromHere = decodeAll(bytes, table, k);
    for (let j = k; j < table.frames.length; j++) if (!same(fromHere[j], reference[j])) wrong += 1;
  });
  check(`${label}: decoding from each keyframe matches decoding from frame 0`, wrong === 0,
    `${keyframes} keyframes after frame 0, ${wrong} mismatched frames`);
}

// ------------------------------------------------------------------
// LZW, at the sizes that stress it.
// ------------------------------------------------------------------
{
  // Random indices fill the 4096-entry table several times over, so this covers
  // every code size from 9 to 12 bits and the clear code that follows a full
  // table — the decoder's hardest bookkeeping.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF) / 0x7FFFFFFF;
  const indices = Array.from({ length: 50000 }, () => Math.floor(random() * 256));
  const encoded = Uint8Array.from(encodeLzw(indices, 8));
  const { indices: decoded, count } = decodeGifLzw(8, encoded, indices.length);
  check('LZW round trip through full 12-bit tables', count === indices.length
    && indices.every((value, i) => decoded[i] === value), `${count} of ${indices.length}`);

  const runs = Array.from({ length: 30000 }, (_, i) => Math.floor(i / 700) % 4);
  const runsDecoded = decodeGifLzw(2, Uint8Array.from(encodeLzw(runs, 2)), runs.length);
  check('LZW round trip of long runs (the code that names itself)',
    runsDecoded.count === runs.length && runs.every((value, i) => runsDecoded.indices[i] === value),
    `${runsDecoded.count} of ${runs.length}`);

  const short = decodeGifLzw(8, encoded.subarray(0, 100), indices.length);
  check('LZW data that runs short yields only the pixels it holds',
    short.count > 0 && short.count < indices.length, `${short.count}`);
}

// ------------------------------------------------------------------
// Timing.
// ------------------------------------------------------------------
{
  const frame = (delay) => ({ width: 2, height: 2, indices: [0, 0, 0, 0], delay });
  const bytes = writeGif({ width: 2, height: 2, colors: [RED, GREEN],
    frames: [frame(0), frame(1), frame(2), frame(5), { ...frame(0), noControl: true }] });
  const table = await tableOf(bytes);
  const delays = table.frames.map((f) => f.delayCentiseconds).join(',');
  check('delays under 2 hundredths become 10, as every browser shows them; others are kept',
    delays === '10,10,2,5,10', delays);
  const index = await ContainerIndex.load(new MemoryRangeReader(bytes));
  const times = Array.from(index.presentationTimes).map((t) => t.toFixed(2)).join(',');
  check('presentation times are running sums of the delays', times === '0.00,0.10,0.20,0.22,0.27',
    times);
  check('ContainerIndex reports gif and reaches the WebCodecs tier',
    index.containerFormat === 'gif' && index.supportsWebCodecs
      && index.decoderConfig.codec === GIF_CODEC,
    `${index.containerFormat} ${index.supportsWebCodecs} ${index.decoderConfig.codec}`);
  check('duration includes the last frame\'s delay', Math.abs(index.duration - 0.37) < 1e-9,
    `${index.duration}`);
}

// ------------------------------------------------------------------
// Compositing: disposal methods, transparency, colour tables, interlacing.
// ------------------------------------------------------------------
{
  // "Restore to previous": frame 1's blue patch must be gone by frame 2, with
  // frame 0's red back underneath it.
  const width = 4, height = 2;
  const bytes = writeGif({ width, height, colors: [RED, GREEN, BLUE], frames: [
    { width, height, indices: Array(8).fill(0) },
    { left: 1, top: 0, width: 2, height: 1, indices: [2, 2], disposal: 3 },
    { left: 0, top: 1, width: 1, height: 1, indices: [1] },
  ] });
  const table = await tableOf(bytes);
  const pictures = decodeAll(bytes, table);
  check('restore-to-previous: the patch shows on its own frame',
    same(pixel(pictures[1], width, 1, 0), opaque(BLUE)) && same(pixel(pictures[1], width, 2, 0), opaque(BLUE)),
    `${pixel(pictures[1], width, 1, 0)}`);
  check('restore-to-previous: the patch is gone on the next frame, the red back',
    same(pixel(pictures[2], width, 1, 0), opaque(RED)) && same(pixel(pictures[2], width, 0, 1), opaque(GREEN)),
    `${pixel(pictures[2], width, 1, 0)} ${pixel(pictures[2], width, 0, 1)}`);
  check('restore-to-previous: keyframes', table.frames.map((f) => +f.isSync).join('') === '100',
    table.frames.map((f) => +f.isSync).join(''));
  checkKeyframesAreRunStarts('restore-to-previous', bytes, table);
}
{
  // "Restore to background" on a whole-canvas frame leaves a blank canvas (every
  // browser clears to transparent), which makes the next frame a keyframe.
  const width = 4, height = 2;
  const bytes = writeGif({ width, height, colors: [RED, GREEN], frames: [
    { width, height, indices: Array(8).fill(0), disposal: 2 },
    { left: 3, top: 1, width: 1, height: 1, indices: [1] },
    { left: 0, top: 0, width: 1, height: 1, indices: [0] },
  ] });
  const table = await tableOf(bytes);
  const pictures = decodeAll(bytes, table);
  check('restore-to-background clears to transparent',
    same(pixel(pictures[1], width, 0, 0), TRANSPARENT) && same(pixel(pictures[1], width, 3, 1), opaque(GREEN)),
    `${pixel(pictures[1], width, 0, 0)}`);
  check('restore-to-background: a frame after a cleared canvas is a keyframe',
    table.frames.map((f) => +f.isSync).join('') === '110', table.frames.map((f) => +f.isSync).join(''));
  checkKeyframesAreRunStarts('restore-to-background', bytes, table);
}
{
  // Transparency lets the frame before show through; a whole-canvas frame that
  // declares a transparent colour is therefore NOT a keyframe, and one that
  // declares none is — unless it restores to previous afterwards.
  const width = 3, height = 1;
  const bytes = writeGif({ width, height, colors: [RED, GREEN, BLUE], frames: [
    { width, height, indices: [0, 0, 0] },
    { width, height, indices: [1, 2, 1], transparentIndex: 2 },
    { width, height, indices: [2, 2, 2], disposal: 3 },
    { width, height, indices: [1, 1, 1] },
    { width, height, indices: [0, 0, 0] },
  ] });
  const table = await tableOf(bytes);
  const pictures = decodeAll(bytes, table);
  check('a transparent pixel shows the frame before',
    same(pixel(pictures[1], width, 1, 0), opaque(RED)) && same(pixel(pictures[1], width, 0, 0), opaque(GREEN)),
    `${pixel(pictures[1], width, 1, 0)}`);
  const flags = table.frames.map((f) => +f.isSync).join('');
  check('keyframes: not with transparency, not when restoring to previous, else whole opaque frames',
    flags === '10011', flags);
  checkKeyframesAreRunStarts('transparency', bytes, table);
}
{
  // A frame's own colour table overrides the global one for that frame only.
  const width = 2, height = 1;
  const bytes = writeGif({ width, height, colors: [RED, GREEN], frames: [
    { width, height, indices: [0, 1] },
    { width, height, indices: [0, 1], localColors: [BLUE, WHITE] },
    { width, height, indices: [1, 0] },
  ] });
  const table = await tableOf(bytes);
  const pictures = decodeAll(bytes, table);
  check('a local colour table is used for its frame only',
    same(pixel(pictures[1], width, 0, 0), opaque(BLUE)) && same(pixel(pictures[2], width, 0, 0), opaque(GREEN)),
    `${pixel(pictures[1], width, 0, 0)} ${pixel(pictures[2], width, 0, 0)}`);
}
{
  // Interlaced rows land where they belong: the same picture stored interlaced
  // and progressive decodes to the same pixels. 19 rows so every pass is partial.
  const width = 3, height = 19;
  const colors = Array.from({ length: 32 }, (_, i) => [i * 8, 255 - i * 8, i]);
  const indices = Array.from({ length: width * height }, (_, i) => Math.floor(i / width) % 32);
  const picture = (interlaced) => {
    const bytes = writeGif({ width, height, colors,
      frames: [{ width, height, indices, interlaced, minimumCodeSize: 5 }] });
    return tableOf(bytes).then((table) => decodeAll(bytes, table)[0]);
  };
  const [interlaced, progressive] = await Promise.all([picture(true), picture(false)]);
  check('an interlaced frame decodes to the same picture as a progressive one',
    same(interlaced, progressive), `${pixel(interlaced, width, 0, 1)} vs ${pixel(progressive, width, 0, 1)}`);
  check('the progressive picture is the one written',
    same(pixel(progressive, width, 0, 5), opaque(colors[5])), `${pixel(progressive, width, 0, 5)}`);
}
{
  // A patch hanging off the canvas edge is clipped, not wrapped to the next row.
  const bytes = writeGif({ width: 3, height: 2, colors: [RED, GREEN], frames: [
    { width: 3, height: 2, indices: Array(6).fill(0) },
    { left: 2, top: 0, width: 2, height: 1, indices: [1, 1] },
  ] });
  const table = await tableOf(bytes);
  const pictures = decodeAll(bytes, table);
  check('a frame reaching past the canvas edge is clipped',
    same(pixel(pictures[1], 3, 2, 0), opaque(GREEN)) && same(pixel(pictures[1], 3, 0, 1), opaque(RED)),
    `${pixel(pictures[1], 3, 0, 1)}`);
}

// ------------------------------------------------------------------
// Damaged and unusual files.
// ------------------------------------------------------------------
{
  const frames = Array.from({ length: 3 }, (_, k) => ({ width: 8, height: 8, indices: Array(64).fill(k % 2) }));
  const whole = writeGif({ width: 8, height: 8, colors: [RED, GREEN], frames });
  const noTrailer = writeGif({ width: 8, height: 8, colors: [RED, GREEN], frames, trailer: false });
  check('a GIF without its trailer keeps every frame',
    (await tableOf(noTrailer)).frames.length === 3, `${(await tableOf(noTrailer)).frames.length}`);
  const cut = whole.subarray(0, whole.length - 6);
  const originalWarn = console.warn;
  console.warn = () => {};
  const cutTable = await tableOf(cut);
  console.warn = originalWarn;
  check('a GIF cut off mid-frame drops only the incomplete frame',
    cutTable.frames.length === 2, `${cutTable.frames.length}`);
  const notGif = await tableOf(Uint8Array.from([..."GIF00a"].map((c) => c.charCodeAt(0)).concat(Array(20).fill(0))))
    .then(() => 'accepted', (error) => error.message);
  check('a file that only resembles a GIF is refused', notGif === 'not a GIF file', notGif);
  const timedOut = await tableOf(whole, { timeoutMilliseconds: 0 })
    .then(() => null, (error) => error);
  check('a zero time budget throws IndexBudgetExceededError',
    timedOut instanceof IndexBudgetExceededError, `${timedOut && timedOut.name}`);
  const tooBig = await tableOf(whole, { maxBytes: 10 }).then(() => null, (error) => error);
  check('a tiny maxBytes throws IndexBudgetExceededError',
    tooBig instanceof IndexBudgetExceededError, `${tooBig && tooBig.name}`);

  const single = writeGif({ width: 8, height: 8, colors: [RED, GREEN], frames: frames.slice(0, 1) });
  const answers = await Promise.all([whole, single, Uint8Array.from([1, 2, 3])]
    .map((bytes) => isAnimatedGif(new Blob([bytes]))));
  check('isAnimatedGif: yes for several frames, no for one frame or not a GIF',
    answers.join(',') === 'true,false,false', answers.join(','));
}

// ------------------------------------------------------------------
// The counter fixtures, as ffmpeg writes them.
// ------------------------------------------------------------------
for (const [name, expectedKeyframes] of [['counter-vfr.gif', 1], ['counter-full-frames.gif', 30]]) {
  if (!existsSync(clip(name))) {
    console.log(`SKIP gif-table ${name}: fixture not generated (see make-test-clips.sh)`);
    continue;
  }
  const bytes = new Uint8Array(await readFile(clip(name)));
  const table = await tableOf(bytes);
  check(`${name} frame count and size`,
    table.frames.length === 30 && table.videoWidth === 150 && table.videoHeight === 90,
    `${table.frames.length} frames, ${table.videoWidth}x${table.videoHeight}`);
  check(`${name} keyframes`, table.frames.filter((f) => f.isSync).length === expectedKeyframes,
    `${table.frames.filter((f) => f.isSync).length}`);
  let contiguous = true;
  for (let k = 1; k < table.frames.length; k++) {
    const previous = table.frames[k - 1];
    if (table.frames[k].offset < previous.offset + previous.size) contiguous = false;
  }
  check(`${name} byte ranges ordered and non-overlapping`, contiguous, `${contiguous}`);
  checkKeyframesAreRunStarts(name, bytes, table);
}
if (existsSync(clip('counter-vfr.gif'))) {
  // ffmpeg wrote counter-vfr.mp4's 33 ms frames as 3 or 4 hundredths and its
  // held frames (every 5th, 66 ms) as 7: the table must carry exactly those.
  const table = await tableOf(new Uint8Array(await readFile(clip('counter-vfr.gif'))));
  const held = table.frames.map((f, k) => (f.delayCentiseconds >= 6 ? k : -1)).filter((k) => k >= 0);
  check('counter-vfr.gif holds every 5th frame', held.join(',') === '4,9,14,19,24',
    held.join(','));
}

process.exit(failures ? 1 : 0);
