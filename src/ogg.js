// ==================================================================
// Ogg/Theora frame table — the third way to get real timestamps.
//
// Firefox plays Ogg/Theora, so it is a format worth an exact index, and like
// WebM it carries no central sample table: the timing lives inline, spread
// across every page, so there is no way to build the frame table without a
// sequential pass over the whole file. This is the same shape and cost as the
// Matroska scan (SequentialByteCursor, a budget, onProgress ticks, event-loop
// yields), and it decodes nothing — it reads page headers and skips every
// packet's payload, with the single exception of the Theora identification
// header, whose 42 bytes give us the frame rate and picture dimensions.
//
// Theora is a constant-frame-duration codec by design: every packet after the
// three header packets is exactly one video frame (a zero-length packet is a
// duplicate of the previous frame — still one frame), and frame n is presented
// at n * FRD / FRN seconds. We still build the table per-frame from the
// container's REAL packet count rather than trusting a declared rate, because a
// truncated or malformed stream can carry fewer packets than its header claims,
// and the whole point of this engine is to number the frames that are actually
// there. As a second, independent check we reconcile that packet count against
// the granule position Theora writes on its pages (see the sanity check below):
// if the container's own two accounts of "how many frames" disagree, this is a
// file we would mis-index, and we refuse it rather than guess.
//
// Two byte orders live in one file, which is a rich source of bugs: the Ogg
// page layer (capture pattern, granule position, serial numbers, sequence
// numbers) is LITTLE-endian, while every multi-byte integer inside a Theora
// header is BIG-endian. Each read below says which it is.
// ==================================================================

import { SequentialByteCursor, IndexBudgetExceededError } from './matroska.js';

// The 7-byte identifier that opens a Theora identification header packet: the
// packet-type byte 0x80 (bit 7 set = a header packet) followed by "theora".
const THEORA_SIGNATURE = [0x80, 0x74, 0x68, 0x65, 0x6F, 0x72, 0x61];   // 0x80 "theora"

// Ogg page header flag (the header_type byte). Only the beginning-of-stream bit
// matters to us: it marks the page whose first packet is a codec's identification
// header, which is where we find (and identify) the Theora stream. The
// continued-packet bit (0x01) and end-of-stream bit (0x04) need no handling —
// the lacing-value packet accounting below is immune to page boundaries, and the
// pass simply runs to the file's end.
const OGG_FLAG_BEGIN_OF_STREAM = 0x02;

// The three non-frame packets every Theora logical stream begins with:
// identification, comment, and setup headers. Every later packet is a frame.
const THEORA_HEADER_PACKET_COUNT = 3;

// A little-endian unsigned integer of `byteCount` bytes, read from the cursor at
// `offset` from its current position (bytes the caller has already ensure()d).
// Ogg's page layer is little-endian; this reads its serial numbers and such.
function readLittleEndian(cursor, offset, byteCount) {
  let value = 0;
  for (let i = byteCount - 1; i >= 0; i--) value = value * 256 + cursor.peek(offset + i);
  return value;
}

// A big-endian unsigned integer of `byteCount` bytes, read from a byte array at
// `offset`. Every multi-byte field inside a Theora header is big-endian, the
// opposite of the Ogg page layer around it.
function readBigEndian(bytes, offset, byteCount) {
  let value = 0;
  for (let i = 0; i < byteCount; i++) value = value * 256 + bytes[offset + i];
  return value;
}

// Parse the Theora identification header (Theora spec 6.1). `bytes` is the first
// packet's payload starting at the 0x80 signature; it is a fixed 42-byte layout.
// Returns the frame-rate rational, the keyframe-granule shift, the bitstream
// revision, and the picture dimensions. All fields are big-endian.
function parseTheoraIdentificationHeader(bytes) {
  // bytes[0..6] is the 0x80 "theora" signature, already checked by the caller.
  const versionMajor = bytes[7];
  const versionMinor = bytes[8];
  const versionRevision = bytes[9];
  if (versionMajor !== 3) {
    throw new Error(`unsupported Theora bitstream version ${versionMajor}.${versionMinor}.${versionRevision}`);
  }
  // Frame dimensions in macroblocks (16 px each), a fallback for the picture size.
  const frameWidthMacroblocks = readBigEndian(bytes, 10, 2);    // FMBW
  const frameHeightMacroblocks = readBigEndian(bytes, 12, 2);   // FMBH
  const pictureWidth = readBigEndian(bytes, 14, 3);             // PICW (24-bit)
  const pictureHeight = readBigEndian(bytes, 17, 3);            // PICH (24-bit)
  // bytes[20] PICX, bytes[21] PICY — the picture's offset within the frame; the
  // timeline does not care where the picture sits, only how big it is.
  const frameRateNumerator = readBigEndian(bytes, 22, 4);      // FRN
  const frameRateDenominator = readBigEndian(bytes, 26, 4);    // FRD
  // bytes[30..32] PARN, bytes[33..35] PARD (pixel aspect ratio), bytes[36] CS
  // (colorspace), bytes[37..39] NOMBR (nominal bitrate) — none affect timing.

  // The last two bytes pack four fields, read most-significant-bit first across
  // the 16-bit big-endian value: QUAL(6) KFGSHIFT(5) PF(2) Res(3). Only the
  // keyframe-granule shift matters here — it is how a Theora granule position
  // splits into (keyframe number, frames since keyframe).
  const packed = (bytes[40] << 8) | bytes[41];
  const keyframeGranuleShift = (packed >> 5) & 0x1F;

  if (!(frameRateNumerator > 0) || !(frameRateDenominator > 0)) {
    throw new Error(
      `Theora header declares a nonsensical frame rate ${frameRateNumerator}/${frameRateDenominator}`);
  }

  return {
    versionRevision,
    frameRateNumerator,
    frameRateDenominator,
    keyframeGranuleShift,
    // PICW/PICH are the real display size; fall back to the macroblock-rounded
    // frame size only when a header leaves the picture dimensions at zero.
    videoWidth: pictureWidth || frameWidthMacroblocks * 16,
    videoHeight: pictureHeight || frameHeightMacroblocks * 16,
  };
}

// The number of frames a Theora granule position encodes. Theora packs the last
// keyframe's frame number in the high bits and the count of frames since that
// keyframe in the low bits (the split point is KFGSHIFT), and their sum is the
// absolute frame position. A BigInt because a granule position is a full 64-bit
// field. From bitstream revision 1 on (Theora 3.2.1+, which is what ffmpeg and
// every current encoder emit) this sum equals the frame COUNT, i.e. the number
// of frames presented up to and including the last one completing on the page;
// revision 0 made it the frame INDEX, one less, so we add one back to compare
// counts to counts.
function granuleToFrameCount(granulePosition, keyframeGranuleShift, versionRevision) {
  const shift = BigInt(keyframeGranuleShift);
  const mask = (1n << shift) - 1n;
  const keyframeNumber = granulePosition >> shift;
  const framesSinceKeyframe = granulePosition & mask;
  const framePosition = keyframeNumber + framesSinceKeyframe;
  const count = versionRevision >= 1 ? framePosition : framePosition + 1n;
  return Number(count);
}

// Read the frame table of an Ogg file's first (and only) Theora video stream.
//
// The options contract, budget behaviour, progress reports, and return shape all
// mirror readMatroskaFrameTable exactly:
//   options.timeoutMilliseconds  give up after this long (Infinity: never)
//   options.maxBytes             refuse a file bigger than this (Infinity: any)
//   options.onProgress           called ~once per chunk with a progress report
//                                (same shape as the Matroska pass), and once more
//                                at 100% when it finishes; a throw from it is
//                                swallowed so a buggy indicator cannot abort a load.
//   options.chunkBytes           refill/progress granularity (default 1 MB)
//
// Returns {presentationTimes (seconds, presentation order, first frame at t = 0),
// defaultFrameDuration (seconds), videoWidth, videoHeight}. Throws
// IndexBudgetExceededError when it runs out of budget, and a plain Error when the
// file is not a single-Theora-stream Ogg we can trust.
export async function readOggFrameTable(reader, options = {}) {
  const timeoutMilliseconds = (options.timeoutMilliseconds === undefined)
    ? Infinity : options.timeoutMilliseconds;
  const maxBytes = (options.maxBytes === undefined) ? Infinity : options.maxBytes;
  // Indexing an Ogg means reading all of it (no central index), so an oversized
  // file is refused up front, before a single byte of the pass — the same gate
  // the Matroska pass applies.
  if (reader.size > maxBytes) {
    throw new IndexBudgetExceededError(
      `Ogg is ${reader.size} bytes; indexing it means reading all of them, and `
      + `the caller's limit is ${maxBytes}`);
  }
  if (!(timeoutMilliseconds > 0)) {
    throw new IndexBudgetExceededError('no time allowed to index this Ogg');
  }

  const onProgress = (typeof options.onProgress === 'function') ? options.onProgress : null;

  const startedAt = performance.now();
  let lastYieldedAt = startedAt;

  const state = {
    theoraSerialNumber: null,   // the video stream's bitstream_serial_number
    header: null,               // parsed Theora identification header
    // Every completed packet on the Theora stream's pages, counted as it passes.
    // The video frame count is this minus the three Theora header packets.
    theoraPacketsCompleted: 0,
    startOffsetChecked: false,  // have we validated the stream starts at frame 0 yet
    lastGranuleFrameCount: null,   // granule-derived count on the last page that carried one
  };

  // The video frames seen so far: total Theora packets minus the three headers,
  // never negative (before the headers have all passed it reads as zero).
  const videoFramesSoFar = () => Math.max(0, state.theoraPacketsCompleted - THEORA_HEADER_PACKET_COUNT);

  // A progress report, identical in shape to the Matroska pass's report(): the
  // only field that needs explaining is framesFound, which here is the best-effort
  // running video-frame count (completed Theora packets minus the three headers).
  const report = (bytesRead) => {
    if (!onProgress) return;
    const elapsedMs = performance.now() - startedAt;
    const fraction = reader.size ? Math.min(1, bytesRead / reader.size) : 1;
    const etaMs = (fraction > 0 && fraction < 1) ? elapsedMs * (1 - fraction) / fraction : 0;
    try {
      onProgress({
        bytesRead, totalBytes: reader.size, fraction, elapsedMs, etaMs,
        framesFound: videoFramesSoFar(),
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
          `indexing this Ogg did not finish within ${timeoutMilliseconds} ms `
          + `(read ${cursor.position} of ${reader.size} bytes)`);
      }
      report(cursor.position);
      if (now - lastYieldedAt > 16) {
        lastYieldedAt = now;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  });

  // Walk every page in file order. Pages are laid out contiguously, so after
  // skipping one page's body the cursor sits exactly on the next page's capture
  // pattern; a mismatch means we have lost sync, which for our "index or refuse"
  // contract is a file we hand back rather than guess our way through.
  while (!cursor.atEnd) {
    await readOggPage(cursor, state);
  }

  if (state.theoraSerialNumber === null) {
    throw new Error('no Theora video stream in this Ogg file');
  }

  const videoFrames = videoFramesSoFar();
  if (videoFrames <= 0) {
    throw new Error('the Theora stream in this Ogg file carries no video frames');
  }

  // Final reconciliation: the packet count and the last granule position are the
  // container's two independent accounts of how many frames there are, and they
  // must agree (±1, to absorb whether the very last packet's page had already
  // written its granule). A larger gap is a stream we would mis-index.
  if (state.lastGranuleFrameCount !== null
      && Math.abs(state.lastGranuleFrameCount - videoFrames) > 1) {
    throw new Error(
      `Theora granule positions and packet count disagree: granules say `
      + `${state.lastGranuleFrameCount} frames, packets say ${videoFrames}`);
  }

  const { frameRateNumerator, frameRateDenominator, videoWidth, videoHeight } = state.header;
  const frameDurationSeconds = frameRateDenominator / frameRateNumerator;
  // presentationTimes[n] = n * FRD / FRN. Built from the real per-frame packet
  // count above, not assumed from a declared rate — Theora's constant frame
  // duration is a fact about the codec, but "how many frames" is a fact about
  // this file, which is what we counted.
  const presentationTimes = new Array(videoFrames);
  for (let n = 0; n < videoFrames; n++) {
    presentationTimes[n] = n * frameRateDenominator / frameRateNumerator;
  }

  report(reader.size);   // a final 100% tick, so the host can settle the bar
  return {
    presentationTimes,
    defaultFrameDuration: frameDurationSeconds,
    videoWidth,
    videoHeight,
  };
}

// Read one Ogg page: its 27-byte header, its segment (lacing) table, and — only
// for a Theora page — the packet accounting its lacing values imply. The body is
// otherwise skipped, exactly like a Matroska block's payload. Leaves the cursor
// on the start of the next page.
async function readOggPage(cursor, state) {
  // The fixed part of the header is 27 bytes; page_segments (byte 26) then says
  // how many lacing values follow.
  await cursor.ensure(27);
  if (cursor.peek(0) !== 0x4F || cursor.peek(1) !== 0x67
      || cursor.peek(2) !== 0x67 || cursor.peek(3) !== 0x53) {   // "OggS"
    throw new Error('lost Ogg page sync (no OggS capture pattern where a page should start)');
  }
  const version = cursor.peek(4);
  if (version !== 0) throw new Error(`unsupported Ogg page version ${version}`);
  const headerType = cursor.peek(5);
  // granule_position: 8 bytes little-endian. All-ones (0xFFFF...FFFF, i.e. -1)
  // means no packet finishes on this page, so it carries no frame position.
  let granuleAllOnes = true;
  for (let i = 0; i < 8; i++) if (cursor.peek(6 + i) !== 0xFF) granuleAllOnes = false;
  const serialNumber = readLittleEndian(cursor, 14, 4);
  const pageSegments = cursor.peek(26);

  // Pull in the lacing table, then sum it for the body size. Each lacing value
  // is 0..255; a value < 255 terminates a packet, a value of exactly 255 means
  // the packet continues into the next segment (or, at the page's end, the next
  // page). So the number of packets that COMPLETE on this page is simply the
  // count of lacing values below 255 — page boundaries and continuations fall
  // out of that count for free.
  await cursor.ensure(27 + pageSegments);
  let bodySize = 0;
  let packetsCompletedThisPage = 0;
  for (let i = 0; i < pageSegments; i++) {
    const lacing = cursor.peek(27 + i);
    bodySize += lacing;
    if (lacing < 255) packetsCompletedThisPage += 1;
  }
  const headerSize = 27 + pageSegments;

  const isBeginOfStream = !!(headerType & OGG_FLAG_BEGIN_OF_STREAM);

  // A beginning-of-stream page opens a logical stream; its first packet is that
  // codec's identification header. We only need the first 7 bytes to tell whether
  // it is Theora, and the whole 42-byte header if it is. Non-Theora streams
  // (Vorbis audio, Skeleton metadata, …) are recognised here only so we can
  // ignore their pages.
  if (isBeginOfStream && bodySize >= THEORA_SIGNATURE.length) {
    await cursor.ensure(headerSize + Math.min(bodySize, THEORA_SIGNATURE.length));
    let isTheora = true;
    for (let i = 0; i < THEORA_SIGNATURE.length; i++) {
      if (cursor.peek(headerSize + i) !== THEORA_SIGNATURE[i]) { isTheora = false; break; }
    }
    if (isTheora) {
      // A second Theora beginning-of-stream page means chained physical streams,
      // which re-timestamp partway through the file; we refuse them rather than
      // hand back a timeline that jumps.
      if (state.theoraSerialNumber !== null) {
        throw new Error('this Ogg file chains multiple Theora streams; refusing (frame numbers would restart midway)');
      }
      // The identification header is a fixed 42 bytes and, per the Ogg mapping,
      // is the only packet on this page, so it is wholly present here.
      const headerBytes = new Uint8Array(42);
      await cursor.ensure(headerSize + 42);
      for (let i = 0; i < 42; i++) headerBytes[i] = cursor.peek(headerSize + i);
      state.header = parseTheoraIdentificationHeader(headerBytes);
      state.theoraSerialNumber = serialNumber;
    }
  }

  // Account for this page only if it belongs to the Theora stream. Everything
  // else (audio, metadata, and any bytes before the Theora BOS) is skipped.
  if (serialNumber === state.theoraSerialNumber) {
    state.theoraPacketsCompleted += packetsCompletedThisPage;

    if (!granuleAllOnes) {
      // Read the granule position as an unsigned 64-bit BigInt (little-endian).
      let granulePosition = 0n;
      for (let i = 7; i >= 0; i--) granulePosition = granulePosition * 256n + BigInt(cursor.peek(6 + i));
      const granuleFrameCount = granuleToFrameCount(
        granulePosition, state.header.keyframeGranuleShift, state.header.versionRevision);
      const videoFrames = Math.max(0, state.theoraPacketsCompleted - THEORA_HEADER_PACKET_COUNT);

      // The first page that carries a completed video frame is where we verify
      // the stream starts at frame 0. If the granule says more frames have
      // elapsed than we have counted packets for, the stream began partway
      // through a longer timeline (a trimmed or chained source whose first
      // granule is nonzero). We cannot tell from the container alone what
      // presentation time the browser's demuxer will then assign that first
      // frame — it may honour the nonzero start or normalise it away — so rather
      // than risk numbering every frame off by the offset, we refuse. (The
      // presentation table we build always starts at t = 0 by construction; the
      // danger is only that frame 0 of our table would not be frame 0 of the
      // browser's.)
      if (!state.startOffsetChecked && videoFrames >= 1) {
        state.startOffsetChecked = true;
        const startOffset = granuleFrameCount - videoFrames;
        if (Math.abs(startOffset) > 1) {
          throw new Error(
            `this Ogg Theora stream does not start at frame 0 (its first frames' `
            + `granule implies ${granuleFrameCount} elapsed frames where only `
            + `${videoFrames} packets have been seen); refusing rather than risk shifted indices`);
        }
      }

      state.lastGranuleFrameCount = granuleFrameCount;
    }
  }

  // Skip the body and land on the next page. advance() only moves the cursor;
  // the body bytes are never fetched unless they were a Theora header above.
  cursor.advance(headerSize + bodySize);
}
