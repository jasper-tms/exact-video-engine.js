// ==================================================================
// GIF — the fifth container, and the one whose "codec" this engine decodes in
// JavaScript.
//
// An animated GIF is a short clip in everything but name: a run of pictures,
// each with its own delay. It is what a great deal of shared footage actually
// is (screen captures, figure animations, behavior clips pasted into a slide),
// and every browser shows one in an <img> — but an <img> gives no frame index,
// no seeking and no stepping, and nothing that says which picture is on screen.
// So a GIF is indexed and decoded here like any other clip, and plays through
// the WebCodecs engine's owned canvas and clock.
//
// The frame table. A GIF keeps no central index, but its structure is plain:
// a header, then a sequence of blocks, each introduced by one byte — an
// extension (0x21), an image (0x2C) or the trailer (0x3B) — and every
// variable-length payload is a chain of length-prefixed sub-blocks that can be
// stepped over without being decompressed. So, like the Ogg scan, building the
// table is a sequential no-decode pass over the whole file: each image becomes
// a frame, and the Graphic Control Extension in front of it supplies its delay,
// its transparency and what happens to its pixels afterwards.
//
// Timing. A delay is stored in hundredths of a second, so the table's timescale
// is 100 and every presentation time is an exact sum of whole delays — no
// rounding, no assumed rate. One adjustment is made, and it is the one every
// renderer makes: a delay below 2 hundredths (0 or 1, which many encoders write
// meaning "as fast as possible") is shown for 10 hundredths instead. Chromium,
// Firefox, WebKit and ffmpeg all do exactly this, so the clip runs here at the
// speed the person has always seen it run. Frame NUMBERS do not depend on it at
// all; only the times attached to them do. See SHORTEST_HONORED_DELAY.
//
// Decoding. No browser has a GIF VideoDecoder, and unlike Motion JPEG the
// frames cannot be handed one at a time to the browser's image decoder: a GIF
// frame is usually a PATCH, a rectangle drawn over whatever the previous frames
// left on the canvas, with transparent pixels letting that show through, and a
// disposal method saying what to do with the rectangle afterwards (leave it,
// clear it, or put back what was under it). Showing frame n correctly means
// replaying that history. GifFrameDecoder does it in JavaScript — the LZW
// decompression and the compositing — behind the same VideoDecoder-shaped
// interface ImageFrameDecoder uses, so the engine's decode driver drives it
// unchanged. ImageDecoder would do the same work natively, but it is not in
// Safari, and a path only some browsers take is a path to be wrong in.
//
// Keyframes. Because frames depend on their predecessors, a decode run has to
// begin at a frame whose picture — and everything after it — owes nothing to
// the frames before. The scan marks those (see markKeyframes) so a cold seek
// starts as late as it honestly can. A GIF optimized frame-by-frame may have
// frame 0 as its only keyframe, in which case reaching frame n decodes every
// frame before it; GIF decoding is cheap enough that this is the ordinary cost
// for any GIF small enough to be one.
// ==================================================================

import { createRangeReader } from './range-readers.js';
import { SequentialByteCursor, IndexBudgetExceededError } from './matroska.js';

// The codec string this engine uses for GIF. WebCodecs registers none — there
// is no VideoDecoder to name — so, like MOTION_JPEG_CODEC, this is our own
// marker, carried on decoderConfig.codec and exposed as engine.codecString.
export const GIF_CODEC = 'gif';

export function isGifCodec(codec) {
  return codec === GIF_CODEC;
}

// Can this browser decode GIF frames? The compositing is all JavaScript, so the
// one thing needed from the platform is a VideoFrame built from raw RGBA
// pixels, the form the decode driver accepts frames in.
export function canDecodeGifFrames() {
  return typeof VideoFrame !== 'undefined';
}

// Delays shorter than this many hundredths of a second are shown for
// SUBSTITUTE_DELAY_CENTISECONDS instead — what Chromium, Firefox, WebKit and
// ffmpeg's GIF demuxer all do, because so many encoders write 0 meaning "no
// particular delay". Changing either constant changes only presentation times,
// never which frame a number names.
const SHORTEST_HONORED_DELAY_CENTISECONDS = 2;
const SUBSTITUTE_DELAY_CENTISECONDS = 10;

// The GIF block introducers and the extension labels the scan cares about.
const EXTENSION_INTRODUCER = 0x21;
const IMAGE_SEPARATOR = 0x2C;
const TRAILER = 0x3B;
const GRAPHIC_CONTROL_LABEL = 0xF9;
const PLAIN_TEXT_LABEL = 0x01;

// Disposal methods (GIF89a §23): what becomes of a frame's rectangle before the
// next frame is drawn. 0 (unspecified) and 1 (do not dispose) both leave it in
// place, and the undefined values 4–7 are treated the same way, as browsers do.
const DISPOSE_TO_BACKGROUND = 2;
const DISPOSE_TO_PREVIOUS = 3;

// Largest LZW minimum code size a GIF can declare: codes are at most 12 bits,
// and the first code is one bit wider than the minimum.
const LARGEST_MINIMUM_CODE_SIZE = 11;
const LARGEST_CODE_COUNT = 4096;

// Does a file start "GIF87a" or "GIF89a"? Told apart by its first bytes, like
// every other container here, never by a name or a MIME type.
export function startsWithGifSignature(bytes) {
  return bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46   // "GIF"
    && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) // "87" / "89"
    && bytes[5] === 0x61;                                            // "a"
}

function readUint16LittleEndian(cursor, offset) {
  return cursor.peek(offset) | (cursor.peek(offset + 1) << 8);
}

// Step over a chain of data sub-blocks (each a length byte and that many bytes),
// through the zero-length block that ends it.
async function skipSubBlocks(cursor) {
  for (;;) {
    await cursor.ensure(1);
    const length = cursor.peek(0);
    cursor.advance(1 + length);
    if (length === 0) return;
  }
}

// Read the frame table of a GIF: every image's byte range, delay, rectangle and
// keyframe flag, plus the canvas size and the decoder configuration.
//
//   options.timeoutMilliseconds  give up after this long (Infinity: never)
//   options.maxBytes             refuse a file bigger than this (Infinity: any)
//   options.onProgress           progress reports, as for the Matroska pass
//   options.chunkBytes           refill/progress granularity (default 1 MB)
//   options.stopAfterFrames      stop once this many frames are found (used by
//                                isAnimatedGif, which only needs to know if
//                                there is a second one)
//
// Each frame's byte range runs from its Graphic Control Extension (when it has
// one) through the end of its image data, so a frame's bytes carry everything
// the decoder needs about it except the global colour table, which travels in
// decoderConfig.description along with the logical screen descriptor.
//
// Returns { frames, videoWidth, videoHeight, decoderConfig }, frames being
// {offset, size, isSync, delayCentiseconds, left, top, width, height, disposal,
// hasTransparency} in file (= decode = display) order. Throws
// IndexBudgetExceededError on a limit, and a plain Error for a file that is not
// a GIF we can read.
export async function readGifFrameTable(reader, options = {}) {
  const timeoutMilliseconds = (options.timeoutMilliseconds === undefined)
    ? Infinity : options.timeoutMilliseconds;
  const maxBytes = (options.maxBytes === undefined) ? Infinity : options.maxBytes;
  const stopAfterFrames = options.stopAfterFrames || Infinity;
  // Indexing a GIF means reading all of it, so an oversized file is refused up
  // front, as the other full-file passes do. (A partial look for isAnimatedGif
  // reads only as far as its second frame, so the gate does not apply to it.)
  if (stopAfterFrames === Infinity && reader.size > maxBytes) {
    throw new IndexBudgetExceededError(
      `GIF is ${reader.size} bytes; indexing it means reading all of them, and `
      + `the caller's limit is ${maxBytes}`);
  }
  if (!(timeoutMilliseconds > 0)) {
    throw new IndexBudgetExceededError('no time allowed to index this GIF');
  }

  const onProgress = (typeof options.onProgress === 'function') ? options.onProgress : null;
  const startedAt = performance.now();
  let lastYieldedAt = startedAt;
  const frames = [];

  const report = (bytesRead) => {
    if (!onProgress) return;
    const elapsedMs = performance.now() - startedAt;
    const fraction = reader.size ? Math.min(1, bytesRead / reader.size) : 1;
    const etaMs = (fraction > 0 && fraction < 1) ? elapsedMs * (1 - fraction) / fraction : 0;
    try {
      onProgress({
        bytesRead, totalBytes: reader.size, fraction, elapsedMs, etaMs,
        framesFound: frames.length,
      });
    } catch (progressError) {
      // An indicator that throws is the host's bug, not ours; keep indexing.
    }
  };

  const cursor = new SequentialByteCursor(reader, {
    chunkBytes: options.chunkBytes,
    beforeRefill: async () => {
      const now = performance.now();
      if (now - startedAt > timeoutMilliseconds) {
        throw new IndexBudgetExceededError(
          `indexing this GIF did not finish within ${timeoutMilliseconds} ms `
          + `(read ${cursor.position} of ${reader.size} bytes)`);
      }
      report(cursor.position);
      if (now - lastYieldedAt > 16) {
        lastYieldedAt = now;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  });

  // Header and logical screen descriptor: 6 + 7 bytes, then the global colour
  // table if the descriptor announces one.
  await cursor.ensure(13);
  const signature = new Uint8Array(6);
  for (let i = 0; i < 6; i++) signature[i] = cursor.peek(i);
  if (!startsWithGifSignature(signature)) throw new Error('not a GIF file');
  let canvasWidth = readUint16LittleEndian(cursor, 6);
  let canvasHeight = readUint16LittleEndian(cursor, 8);
  const screenFlags = cursor.peek(10);
  const globalColorTableBytes = (screenFlags & 0x80) ? 3 * (2 << (screenFlags & 0x07)) : 0;
  await cursor.ensure(13 + globalColorTableBytes);
  // The descriptor and the global colour table, verbatim: what the decoder needs
  // and the frames' own bytes do not carry. (The descriptor's pixel aspect ratio
  // byte is ignored, as every browser ignores it, so GIF pixels are square.)
  const description = new Uint8Array(7 + globalColorTableBytes);
  for (let i = 0; i < description.length; i++) description[i] = cursor.peek(6 + i);
  cursor.advance(13 + globalColorTableBytes);

  // The Graphic Control Extension seen since the last image, which applies to
  // the next one: its file offset (where that frame's bytes begin) and fields.
  let pendingControl = null;
  let stoppedEarlyBecause = null;

  try {
    while (frames.length < stopAfterFrames) {
      // A GIF without its trailer is common (truncated downloads, sloppy
      // writers) and every browser shows the frames it has; so do we.
      if (cursor.atEnd) break;
      await cursor.ensure(1);
      const introducer = cursor.peek(0);
      if (introducer === TRAILER) break;

      if (introducer === EXTENSION_INTRODUCER) {
        const extensionOffset = cursor.position;
        await cursor.ensure(2);
        const label = cursor.peek(1);
        cursor.advance(2);
        if (label === GRAPHIC_CONTROL_LABEL) {
          await cursor.ensure(1);
          const blockLength = cursor.peek(0);
          if (blockLength >= 4) {
            await cursor.ensure(5);
            const flags = cursor.peek(1);
            pendingControl = {
              offset: extensionOffset,
              disposal: (flags >> 2) & 0x07,
              hasTransparency: !!(flags & 0x01),
              delayCentiseconds: readUint16LittleEndian(cursor, 2),
            };
          }
        } else if (label === PLAIN_TEXT_LABEL) {
          // A control extension in front of a plain text block belongs to that
          // block, not to the next image. (Browsers render no plain text blocks,
          // so the block itself is simply stepped over.)
          pendingControl = null;
        }
        await skipSubBlocks(cursor);
        continue;
      }

      if (introducer === IMAGE_SEPARATOR) {
        const imageOffset = cursor.position;
        await cursor.ensure(10);
        const left = readUint16LittleEndian(cursor, 1);
        const top = readUint16LittleEndian(cursor, 3);
        const width = readUint16LittleEndian(cursor, 5);
        const height = readUint16LittleEndian(cursor, 7);
        const imageFlags = cursor.peek(9);
        const localColorTableBytes = (imageFlags & 0x80) ? 3 * (2 << (imageFlags & 0x07)) : 0;
        cursor.advance(10 + localColorTableBytes);
        await cursor.ensure(1);
        const minimumCodeSize = cursor.peek(0);
        if (minimumCodeSize < 1 || minimumCodeSize > LARGEST_MINIMUM_CODE_SIZE) {
          throw new Error(`GIF frame ${frames.length} declares an impossible LZW `
            + `code size (${minimumCodeSize})`);
        }
        cursor.advance(1);
        await skipSubBlocks(cursor);
        const offset = pendingControl ? pendingControl.offset : imageOffset;
        const storedDelay = pendingControl ? pendingControl.delayCentiseconds : 0;
        frames.push({
          offset,
          size: cursor.position - offset,
          isSync: false,   // decided once every frame is known, in markKeyframes
          delayCentiseconds: storedDelay < SHORTEST_HONORED_DELAY_CENTISECONDS
            ? SUBSTITUTE_DELAY_CENTISECONDS : storedDelay,
          left, top, width, height,
          disposal: pendingControl ? pendingControl.disposal : 0,
          hasTransparency: pendingControl ? pendingControl.hasTransparency : false,
        });
        pendingControl = null;
        continue;
      }

      // Anything else means the block structure has been lost. Browsers stop
      // drawing there and keep what came before; frames already read are whole
      // and exactly numbered, so keep them too — but a file that never got as
      // far as one frame is not a GIF we can read.
      stoppedEarlyBecause = `unexpected byte 0x${introducer.toString(16)} at offset `
        + `${cursor.position}`;
      break;
    }
  } catch (error) {
    // Running out of budget is the caller's limit, not the file's fault: say so.
    if (error instanceof IndexBudgetExceededError) throw error;
    // Otherwise the file ended inside a block — a truncated GIF. The frame that
    // was being read is incomplete and is dropped; the ones before it stand.
    stoppedEarlyBecause = error && error.message;
  }
  if (!frames.length) {
    throw new Error('this GIF contains no complete frames'
      + (stoppedEarlyBecause ? ` (${stoppedEarlyBecause})` : ''));
  }
  if (stoppedEarlyBecause && stopAfterFrames === Infinity) {
    console.warn(`exact-video-engine: this GIF's data ends early (${stoppedEarlyBecause}); `
      + `indexing the ${frames.length} complete frames before that point.`);
  }

  // A logical screen of zero size is invalid but turns up; browsers then size
  // the canvas to the frames, and so do we.
  if (!canvasWidth || !canvasHeight) {
    canvasWidth = Math.max(...frames.map((frame) => frame.left + frame.width));
    canvasHeight = Math.max(...frames.map((frame) => frame.top + frame.height));
  }
  markKeyframes(frames, canvasWidth, canvasHeight);
  report(cursor.position);

  return {
    frames,
    videoWidth: canvasWidth,
    videoHeight: canvasHeight,
    decoderConfig: {
      codec: GIF_CODEC,
      codedWidth: canvasWidth,
      codedHeight: canvasHeight,
      description,
    },
  };
}

// Mark the frames a decode run may start from: those whose picture, and the
// canvas every later frame is drawn onto, are the same whatever came before.
// A frame qualifies when
//   * it is frame 0 (nothing came before), or
//   * the frame before it covered the whole canvas and disposed to background,
//     so the canvas is blank when this frame is drawn, or
//   * it covers the whole canvas with no transparent pixels, so it overwrites
//     everything — unless it disposes to PREVIOUS, which afterwards restores
//     the canvas from before it, history and all.
// The flags are read from the control extension, not from decoded pixels, so a
// frame that declares a transparent colour and never uses it does not qualify.
// That costs only speed (a run starts earlier than it had to), never exactness.
function markKeyframes(frames, canvasWidth, canvasHeight) {
  const coversCanvas = (frame) => frame.left === 0 && frame.top === 0
    && frame.width >= canvasWidth && frame.height >= canvasHeight;
  for (let k = 0; k < frames.length; k++) {
    const frame = frames[k];
    const previous = frames[k - 1];
    frame.isSync = k === 0
      || (coversCanvas(previous) && previous.disposal === DISPOSE_TO_BACKGROUND)
      || (coversCanvas(frame) && !frame.hasTransparency
        && frame.disposal !== DISPOSE_TO_PREVIOUS);
  }
}

// Does this source hold a GIF with more than one frame? For a host deciding
// whether to open a .gif as a still image or as a clip: it reads only as far as
// the second frame, so it costs a fraction of indexing the whole file. Not a
// GIF at all, or unreadable, answers false.
export async function isAnimatedGif(source) {
  try {
    const reader = createRangeReader(source);
    await reader.init();
    if (reader.size < 13) return false;
    const signature = new Uint8Array(await reader.read(0, 5));
    if (!startsWithGifSignature(signature)) return false;
    const table = await readGifFrameTable(reader, { stopAfterFrames: 2 });
    return table.frames.length > 1;
  } catch (error) {
    return false;
  }
}

// ------------------------------------------------------------------
// Decoding: LZW decompression and compositing, in plain JavaScript.
// ------------------------------------------------------------------


// Decompress one frame's LZW image data into colour indices, at most
// pixelCount of them. Returns the indices and how many were produced: a frame
// whose data runs short (or turns corrupt) leaves its remaining pixels
// undrawn, which is what browsers show.
export function decodeGifLzw(minimumCodeSize, data, pixelCount) {
  const indices = new Uint8Array(pixelCount);
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  // The string table, as prefix links and final bytes; a string is read out
  // backwards onto `stack` and then emitted in order.
  const prefix = new Uint16Array(LARGEST_CODE_COUNT);
  const suffix = new Uint8Array(LARGEST_CODE_COUNT);
  const stack = new Uint8Array(LARGEST_CODE_COUNT + 1);
  for (let code = 0; code < clearCode; code++) suffix[code] = code;

  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let previousCode = -1;
  let firstByteOfPrevious = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  let position = 0;
  let count = 0;

  while (count < pixelCount) {
    while (bitCount < codeSize) {
      if (position >= data.length) return { indices, count };
      bitBuffer |= data[position++] << bitCount;
      bitCount += 8;
    }
    let code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>>= codeSize;
    bitCount -= codeSize;

    if (code === clearCode) {
      codeSize = minimumCodeSize + 1;
      nextCode = endCode + 1;
      previousCode = -1;
      continue;
    }
    if (code === endCode) break;
    if (previousCode === -1) {
      // The first code after a clear names a single colour; nothing to add yet.
      if (code >= clearCode) break;   // corrupt: stop drawing, as browsers do
      indices[count++] = code;
      previousCode = code;
      firstByteOfPrevious = code;
      continue;
    }

    const codeAsRead = code;
    let stackHeight = 0;
    if (code >= nextCode) {
      // The one code that may name the entry about to be made: the previous
      // string plus its own first byte.
      if (code > nextCode) break;     // corrupt
      stack[stackHeight++] = firstByteOfPrevious;
      code = previousCode;
    }
    while (code > endCode) {
      stack[stackHeight++] = suffix[code];
      code = prefix[code];
    }
    firstByteOfPrevious = code;
    stack[stackHeight++] = code;

    if (nextCode < LARGEST_CODE_COUNT) {
      prefix[nextCode] = previousCode;
      suffix[nextCode] = firstByteOfPrevious;
      nextCode += 1;
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    previousCode = codeAsRead;
    while (stackHeight > 0 && count < pixelCount) indices[count++] = stack[--stackHeight];
  }
  return { indices, count };
}

// Pull one frame's fields out of its sample bytes (see readGifFrameTable for
// what a sample spans): the control extension's disposal and transparency, the
// image descriptor, the local colour table, and the LZW data with its sub-block
// length bytes removed.
export function parseGifFrameSample(bytes) {
  const frame = {
    disposal: 0, hasTransparency: false, transparentIndex: -1,
    left: 0, top: 0, width: 0, height: 0, interlaced: false,
    localColorTable: null, minimumCodeSize: 2, imageData: new Uint8Array(0),
  };
  let position = 0;
  const readUint16 = (at) => bytes[at] | (bytes[at + 1] << 8);
  // Returns the position just past a sub-block chain, collecting its data when
  // asked to.
  const walkSubBlocks = (start, pieces) => {
    let at = start;
    while (at < bytes.length) {
      const length = bytes[at];
      if (length === 0) return at + 1;
      if (pieces) pieces.push(bytes.subarray(at + 1, Math.min(bytes.length, at + 1 + length)));
      at += 1 + length;
    }
    return at;
  };

  while (position < bytes.length && bytes[position] === EXTENSION_INTRODUCER) {
    const label = bytes[position + 1];
    if (label === GRAPHIC_CONTROL_LABEL && bytes[position + 2] >= 4) {
      const flags = bytes[position + 3];
      frame.disposal = (flags >> 2) & 0x07;
      frame.hasTransparency = !!(flags & 0x01);
      frame.transparentIndex = bytes[position + 6];
    }
    position = walkSubBlocks(position + 2, null);
  }
  if (bytes[position] !== IMAGE_SEPARATOR) {
    throw new Error('GIF frame sample holds no image descriptor');
  }
  frame.left = readUint16(position + 1);
  frame.top = readUint16(position + 3);
  frame.width = readUint16(position + 5);
  frame.height = readUint16(position + 7);
  const imageFlags = bytes[position + 9];
  frame.interlaced = !!(imageFlags & 0x40);
  position += 10;
  if (imageFlags & 0x80) {
    const tableBytes = 3 * (2 << (imageFlags & 0x07));
    frame.localColorTable = bytes.subarray(position, position + tableBytes);
    position += tableBytes;
  }
  frame.minimumCodeSize = bytes[position];
  const pieces = [];
  walkSubBlocks(position + 1, pieces);
  const imageData = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let filled = 0;
  for (const piece of pieces) { imageData.set(piece, filled); filled += piece.length; }
  frame.imageData = imageData;
  return frame;
}

// The row each successive line of an interlaced image lands on: every 8th row
// from 0, every 8th from 4, every 4th from 2, then every 2nd from 1.
function interlacedRowOrder(height) {
  const rows = new Int32Array(height);
  let line = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let row = start; row < height; row += step) rows[line++] = row;
  }
  return rows;
}

// Replays a GIF's frames onto an RGBA canvas, one frame's bytes at a time, in
// decode order from a keyframe. Pure JavaScript with no browser objects, so it
// is testable in plain Node; GifFrameDecoder wraps it for the decode driver.
export class GifCompositor {
  // description: decoderConfig.description — the logical screen descriptor
  // followed by the global colour table (see readGifFrameTable).
  constructor(description, width, height) {
    this.width = width;
    this.height = height;
    const flags = description.length >= 7 ? description[4] : 0;
    this.globalColorTable = (flags & 0x80)
      ? description.subarray(7, 7 + 3 * (2 << (flags & 0x07))) : null;
    this.reset();
  }

  // Back to the state before frame 0: a fully transparent canvas. A decode run
  // only ever starts at a keyframe, and a keyframe is by definition a frame
  // that this state cannot affect.
  reset() {
    this.canvas = new Uint8ClampedArray(this.width * this.height * 4);
    // What the previous frame's disposal method asks for before the next frame
    // is drawn: {method, left, top, right, bottom, savedPixels}.
    this._pendingDisposal = null;
  }

  // Draw one frame (its sample bytes) and return the canvas, which the caller
  // must copy before the next call.
  composite(bytes) {
    const frame = parseGifFrameSample(bytes);
    this._applyPendingDisposal();

    // The frame's rectangle, clipped to the canvas.
    const left = Math.min(frame.left, this.width);
    const top = Math.min(frame.top, this.height);
    const right = Math.min(frame.left + frame.width, this.width);
    const bottom = Math.min(frame.top + frame.height, this.height);
    const savedPixels = (frame.disposal === DISPOSE_TO_PREVIOUS)
      ? this._copyRectangle(left, top, right, bottom) : null;

    // A frame with no colour table at all (neither its own nor a global one)
    // has nothing to draw with; its pixels stay as they were.
    const colorTable = frame.localColorTable || this.globalColorTable;
    const colorCount = colorTable ? Math.floor(colorTable.length / 3) : 0;
    const { indices, count } = decodeGifLzw(
      Math.min(frame.minimumCodeSize, LARGEST_MINIMUM_CODE_SIZE), frame.imageData,
      frame.width * frame.height);
    const rows = frame.interlaced ? interlacedRowOrder(frame.height) : null;
    const transparentIndex = frame.hasTransparency ? frame.transparentIndex : -1;

    const canvas = this.canvas;
    for (let line = 0; line < frame.height; line++) {
      const lineStart = line * frame.width;
      if (lineStart >= count) break;
      const y = frame.top + (rows ? rows[line] : line);
      if (y >= bottom) continue;
      const lineEnd = Math.min(count, lineStart + Math.min(frame.width, right - frame.left));
      let target = (y * this.width + frame.left) * 4;
      for (let source = lineStart; source < lineEnd; source++, target += 4) {
        const colorIndex = indices[source];
        // Out-of-range indices are drawn as nothing, like the transparent one.
        if (colorIndex === transparentIndex || colorIndex >= colorCount) continue;
        canvas[target] = colorTable[colorIndex * 3];
        canvas[target + 1] = colorTable[colorIndex * 3 + 1];
        canvas[target + 2] = colorTable[colorIndex * 3 + 2];
        canvas[target + 3] = 255;
      }
    }

    this._pendingDisposal = { method: frame.disposal, left, top, right, bottom, savedPixels };
    return canvas;
  }

  _applyPendingDisposal() {
    const disposal = this._pendingDisposal;
    if (!disposal) return;
    this._pendingDisposal = null;
    const { left, top, right, bottom } = disposal;
    if (disposal.method === DISPOSE_TO_BACKGROUND) {
      // Every browser clears to transparent rather than to the background
      // colour the logical screen names, and so do we.
      for (let y = top; y < bottom; y++) {
        this.canvas.fill(0, (y * this.width + left) * 4, (y * this.width + right) * 4);
      }
    } else if (disposal.method === DISPOSE_TO_PREVIOUS) {
      const rowBytes = (right - left) * 4;
      for (let y = top; y < bottom; y++) {
        this.canvas.set(
          disposal.savedPixels.subarray((y - top) * rowBytes, (y - top + 1) * rowBytes),
          (y * this.width + left) * 4);
      }
    }
  }

  _copyRectangle(left, top, right, bottom) {
    const rowBytes = (right - left) * 4;
    const copy = new Uint8ClampedArray(rowBytes * (bottom - top));
    for (let y = top; y < bottom; y++) {
      const start = (y * this.width + left) * 4;
      copy.set(this.canvas.subarray(start, start + rowBytes), (y - top) * rowBytes);
    }
    return copy;
  }
}

// A VideoDecoder in shape — same constructor, configure / decode / flush /
// reset / close, decodeQueueSize and output callback — so the engine's decode
// driver uses it exactly as it uses ImageFrameDecoder or a real VideoDecoder.
// Unlike ImageFrameDecoder it keeps state between frames (the canvas), and it
// relies on the driver's ordinary contract for that: reset() before each run,
// and each run starting at a keyframe the index marked.
export class GifFrameDecoder {
  constructor({ output, error }) {
    this._output = output;
    this._onError = error;
    this.state = 'unconfigured';   // 'unconfigured' | 'configured' | 'closed'
    this.decodeQueueSize = 0;
    this._compositor = null;
    // Frames go through one at a time, in order, and come out asynchronously
    // as a VideoDecoder's do. Bumped by reset() and close() so work queued
    // against a previous run is dropped rather than drawn onto the next one.
    this._chain = Promise.resolve();
    this._generation = 0;
  }

  configure(config) {
    if (this.state === 'closed') throw new Error('GifFrameDecoder is closed');
    if (!config || !isGifCodec(config.codec)) {
      throw new TypeError(`GifFrameDecoder cannot decode '${config && config.codec}'`);
    }
    const given = config.description;
    const description = given instanceof Uint8Array ? given
      : ArrayBuffer.isView(given)
        ? new Uint8Array(given.buffer, given.byteOffset, given.byteLength)
        : new Uint8Array(given || 0);
    if (!this._compositor
        || this._compositor.width !== config.codedWidth
        || this._compositor.height !== config.codedHeight) {
      this._compositor = new GifCompositor(description, config.codedWidth, config.codedHeight);
    } else {
      this._compositor.reset();
    }
    this.state = 'configured';
  }

  decode(chunk) {
    if (this.state !== 'configured') throw new Error('GifFrameDecoder is not configured');
    // Copied now: the caller may reuse the chunk the moment decode() returns.
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    const { timestamp, duration } = chunk;
    const generation = this._generation;
    this.decodeQueueSize += 1;
    this._chain = this._chain
      .then(() => this._decodeOne(bytes, timestamp, duration, generation))
      .then(() => { this.decodeQueueSize -= 1; },
        () => { this.decodeQueueSize -= 1; });
  }

  _decodeOne(bytes, timestamp, duration, generation) {
    if (generation !== this._generation || this.state !== 'configured') return;
    try {
      const canvas = this._compositor.composite(bytes);
      // The VideoFrame constructor copies the pixels, so the canvas is free to
      // be drawn on again straight away.
      this._output(new VideoFrame(canvas, {
        format: 'RGBA',
        codedWidth: this._compositor.width,
        codedHeight: this._compositor.height,
        timestamp,
        duration,
      }));
    } catch (error) {
      // Fatal, as a VideoDecoder error is: the engine marks itself failed and
      // tells the host, rather than show a picture built on a broken frame.
      this.state = 'closed';
      this._onError(error);
    }
  }

  async flush() {
    await this._chain;
  }

  reset() {
    this._generation += 1;
    this._chain = Promise.resolve();
    this.decodeQueueSize = 0;
    this.state = 'unconfigured';
  }

  close() {
    this._generation += 1;
    this._chain = Promise.resolve();
    this.decodeQueueSize = 0;
    this._compositor = null;
    this.state = 'closed';
  }
}
