// ==================================================================
// AVI (RIFF/`AVI `) frame table — the fourth way to get real timestamps, and
// the only one that must produce a DECODE table rather than timestamps alone.
//
// WebM and Ogg get away with reading only a timestamp table because a browser's
// <video> element decodes and presents them itself; the container index just
// makes that native path frame-exact. AVI has no such luxury: no browser plays
// AVI through a <video> element at all, so the ONLY way an AVI ever plays here is
// the WebCodecs engine, which needs the full decode-order sample table (byte
// offsets, sizes, keyframe flags) and a decoder configuration. That is why this
// parser mirrors the ISOBMFF path (a real sample table + a decoderConfig), not
// the WebM/Ogg one — see the architecture note in container-index.js.
//
// AVI is a RIFF file: a tree of chunks, each `<FourCC><uint32 size><body>` with
// the body padded to an even length. Every multi-byte integer in the RIFF layer
// is LITTLE-endian (the opposite of ISOBMFF's big-endian boxes). The tree we
// care about is:
//
//   RIFF 'AVI '
//     LIST 'hdrl'
//       'avih'                 the main header (frame count, µs per frame, dims)
//       LIST 'strl'            one per stream; we want the first 'vids' stream
//         'strh'               stream header: fccType='vids', dwScale/dwRate
//         'strf'               BITMAPINFOHEADER: dimensions + biCompression FourCC
//         'indx' (optional)    OpenDML super-index, pointing at 'ix##' chunks
//     LIST 'movi'              the frame chunks ('##dc'/'##db') themselves
//       'ix##' (OpenDML)       standard indexes, if the file is OpenDML
//     'idx1' (optional)        the legacy flat index at the end of the file
//
// Unlike the WebM and Ogg passes, indexing an AVI does NOT mean reading the whole
// file: the index (`idx1` or the OpenDML `ix##` chunks) enumerates every frame's
// byte range without touching a frame's payload, so a well-written parser reads
// only the header, the index, and the first keyframe (for the H.264 SPS/PPS). We
// still honor the same budget/progress contract as the full-file passes — a
// deadline, a byte ceiling, progress ticks, event-loop yields, and
// IndexBudgetExceededError on a limit — and refuse rather than hang on a
// malformed file; we simply spend far less of the budget in the normal case.
//
// Frame timing is synthesized, not read per-frame: AVI is constant-frame-rate by
// design (dwRate/dwScale is the exact rational frame rate, cross-checked against
// the main header's dwMicroSecPerFrame) and carries no B-frames, so frame n is
// presented at n * dwScale / dwRate seconds with no reordering to undo.
// ==================================================================

import { IndexBudgetExceededError } from './matroska.js';

// AVIIF_KEYFRAME: the flag in an idx1 entry's dwFlags marking a keyframe. The
// OpenDML index instead encodes "not a keyframe" in the high bit of its size
// field (see readOpenDmlStandardIndex).
const AVIIF_KEYFRAME = 0x00000010;

// The two OpenDML index kinds, in the bIndexType byte: a super-index is a list of
// indexes (it points at ix## chunks), a standard index is a list of chunks (it
// points at frame data).
const AVI_INDEX_OF_INDEXES = 0x00;
const AVI_INDEX_OF_CHUNKS = 0x01;

// A four-character code read as ASCII from a byte array. FourCCs are the one
// place AVI is not a number: 'vids', '00dc', 'H264'.
function fourCcAt(bytes, offset) {
  return String.fromCharCode(
    bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

// The two-character stream tag a data chunk's FourCC begins with, e.g. stream 0
// is '00', stream 1 is '01'. AVI writes the stream number as two decimal digits
// (ffmpeg's "%02d"), which is how an idx1 entry says which stream it belongs to.
function streamTag(streamIndex) {
  return String(streamIndex).padStart(2, '0');
}

// Read the frame table of an AVI file's first video ('vids') stream.
//
// The options contract, budget behaviour, and progress reports mirror
// readMatroskaFrameTable / readOggFrameTable:
//   options.timeoutMilliseconds  give up after this long (Infinity: never)
//   options.maxBytes             refuse once this many bytes have been read
//                                (Infinity: any). NOTE this bounds the bytes we
//                                actually READ, not reader.size: an AVI index
//                                lets us skip every frame's payload, so a huge
//                                AVI can be indexed from a small read — unlike
//                                the WebM/Ogg passes, which refuse a file larger
//                                than maxBytes up front because they must read
//                                all of it.
//   options.onProgress           called with a progress report (same shape as
//                                the other passes) as reads happen, and once more
//                                at 100% when it finishes; a throw from it is
//                                swallowed so a buggy indicator cannot abort a load.
//
// Returns a rich object (unlike the WebM/Ogg tables, which carry timestamps
// alone), because AVI must feed WebCodecs:
//   { containerFormat: 'avi', videoWidth, videoHeight,
//     frameRateNumerator (dwRate), frameRateDenominator (dwScale),
//     fourCc, frames: [{offset, size, isSync}] in decode order (absolute file
//     offsets to the frame DATA), decoderConfig | null,
//     samplesAreAnnexB } — samplesAreAnnexB is true for H.264, whose frame bytes
//     are an Annex B bitstream the decode path must convert to AVCC (the
//     decoderConfig carries a matching `avcC` description; see buildDecoderConfig).
// decoderConfig is null when the FourCC is not a codec we can form a valid
// WebCodecs configuration for (uncompressed, MJPEG, …) — the caller then refuses
// the clip cleanly rather than fabricating a config. Throws
// IndexBudgetExceededError when it runs out of budget, and a plain Error when the
// file is not an AVI we can read.
export async function readAviFrameTable(reader, options = {}) {
  const timeoutMilliseconds = (options.timeoutMilliseconds === undefined)
    ? Infinity : options.timeoutMilliseconds;
  const maxBytes = (options.maxBytes === undefined) ? Infinity : options.maxBytes;
  if (!(timeoutMilliseconds > 0)) {
    throw new IndexBudgetExceededError('no time allowed to index this AVI');
  }
  if (!(maxBytes > 0)) {
    throw new IndexBudgetExceededError('no bytes allowed to index this AVI');
  }

  const onProgress = (typeof options.onProgress === 'function') ? options.onProgress : null;
  const startedAt = performance.now();

  const state = {
    bytesRead: 0,        // cumulative bytes fetched, what maxBytes bounds
    lastYieldedAt: startedAt,
    framesFound: 0,      // best-effort running count, for progress
  };

  const report = (bytesReadValue) => {
    if (!onProgress) return;
    const elapsedMs = performance.now() - startedAt;
    const fraction = reader.size ? Math.min(1, bytesReadValue / reader.size) : 1;
    const etaMs = (fraction > 0 && fraction < 1) ? elapsedMs * (1 - fraction) / fraction : 0;
    try {
      onProgress({
        bytesRead: bytesReadValue, totalBytes: reader.size, fraction, elapsedMs, etaMs,
        framesFound: state.framesFound,
      });
    } catch (progressError) {
      // An indicator that throws is the host's bug, not ours; keep indexing.
    }
  };

  // Fetch [start, endInclusive] as a DataView, charging it against the byte and
  // time budgets, reporting progress, and letting the event loop breathe now and
  // then — the same guarantees the sequential passes give, applied to AVI's
  // handful of targeted reads. Returns a { view, bytes, base } triple (a DataView
  // for little-endian numbers, a Uint8Array for FourCCs, and the file offset the
  // buffer starts at).
  const fetch = async (start, endInclusive) => {
    const now = performance.now();
    if (now - startedAt > timeoutMilliseconds) {
      throw new IndexBudgetExceededError(
        `indexing this AVI did not finish within ${timeoutMilliseconds} ms `
        + `(read ${state.bytesRead} of a needed portion of ${reader.size} bytes)`);
    }
    const requested = endInclusive - start + 1;
    if (state.bytesRead + requested > maxBytes) {
      throw new IndexBudgetExceededError(
        `indexing this AVI would read more than the caller's limit of ${maxBytes} bytes`);
    }
    if (now - state.lastYieldedAt > 16) {
      state.lastYieldedAt = now;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const buffer = await reader.read(start, endInclusive);
    state.bytesRead += buffer.byteLength;
    report(state.bytesRead);
    return { view: new DataView(buffer), bytes: new Uint8Array(buffer), base: start };
  };

  // --- RIFF/AVI signature ----------------------------------------------------
  if (reader.size < 12) throw new Error('file is too small to be an AVI');
  const head = await fetch(0, Math.min(reader.size, 12) - 1);
  if (fourCcAt(head.bytes, 0) !== 'RIFF' || fourCcAt(head.bytes, 8) !== 'AVI ') {
    throw new Error('not a RIFF/AVI file');
  }

  // --- the header list (hdrl): avih + the first video stream's strl ----------
  // The first top-level chunk is LIST 'hdrl'. Read its FourCC + size + list type
  // (12 bytes at offset 12), then the whole hdrl body in one read — it holds only
  // headers, never frame data, so it is small however long the clip is.
  const listHeader = await fetch(12, 12 + 12 - 1);
  if (fourCcAt(listHeader.bytes, 0) !== 'LIST' || fourCcAt(listHeader.bytes, 8) !== 'hdrl') {
    throw new Error('AVI does not begin with a LIST hdrl header');
  }
  const hdrlSize = listHeader.view.getUint32(4, true);
  const hdrlContentStart = 24;   // 12 ('RIFF'..'AVI ') + 4 'LIST' + 4 size + 4 'hdrl'
  const hdrlContentEnd = 12 + 8 + hdrlSize;   // exclusive
  if (hdrlContentEnd > reader.size) throw new Error('AVI hdrl runs past end of file');
  const hdrl = await fetch(hdrlContentStart, hdrlContentEnd - 1);
  const header = parseHeaderList(hdrl.bytes, hdrl.view);
  if (!header.stream) {
    throw new Error('AVI has no video (vids) stream to index');
  }

  // --- locate the movi list (for idx1 offset resolution) and any idx1 ---------
  // Walk the top-level chunks past hdrl, reading only their 8-byte headers (plus
  // the 4-byte list type) and skipping every body — crucially the movi body,
  // which is the frame bytes we are here to NOT read. We come away with the file
  // offset of the 'movi' FourCC and, if present, the idx1 chunk's range.
  const layout = await locateMoviAndIdx1(fetch, reader.size, hdrlContentEnd);
  if (layout.moviFourCcPosition === null) {
    throw new Error('AVI has no movi list (no frame data)');
  }

  // --- enumerate the video frames: OpenDML super-index first, else idx1 -------
  // Real large captures are OpenDML and carry no usable idx1, so the hierarchical
  // index is tried first when the stream declares one; the legacy flat index is
  // the fallback (and the only index small ffmpeg-written files carry).
  let frames = null;
  if (header.stream.superIndex && header.stream.superIndex.entries.length) {
    frames = await readOpenDmlFrames(fetch, header.stream.superIndex, (n) => { state.framesFound = n; });
  }
  if ((!frames || !frames.length) && layout.idx1) {
    frames = await readIdx1Frames(fetch, layout, header.streamIndex, (n) => { state.framesFound = n; });
  }
  if (!frames || !frames.length) {
    throw new Error('AVI carries no usable index (neither an OpenDML ix## index nor idx1)');
  }
  state.framesFound = frames.length;

  // --- the frame rate: dwRate/dwScale, cross-checked against avih -------------
  const { dwRate, dwScale } = header.stream;
  if (!(dwRate > 0) || !(dwScale > 0)) {
    throw new Error(`AVI stream header declares a nonsensical frame rate ${dwRate}/${dwScale}`);
  }
  // dwRate/dwScale is the authoritative rational rate; dwMicroSecPerFrame in the
  // main header is a second, coarser account of the same thing. A gross mismatch
  // means the file's two records of its own timing disagree — a clip we would
  // mis-time — so we refuse rather than pick one. A few percent of slack absorbs
  // the main header's integer-microsecond rounding (1e6/30 = 33333.33 stored as
  // 33333).
  const microsPerFrameFromRate = 1e6 * dwScale / dwRate;
  if (header.microSecPerFrame > 0) {
    const ratio = microsPerFrameFromRate / header.microSecPerFrame;
    if (ratio < 0.9 || ratio > 1.1) {
      throw new Error(
        `AVI frame rate is inconsistent: stream header dwRate/dwScale = ${dwRate}/${dwScale} `
        + `(${microsPerFrameFromRate.toFixed(1)} µs/frame) but the main header says `
        + `${header.microSecPerFrame} µs/frame`);
    }
  }

  // --- the decoder configuration from the biCompression FourCC ---------------
  // H.264 needs the SPS from the first keyframe to form its avc1.PPCCLL codec
  // string, so read just that one frame's bytes. Any FourCC we cannot form a
  // valid config for yields null, and the caller refuses the clip cleanly.
  const firstKeyframe = frames.find((f) => f.isSync) || frames[0];
  let firstKeyframeBytes = null;
  if (firstKeyframe && codecNeedsFirstKeyframe(header.stream.fourCc)) {
    const kf = await fetch(firstKeyframe.offset, firstKeyframe.offset + firstKeyframe.size - 1);
    firstKeyframeBytes = kf.bytes;
  }
  const decoderConfig = buildDecoderConfig(
    header.stream.fourCc, header.stream.videoWidth, header.stream.videoHeight,
    firstKeyframeBytes);

  report(reader.size);   // a final 100% tick, so the host can settle the bar
  return {
    containerFormat: 'avi',
    videoWidth: header.stream.videoWidth,
    videoHeight: header.stream.videoHeight,
    frameRateNumerator: dwRate,
    frameRateDenominator: dwScale,
    fourCc: header.stream.fourCc,
    frames,
    decoderConfig,
    // H.264 (the only supported codec) is stored Annex B and configured in AVCC
    // mode, so its frame bytes need converting before decode. If a
    // length-prefixed codec is ever added, it sets this false.
    samplesAreAnnexB: !!decoderConfig && isH264FourCc(header.stream.fourCc),
  };
}

// Parse the hdrl body: the avih main header and every strl (stream list), keeping
// the first video stream. `bytes`/`view` cover the hdrl content; all offsets
// below are into that buffer.
function parseHeaderList(bytes, view) {
  const result = {
    microSecPerFrame: 0,
    streamIndex: -1,   // the index of the chosen video stream among all streams
    stream: null,      // its parsed strh/strf/indx, or null if there is no video
  };

  let streamCounter = -1;   // increments per strl LIST, giving each its number
  let offset = 0;
  const end = bytes.length;
  while (offset + 8 <= end) {
    const id = fourCcAt(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (id === 'avih') {
      // AVIMAINHEADER: dwMicroSecPerFrame is the first field.
      result.microSecPerFrame = view.getUint32(bodyStart, true);
    } else if (id === 'LIST' && fourCcAt(bytes, bodyStart) === 'strl') {
      streamCounter += 1;
      // Only the first video stream is kept; later streams (audio, a second
      // video) are still counted so streamCounter stays the true stream number.
      const stream = parseStreamList(bytes, view, bodyStart + 4, bodyStart + size);
      if (stream && result.stream === null) {
        result.stream = stream;
        result.streamIndex = streamCounter;
      }
    }
    // Chunks are padded to an even length.
    offset = bodyStart + size + (size & 1);
  }
  return result;
}

// Parse one strl (stream list): its strh (stream header) and strf (format), plus
// an OpenDML indx super-index if the stream carries one. Returns null unless the
// stream is a video ('vids') stream. `bodyStart`/`bodyEnd` bound the strl content
// within `bytes`.
function parseStreamList(bytes, view, bodyStart, bodyEnd) {
  let fccType = null;
  let dwScale = 0, dwRate = 0, dwLength = 0;
  let fourCc = null, videoWidth = 0, videoHeight = 0;
  let superIndex = null;

  let offset = bodyStart;
  while (offset + 8 <= bodyEnd && offset + 8 <= bytes.length) {
    const id = fourCcAt(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'strh') {
      // AVISTREAMHEADER: fccType(4), fccHandler(4), dwFlags(4), wPriority(2),
      // wLanguage(2), dwInitialFrames(4), dwScale(4), dwRate(4), dwStart(4),
      // dwLength(4), ...
      fccType = fourCcAt(bytes, body);
      dwScale = view.getUint32(body + 20, true);
      dwRate = view.getUint32(body + 24, true);
      dwLength = view.getUint32(body + 32, true);
    } else if (id === 'strf') {
      // BITMAPINFOHEADER: biSize(4), biWidth(4, LONG), biHeight(4, LONG, may be
      // negative for a top-down image), biPlanes(2), biBitCount(2),
      // biCompression(4, FourCC), ...
      videoWidth = view.getInt32(body + 4, true);
      videoHeight = Math.abs(view.getInt32(body + 8, true));
      fourCc = fourCcAt(bytes, body + 16);
    } else if (id === 'indx') {
      superIndex = parseSuperIndex(bytes, view, body, size);
    }
    offset = body + size + (size & 1);
  }

  if (fccType !== 'vids') return null;
  return { dwScale, dwRate, dwLength, fourCc, videoWidth, videoHeight, superIndex };
}

// Parse an OpenDML super-index (an AVISUPERINDEX / AVI_INDEX_OF_INDEXES): the
// list of ix## standard-index chunks that between them index every frame. Returns
// { chunkId, entries: [{ offset, size }] } where each entry's offset is the
// absolute file position of an ix## chunk. A super-index that is present but of
// the wrong kind or empty returns entries: [] so the caller falls back to idx1.
function parseSuperIndex(bytes, view, body, size) {
  const longsPerEntry = view.getUint16(body, true);   // 4 for a super-index
  const indexType = bytes[body + 3];                   // bIndexType
  const entryCount = view.getUint32(body + 4, true);   // nEntriesInUse
  const chunkId = fourCcAt(bytes, body + 8);           // e.g. '00dc'
  if (indexType !== AVI_INDEX_OF_INDEXES || longsPerEntry !== 4) {
    return { chunkId, entries: [] };
  }
  // The fixed part is 24 bytes (through dwReserved[3]); entries are 16 bytes each:
  // qwOffset(8, absolute file offset of the ix## chunk), dwSize(4), dwDuration(4).
  const entries = [];
  const entriesStart = body + 24;
  for (let e = 0; e < entryCount; e++) {
    const at = entriesStart + e * 16;
    if (at + 16 > body + size) break;
    const offset = readUint64(view, at);
    const chunkSize = view.getUint32(at + 8, true);
    entries.push({ offset, size: chunkSize });
  }
  return { chunkId, entries };
}

// Walk the top-level chunks after hdrl, reading only headers (never bodies), to
// find the 'movi' list's FourCC position and any trailing idx1 chunk. Returns
// { moviFourCcPosition, idx1: { offset, size } | null }.
async function locateMoviAndIdx1(fetch, fileSize, startOffset) {
  let moviFourCcPosition = null;
  let idx1 = null;
  let offset = startOffset;
  while (offset + 8 <= fileSize) {
    const chunk = await fetch(offset, Math.min(fileSize, offset + 12) - 1);
    const id = fourCcAt(chunk.bytes, 0);
    const size = chunk.view.getUint32(4, true);
    if (id === 'LIST') {
      const listType = fourCcAt(chunk.bytes, 8);
      if (listType === 'movi') moviFourCcPosition = offset + 8;
      // Skip the whole list body; anything inside movi (frame chunks, ix##
      // chunks) is reached directly via the super-index, not by walking here.
    } else if (id === 'idx1') {
      idx1 = { offset: offset + 8, size };
    }
    offset = offset + 8 + size + (size & 1);
  }
  return { moviFourCcPosition, idx1 };
}

// Read every video frame's byte range from the OpenDML standard indexes the
// super-index points at. Returns decode-order [{offset, size, isSync}] with
// absolute file offsets to the frame DATA.
async function readOpenDmlFrames(fetch, superIndex, noteCount) {
  const frames = [];
  for (const entry of superIndex.entries) {
    // Read the ix## chunk: its 8-byte chunk header, then its whole body.
    const header = await fetch(entry.offset, entry.offset + 8 - 1);
    const id = fourCcAt(header.bytes, 0);
    if (!/^ix..$/.test(id)) {
      throw new Error(`OpenDML super-index points at a non-ix chunk ('${id}')`);
    }
    const bodySize = header.view.getUint32(4, true);
    const body = await fetch(entry.offset + 8, entry.offset + 8 + bodySize - 1);
    readOpenDmlStandardIndex(body.bytes, body.view, bodySize, frames);
    noteCount(frames.length);
  }
  return frames;
}

// Parse one ix## standard index (an AVISTDINDEX / AVI_INDEX_OF_CHUNKS) into the
// frames array. `bytes`/`view` cover the chunk body (after its 8-byte header).
function readOpenDmlStandardIndex(bytes, view, bodySize, frames) {
  const longsPerEntry = view.getUint16(0, true);   // 2 for a standard index
  const indexType = bytes[3];                       // bIndexType
  const entryCount = view.getUint32(4, true);       // nEntriesInUse
  const baseOffset = readUint64(view, 12);          // qwBaseOffset
  if (indexType !== AVI_INDEX_OF_CHUNKS || longsPerEntry !== 2) {
    throw new Error('OpenDML ix## chunk is not a standard chunk index');
  }
  // The fixed part is 24 bytes (through dwReserved); entries are 8 bytes each:
  // dwOffset(4, relative to qwBaseOffset, points at the frame DATA) and
  // dwSize(4, with the high bit set meaning "not a keyframe").
  const entriesStart = 24;
  for (let e = 0; e < entryCount; e++) {
    const at = entriesStart + e * 8;
    if (at + 8 > bodySize) break;
    const relativeOffset = view.getUint32(at, true);
    const sizeField = view.getUint32(at + 4, true);
    const isSync = (sizeField & 0x80000000) === 0;
    const size = sizeField & 0x7FFFFFFF;
    frames.push({ offset: baseOffset + relativeOffset, size, isSync });
  }
}

// Read every video frame's byte range from the legacy idx1 chunk. idx1 is a flat
// array of 16-byte entries { ckid(4), dwFlags(4), dwChunkOffset(4), dwChunkSize(4) };
// we keep the ones whose ckid is the video stream's data chunk ('##dc'/'##db').
// Returns decode-order [{offset, size, isSync}] with absolute offsets to the
// frame DATA.
async function readIdx1Frames(fetch, layout, streamIndex, noteCount) {
  const idx1 = await fetch(layout.idx1.offset, layout.idx1.offset + layout.idx1.size - 1);
  const view = idx1.view, bytes = idx1.bytes;
  const entryCount = Math.floor(layout.idx1.size / 16);
  const tag = streamTag(streamIndex);

  // Collect the raw video entries first, so we can resolve the classic idx1
  // offset ambiguity from the first one before trusting any.
  const raw = [];
  for (let e = 0; e < entryCount; e++) {
    const at = e * 16;
    const ckid = fourCcAt(bytes, at);
    // Video data chunks are '##dc' (compressed) or '##db' (uncompressed DIB); the
    // '##' is the stream tag. Skip audio ('##wb'), palette changes, and so on.
    const isVideoData = ckid.slice(0, 2) === tag
      && ckid[2] === 'd' && (ckid[3] === 'c' || ckid[3] === 'b');
    if (!isVideoData) continue;
    raw.push({
      ckid,
      flags: view.getUint32(at + 4, true),
      chunkOffset: view.getUint32(at + 8, true),
      chunkSize: view.getUint32(at + 12, true),
    });
  }
  if (!raw.length) return [];

  // Resolve the idx1 offset base. dwChunkOffset is, depending on the writer,
  // relative to the 'movi' FourCC (the common case — it points at the chunk
  // HEADER, so the data is 8 bytes further on) or absolute from the file start.
  // Detect which by finding the base under which the first entry's dwChunkOffset
  // lands on a chunk header whose FourCC matches its own ckid.
  const base = await resolveIdx1Base(fetch, layout.moviFourCcPosition, raw[0]);
  if (base === null) {
    throw new Error('AVI idx1 offsets do not resolve to valid chunk headers');
  }

  const frames = [];
  for (const entry of raw) {
    // base + dwChunkOffset is the chunk header; the frame data is 8 bytes past it.
    frames.push({
      offset: base + entry.chunkOffset + 8,
      size: entry.chunkSize,
      isSync: (entry.flags & AVIIF_KEYFRAME) !== 0,
    });
    noteCount(frames.length);
  }
  // The very first frame is a keyframe by construction, whatever the flag said —
  // a decode run has to start on one, and _buildTables assumes sample 0 is sync.
  if (frames.length) frames[0].isSync = true;
  return frames;
}

// Find the base offset under which idx1's dwChunkOffset values resolve to real
// chunk headers, by testing candidates against the first entry: read 4 bytes at
// base + dwChunkOffset and require they equal the entry's ckid, with the size
// right after matching too. Returns the winning base, or null if none fits.
async function resolveIdx1Base(fetch, moviFourCcPosition, firstEntry) {
  const candidates = [moviFourCcPosition, 0];
  for (const base of candidates) {
    if (base === null) continue;
    const headerPosition = base + firstEntry.chunkOffset;
    if (headerPosition < 0) continue;
    let probe;
    try {
      probe = await fetch(headerPosition, headerPosition + 8 - 1);
    } catch (err) {
      if (err instanceof IndexBudgetExceededError) throw err;
      continue;   // an out-of-range read: this candidate is wrong, try the next
    }
    if (probe.bytes.length < 8) continue;
    const id = fourCcAt(probe.bytes, 0);
    const size = probe.view.getUint32(4, true);
    if (id === firstEntry.ckid && size === firstEntry.chunkSize) return base;
  }
  return null;
}

// A 64-bit little-endian unsigned integer, as a Number. AVI/OpenDML file offsets
// fit comfortably under 2^53, so a Number holds them exactly.
function readUint64(view, offset) {
  const low = view.getUint32(offset, true);
  const high = view.getUint32(offset + 4, true);
  return high * 0x100000000 + low;
}

// True for a FourCC whose decoder configuration needs bytes from the first
// keyframe (H.264's SPS/PPS, to form the avc1.PPCCLL codec string and the avcC
// description).
function codecNeedsFirstKeyframe(fourCc) {
  return isH264FourCc(fourCc);
}

// H.264 goes by many FourCCs across writers; treat them case-insensitively.
function isH264FourCc(fourCc) {
  const normalized = fourCc.toUpperCase();
  return normalized === 'H264' || normalized === 'AVC1' || normalized === 'X264';
}

// Turn the biCompression FourCC into a WebCodecs decoder configuration, or null
// when we cannot form a valid one (which the caller treats as "refuse this clip
// cleanly" — never fabricate a config that VideoDecoder.configure would reject or,
// worse, accept and then fail on).
//
// Only H.264 is supported today. AVI stores H.264 as an Annex B bitstream (NAL
// units with start codes, SPS/PPS carried in-band on each keyframe). We do NOT
// feed WebCodecs that Annex B directly: WebKit's decoder answers isConfigSupported
// = true for an Annex-B (no-description) config and then FAILS the actual decode —
// a dishonest yes (see the decode-support-matrix skill). So we configure the
// decoder in length-prefixed AVCC mode instead — the format every engine decodes,
// WebKit included — by building an `avcC` description from the first keyframe's
// SPS and PPS, and the caller converts each frame's Annex B to AVCC before feeding
// it (convertAnnexBToAvcc). The avc1.PPCCLL codec string comes from the SPS.
//
// Uncompressed video (biCompression 0 / 'DIB ' / 'RAW '), MJPEG, and everything
// else return null: a raw-frame backend is a separate future task, and WebCodecs
// has no MJPEG decoder on most browsers.
function buildDecoderConfig(fourCc, width, height, firstKeyframeBytes) {
  if (isH264FourCc(fourCc)) {
    if (!firstKeyframeBytes) return null;
    const parameterSets = parseAvcParameterSets(firstKeyframeBytes);
    // Both an SPS (for the codec string and the avcC) and a PPS (for the avcC)
    // must be present, or we cannot form an AVCC config — refuse rather than
    // guess.
    if (!parameterSets) return null;
    const { sps, pps } = parameterSets;
    const hex = (value) => value.toString(16).padStart(2, '0');
    return {
      codec: `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`,   // profile/compat/level
      codedWidth: width,
      codedHeight: height,
      description: buildAvcCDescription(sps, pps),
      optimizeForLatency: true,
    };
  }
  return null;
}

// Split an Annex B access unit into its NAL units, returning [{ start, end }]
// byte ranges (exclusive of the start code, and with any inter-NAL trailing zero
// padding trimmed off the end — a valid NAL's last RBSP byte is never zero). One
// forward pass finds every start code (00 00 01 or 00 00 00 01); each NAL runs
// from just after its start code to just before the next one.
function annexBNalUnits(bytes) {
  const length = bytes.length;
  const startCodes = [];   // { position, codeLength }
  let i = 0;
  while (i + 3 <= length) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) {
      startCodes.push({ position: i, codeLength: 3 });
      i += 3;
    } else if (i + 4 <= length
        && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 0 && bytes[i + 3] === 1) {
      startCodes.push({ position: i, codeLength: 4 });
      i += 4;
    } else {
      i += 1;
    }
  }
  const nalUnits = [];
  for (let k = 0; k < startCodes.length; k++) {
    const start = startCodes[k].position + startCodes[k].codeLength;
    let end = (k + 1 < startCodes.length) ? startCodes[k + 1].position : length;
    while (end > start && bytes[end - 1] === 0) end -= 1;   // trim padding zeros
    if (end > start) nalUnits.push({ start, end });
  }
  return nalUnits;
}

// Find the first SPS (NAL type 7) and PPS (NAL type 8) in an Annex B access unit,
// returning { sps, pps } as Uint8Arrays of the NAL bytes (NAL header included,
// start code excluded). Returns null if either is missing — a frame that is not a
// keyframe, or a bitstream we cannot read — so the caller refuses.
function parseAvcParameterSets(bytes) {
  let sps = null, pps = null;
  for (const { start, end } of annexBNalUnits(bytes)) {
    const nalType = bytes[start] & 0x1F;
    if (nalType === 7 && !sps && end - start >= 4) sps = bytes.slice(start, end);
    else if (nalType === 8 && !pps) pps = bytes.slice(start, end);
  }
  return (sps && pps) ? { sps, pps } : null;
}

// Build the `avcC` description (ISO 14496-15) WebCodecs wants for AVCC-mode H.264,
// from one SPS and one PPS. This is the same bytes VideoDecoder.configure's
// `description` expects, and the same shape mp4box hands back for an MP4 (the
// avcC box body, no box header). NAL length size is 4 (lengthSizeMinusOne = 3).
// The optional High-profile trailing fields (chroma_format, bit depths) are left
// off — decoders do not require them for 8-bit 4:2:0, which is all we accept.
function buildAvcCDescription(sps, pps) {
  const description = new Uint8Array(8 + sps.length + 3 + pps.length);
  let o = 0;
  description[o++] = 1;            // configurationVersion
  description[o++] = sps[1];       // AVCProfileIndication (profile_idc)
  description[o++] = sps[2];       // profile_compatibility (constraint flags)
  description[o++] = sps[3];       // AVCLevelIndication (level_idc)
  description[o++] = 0xFF;         // 6 bits reserved (111111) + lengthSizeMinusOne (11 = 3)
  description[o++] = 0xE1;         // 3 bits reserved (111) + numOfSequenceParameterSets (00001 = 1)
  description[o++] = (sps.length >> 8) & 0xFF;
  description[o++] = sps.length & 0xFF;
  description.set(sps, o); o += sps.length;
  description[o++] = 1;            // numOfPictureParameterSets
  description[o++] = (pps.length >> 8) & 0xFF;
  description[o++] = pps.length & 0xFF;
  description.set(pps, o);
  return description;
}

// Convert an Annex B access unit (start-code-delimited NAL units, as AVI stores
// H.264) to the length-prefixed AVCC form a WebCodecs decoder configured with an
// `avcC` description expects: each NAL becomes a 4-byte big-endian length followed
// by the NAL bytes. Exported for the decode path (VideoEngine), which applies it
// per frame just before handing the bytes to VideoDecoder.
export function convertAnnexBToAvcc(bytes) {
  const nalUnits = annexBNalUnits(bytes);
  let total = 0;
  for (const { start, end } of nalUnits) total += 4 + (end - start);
  const out = new Uint8Array(total);
  let o = 0;
  for (const { start, end } of nalUnits) {
    const nalLength = end - start;
    out[o++] = (nalLength >>> 24) & 0xFF;
    out[o++] = (nalLength >>> 16) & 0xFF;
    out[o++] = (nalLength >>> 8) & 0xFF;
    out[o++] = nalLength & 0xFF;
    out.set(bytes.subarray(start, end), o);
    o += nalLength;
  }
  return out;
}
