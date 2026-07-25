// ==================================================================
// Matroska/WebM frame table — the second way to get real timestamps, and (since
// v2.2) a full decode table as well.
//
// mp4box only speaks ISOBMFF, so a WebM clip used to land on the assumed
// constant frame rate, and got silently wrong frame numbers whenever that
// assumption was wrong. It does not have to: Matroska stores every frame's
// presentation timestamp in plain sight (a cluster's Timestamp plus each
// block's signed 16-bit offset from it), so the table can be read without
// decoding a single frame — the same trick as the moov, just a different box
// layout.
//
// The one real difference is cost. Matroska has no central sample table: the
// timestamps live next to the frames, scattered across every cluster, and Cues
// indexes only keyframes. So there is no way to build the table without a
// sequential pass over the whole file. We read only element headers and skip
// every block's payload, so this is I/O plus a little arithmetic, never a
// decode — but the bytes still have to go past us. That is fast for a local
// File (disk speed) and as slow as the network for a URL, which is why the pass
// takes a deadline and the engine gives it one (see createBestEngine's
// indexTimeoutMilliseconds).
//
// Timestamps here are quantized by TimestampScale — 1 ms by default, so a 60fps
// clip's frames land on 0, 17, 33, 50 ms rather than exact sixtieths. That is
// not a loss of exactness for our purpose: the browser's own demuxer computes
// the `mediaTime` it reports from these very integers, so our table and its
// clock agree by construction, which is the only thing frame mapping needs.
//
// WHY THIS PASS ALSO RECORDS BYTE RANGES. The scan walks past every block
// header on its way through the file, and a block header is exactly where the
// frame's byte range and its keyframe flag are. Reading the timestamp and
// throwing the other two away cost WebM and MKV the WebCodecs engine entirely:
// they got frame-exact <video> playback and nothing else — no named-frame pixels
// (bitmapForFrame), no engine-owned clock, and on WebKit, which demuxes no
// Matroska at all, no playback whatsoever for an MKV this parser had just
// indexed perfectly. So the pass now builds the ISOBMFF-shaped decode table too
// (offset, size, isSync per frame, in decode order), and buildMatroskaDecoderConfig
// turns the track's CodecID and CodecPrivate into a WebCodecs decoder
// configuration. Both are nearly free on top of a pass that was already touching
// every block header; the only extra read is the first keyframe's opening bytes
// for a VP9 track, whose profile and bit depth live in the frame itself.
//
// A codec we cannot honestly configure yields no decoderConfig, which leaves the
// clip exactly where it was before: frame-exact on the <video> element. Unlike
// AVI (WebCodecs or nothing), Matroska always has that tier to fall back to, so
// this parser never has to guess at a configuration to keep a clip playable.
// ==================================================================

// Element IDs, stored with their EBML length marker, exactly as they appear in
// the file (so `0xA3`, not `0x23`).
const EBML_ID = {
  header: 0x1A45DFA3,
  segment: 0x18538067,
  seekHead: 0x114D9B74,
  info: 0x1549A966,
  timestampScale: 0x2AD7B1,
  tracks: 0x1654AE6B,
  trackEntry: 0xAE,
  trackNumber: 0xD7,
  trackType: 0x83,
  defaultDuration: 0x23E383,
  video: 0xE0,
  pixelWidth: 0xB0,
  pixelHeight: 0xBA,
  codecId: 0x86,
  codecPrivate: 0x63A2,
  cluster: 0x1F43B675,
  clusterTimestamp: 0xE7,
  simpleBlock: 0xA3,
  blockGroup: 0xA0,
  block: 0xA1,
  referenceBlock: 0xFB,
  cues: 0x1C53BB6B,
  chapters: 0x1043A770,
  tags: 0x1254C367,
  attachments: 0x1941A469,
};

// The elements that live directly under the Segment. A cluster written with an
// unknown size (streamed files do this) ends where the next one of these
// begins, so this set is how we find the end of it.
const EBML_SEGMENT_LEVEL_IDS = new Set([
  EBML_ID.seekHead, EBML_ID.info, EBML_ID.tracks, EBML_ID.cluster,
  EBML_ID.cues, EBML_ID.chapters, EBML_ID.tags, EBML_ID.attachments,
]);

const MATROSKA_TRACK_TYPE_VIDEO = 1;

// Thrown when the pass runs out of its time (or byte) budget. Named so a caller
// can tell "this clip is too big to index in the time you gave me" (fall back to
// the declared frame rate, nothing is wrong) from "this file is malformed".
export class IndexBudgetExceededError extends Error {
  constructor(message) { super(message); this.name = 'IndexBudgetExceededError'; }
}

// A forward-only byte cursor over a range reader, holding one chunk at a time.
// Skipping a block's payload costs nothing: it moves the position, and the next
// read that needs bytes refetches from wherever the position now is.
export class SequentialByteCursor {
  constructor(reader, options = {}) {
    this.reader = reader;
    this.size = reader.size;
    this.position = 0;
    this.buffer = new Uint8Array(0);
    this.bufferStart = 0;
    this.chunkBytes = options.chunkBytes || (1 << 20);   // 1 MB
    // Called before every refill: where the budget is checked and the event loop
    // is let breathe, so a long pass cannot freeze the host page.
    this.beforeRefill = options.beforeRefill || null;
  }

  get atEnd() { return this.position >= this.size; }

  _buffered() {
    const count = this.bufferStart + this.buffer.length - this.position;
    return count > 0 ? count : 0;
  }

  // Guarantee `count` bytes are readable at the cursor.
  async ensure(count) {
    if (this._buffered() >= count) return;
    if (this.beforeRefill) await this.beforeRefill();
    const start = this.position;
    const end = Math.min(this.size, start + Math.max(count, this.chunkBytes));
    if (end - start < count) throw new Error('unexpected end of file');
    this.buffer = new Uint8Array(await this.reader.read(start, end - 1));
    this.bufferStart = start;
    if (this.buffer.length < count) throw new Error('unexpected end of file');
  }

  // Byte at `offset` from the cursor. Only valid for bytes ensure() has covered.
  peek(offset) { return this.buffer[this.position - this.bufferStart + offset]; }
  advance(count) { this.position += count; }
}

// An element ID: the leading-zero count of the first byte gives its length (1-4
// bytes) and the marker bits stay in the value.
async function readEbmlId(cursor) {
  await cursor.ensure(1);
  const first = cursor.peek(0);
  if (first === 0) throw new Error('invalid EBML element id');
  let length = 1;
  for (let mask = 0x80; !(first & mask); mask >>= 1) length++;
  if (length > 4) throw new Error('invalid EBML element id');
  await cursor.ensure(length);
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + cursor.peek(i);
  cursor.advance(length);
  return value;
}

// A variable-length integer: same length encoding as an ID, but the marker bit
// is stripped from the value. An all-ones value means "unknown size" (a master
// element whose length the writer did not know), reported as null.
async function readEbmlVariableInt(cursor) {
  await cursor.ensure(1);
  const first = cursor.peek(0);
  if (first === 0) throw new Error('invalid EBML variable-length integer');
  let length = 1;
  for (let mask = 0x80; !(first & mask); mask >>= 1) length++;
  await cursor.ensure(length);
  let value = first & (0xFF >> length);
  let allOnes = value === (0xFF >> length);
  for (let i = 1; i < length; i++) {
    const byte = cursor.peek(i);
    if (byte !== 0xFF) allOnes = false;
    value = value * 256 + byte;
  }
  cursor.advance(length);
  return allOnes ? null : value;
}

async function readEbmlUnsigned(cursor, byteCount) {
  await cursor.ensure(byteCount);
  let value = 0;
  for (let i = 0; i < byteCount; i++) value = value * 256 + cursor.peek(i);
  cursor.advance(byteCount);
  return value;
}

// An element's raw bytes, copied out of the cursor's buffer. Used for
// CodecPrivate (the avcC/hvcC/av1C the decoder configuration is built from),
// which is a few hundred bytes at most — the copy is deliberate, so the bytes
// outlive the buffer the next refill overwrites.
async function readEbmlBytes(cursor, byteCount) {
  await cursor.ensure(byteCount);
  const bytes = new Uint8Array(byteCount);
  for (let i = 0; i < byteCount; i++) bytes[i] = cursor.peek(i);
  cursor.advance(byteCount);
  return bytes;
}

// An ASCII element (CodecID, e.g. 'V_VP9'), with any trailing padding zeros
// dropped — Matroska allows a writer to pad a string element out.
async function readEbmlString(cursor, byteCount) {
  const bytes = await readEbmlBytes(cursor, byteCount);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  return String.fromCharCode(...bytes.subarray(0, end));
}

// A progress report for a WebM index pass, handed to options.onProgress. The
// only long-running index (an MP4's moov is a handful of range reads whatever
// the clip's length), so this is where a "please wait" indicator earns its
// keep. Shape:
//   { bytesRead, totalBytes,   // of the sequential pass
//     fraction,                // bytesRead / totalBytes, 0..1
//     elapsedMs,               // since the pass began
//     etaMs,                   // estimated time remaining, from the average
//                              //   rate so far (0 at the very start and the end)
//     framesFound }            // video frames indexed so far
// Format one for display with formatProgress().
export function formatProgress(progress) {
  const percent = Math.round((progress.fraction || 0) * 100);
  if (progress.fraction >= 1 || !(progress.etaMs > 0)) return `Indexing… ${percent}%`;
  const seconds = Math.max(1, Math.round(progress.etaMs / 1000));
  return `Indexing… ${percent}% (~${seconds}s left)`;
}

// Read the frame table of the file's first video track: every frame's
// presentation timestamp, byte range, and keyframe flag, plus the track's codec
// and a WebCodecs decoder configuration where we can build one honestly.
//
// options.timeoutMilliseconds  give up after this long (Infinity: never)
// options.maxBytes             refuse a file bigger than this (Infinity: any)
// options.onProgress           called ~once per megabyte with a progress report
//                              (see formatProgress) during the pass, and once
//                              more at 100% when it finishes. A throw from it is
//                              swallowed so a buggy indicator cannot abort a load.
//
// Returns:
//   { presentationTimes,      // seconds, file (decode) order
//     frames,                 // decode order: {offset, size, isSync, ticks},
//                             //   offset/size being the frame's own bytes in
//                             //   the file, ticks its timestamp in timescale units
//     timescale,              // ticks per second (1000 for the default 1 ms scale)
//     defaultFrameDuration,   // seconds, from DefaultDuration (0 if absent)
//     videoWidth, videoHeight,
//     codecId,                // Matroska CodecID, e.g. 'V_VP9'
//     decoderConfig }         // WebCodecs configuration, or null for a codec we
//                             //   cannot configure (the clip then plays through
//                             //   the <video> element, as it always did)
//
// Throws IndexBudgetExceededError when it runs out of budget, and a plain Error
// when the file is not one we can read.
export async function readMatroskaFrameTable(reader, options = {}) {
  const timeoutMilliseconds = (options.timeoutMilliseconds === undefined)
    ? Infinity : options.timeoutMilliseconds;
  const maxBytes = (options.maxBytes === undefined) ? Infinity : options.maxBytes;
  if (reader.size > maxBytes) {
    throw new IndexBudgetExceededError(
      `WebM is ${reader.size} bytes; indexing it means reading all of them, and `
      + `the caller's limit is ${maxBytes}`);
  }
  if (!(timeoutMilliseconds > 0)) {
    throw new IndexBudgetExceededError('no time allowed to index this WebM');
  }

  const onProgress = (typeof options.onProgress === 'function') ? options.onProgress : null;

  const startedAt = performance.now();
  let lastYieldedAt = startedAt;
  const state = {
    timestampScaleSeconds: 1e6 / 1e9,   // TimestampScale defaults to 1 ms
    videoTrackNumber: null,
    defaultFrameDuration: 0,
    videoWidth: 0,
    videoHeight: 0,
    codecId: '',
    codecPrivate: null,
    clusterTimestamp: 0,
    // Decode order, one entry per video frame: its timestamp in timescale ticks
    // (integer, exactly as the container writes it) and the byte range of its
    // encoded data, which the WebCodecs engine later fetches on demand.
    frames: [],
  };

  // Build and hand a progress report to onProgress, never letting the indicator
  // take the pass down with it. bytesRead is the cursor position — where the
  // next refill will read from, i.e. how far the pass has consumed.
  const report = (bytesRead) => {
    if (!onProgress) return;
    const elapsedMs = performance.now() - startedAt;
    const fraction = reader.size ? Math.min(1, bytesRead / reader.size) : 1;
    // ETA from the average rate over the pass so far — naturally smoothed, and
    // 0 at the ends where a remaining-time estimate is meaningless or noisy.
    const etaMs = (fraction > 0 && fraction < 1) ? elapsedMs * (1 - fraction) / fraction : 0;
    try {
      onProgress({
        bytesRead, totalBytes: reader.size, fraction, elapsedMs, etaMs,
        framesFound: state.frames.length,
      });
    } catch (progressError) {
      // An indicator that throws is the host's bug, not ours; keep indexing.
    }
  };

  const cursor = new SequentialByteCursor(reader, {
    // How many bytes each refill fetches (default 1 MB), which is also the
    // granularity of the onProgress ticks. Exposed mostly so a test can force
    // many ticks over a small clip; a real host might shrink it on a slow link
    // to report progress more often.
    chunkBytes: options.chunkBytes,
    beforeRefill: async () => {
      const now = performance.now();
      if (now - startedAt > timeoutMilliseconds) {
        throw new IndexBudgetExceededError(
          `indexing this WebM did not finish within ${timeoutMilliseconds} ms `
          + `(read ${cursor.position} of ${reader.size} bytes)`);
      }
      // A refill is one megabyte of progress: report it before fetching the next
      // chunk (the yield below then lets the host repaint its indicator).
      report(cursor.position);
      // Hand the event loop a turn every so often. Awaiting the read itself
      // usually does this, but a fast local File can resolve quickly enough to
      // starve rendering for the length of the pass.
      if (now - lastYieldedAt > 16) {
        lastYieldedAt = now;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  });

  if (await readEbmlId(cursor) !== EBML_ID.header) {
    throw new Error('not an EBML file');
  }
  const headerSize = await readEbmlVariableInt(cursor);
  if (headerSize === null) throw new Error('EBML header has no size');
  cursor.advance(headerSize);

  while (!cursor.atEnd) {
    const id = await readEbmlId(cursor);
    const size = await readEbmlVariableInt(cursor);
    const contentStart = cursor.position;
    if (id === EBML_ID.segment) {
      const end = (size === null) ? Infinity : contentStart + size;
      await readMatroskaSegment(cursor, end, state);
      if (size === null) break;   // an unknown-size Segment runs to the end
    }
    if (size === null) throw new Error('unknown-size element outside a Segment');
    cursor.position = contentStart + size;
  }

  if (!state.frames.length) {
    throw new Error('no video frames found in this WebM');
  }
  report(reader.size);   // a final 100% tick, so the host can settle the bar

  const presentationTimes =
    state.frames.map((frame) => frame.ticks * state.timestampScaleSeconds);

  // VP9 writes no CodecPrivate in practice, and its profile and bit depth are
  // needed for the codec string — they live in the first keyframe's own
  // uncompressed header, so fetch just its opening bytes. One small read, after
  // a pass that has already been over the whole file.
  let firstKeyframeBytes = null;
  if (needsFirstKeyframeBytes(state.codecId)) {
    const keyframe = state.frames.find((frame) => frame.isSync) || state.frames[0];
    const wanted = Math.min(keyframe.size, VP9_HEADER_PROBE_BYTES);
    if (wanted > 0) {
      firstKeyframeBytes = new Uint8Array(
        await reader.read(keyframe.offset, keyframe.offset + wanted - 1));
    }
  }

  return {
    presentationTimes,
    frames: state.frames,
    timescale: 1 / state.timestampScaleSeconds,
    defaultFrameDuration: state.defaultFrameDuration,
    videoWidth: state.videoWidth,
    videoHeight: state.videoHeight,
    codecId: state.codecId,
    decoderConfig: buildMatroskaDecoderConfig({
      codecId: state.codecId,
      codecPrivate: state.codecPrivate,
      videoWidth: state.videoWidth,
      videoHeight: state.videoHeight,
      firstKeyframeBytes,
      frameRate: estimateFrameRate(presentationTimes, state.defaultFrameDuration),
    }),
  };
}

// Frames per second, for the one place a codec string needs it (a VP9 level is
// defined by luma samples per second as well as per picture). DefaultDuration is
// authoritative when the track declares it; otherwise the average over the
// clip's own timestamps, which is what a variable-rate clip's level should be
// judged on anyway. Falls back to 30 for a single-frame clip.
function estimateFrameRate(presentationTimes, defaultFrameDuration) {
  if (defaultFrameDuration > 0) return 1 / defaultFrameDuration;
  const count = presentationTimes.length;
  if (count < 2) return 30;
  const span = presentationTimes[count - 1] - presentationTimes[0];
  return span > 0 ? (count - 1) / span : 30;
}

async function readMatroskaSegment(cursor, end, state) {
  while (cursor.position < end && !cursor.atEnd) {
    const id = await readEbmlId(cursor);
    const size = await readEbmlVariableInt(cursor);
    const contentStart = cursor.position;
    const contentEnd = (size === null) ? Infinity : contentStart + size;

    if (id === EBML_ID.info) await readMatroskaInfo(cursor, contentEnd, state);
    else if (id === EBML_ID.tracks) await readMatroskaTracks(cursor, contentEnd, state);
    else if (id === EBML_ID.cluster) await readMatroskaCluster(cursor, contentEnd, state);

    if (size === null) {
      // Only a cluster may have an unknown size here, and reading it leaves the
      // cursor on whatever element ended it.
      if (id !== EBML_ID.cluster) throw new Error('unknown-size element in Segment');
    } else {
      cursor.position = contentEnd;   // skip whatever we did not care about
    }
  }
}

async function readMatroskaInfo(cursor, end, state) {
  while (cursor.position < end && !cursor.atEnd) {
    const id = await readEbmlId(cursor);
    const size = await readEbmlVariableInt(cursor);
    if (size === null) throw new Error('unknown-size element in Info');
    const contentStart = cursor.position;
    if (id === EBML_ID.timestampScale) {
      // Nanoseconds per timestamp tick.
      state.timestampScaleSeconds = (await readEbmlUnsigned(cursor, size)) / 1e9;
    }
    cursor.position = contentStart + size;
  }
}

async function readMatroskaTracks(cursor, end, state) {
  while (cursor.position < end && !cursor.atEnd) {
    const id = await readEbmlId(cursor);
    const size = await readEbmlVariableInt(cursor);
    if (size === null) throw new Error('unknown-size element in Tracks');
    const contentStart = cursor.position;
    if (id === EBML_ID.trackEntry && state.videoTrackNumber === null) {
      await readMatroskaTrackEntry(cursor, contentStart + size, state);
    }
    cursor.position = contentStart + size;
  }
}

// Take the first video track, and only if it is a video track: a WebM whose
// first TrackEntry is audio must not have its audio packets counted as frames.
async function readMatroskaTrackEntry(cursor, end, state) {
  let trackNumber = null, trackType = null;
  let defaultDuration = 0, width = 0, height = 0;
  let codecId = '', codecPrivate = null;

  while (cursor.position < end && !cursor.atEnd) {
    const id = await readEbmlId(cursor);
    const size = await readEbmlVariableInt(cursor);
    if (size === null) throw new Error('unknown-size element in TrackEntry');
    const contentStart = cursor.position;

    if (id === EBML_ID.trackNumber) trackNumber = await readEbmlUnsigned(cursor, size);
    else if (id === EBML_ID.trackType) trackType = await readEbmlUnsigned(cursor, size);
    else if (id === EBML_ID.codecId) codecId = await readEbmlString(cursor, size);
    else if (id === EBML_ID.codecPrivate) codecPrivate = await readEbmlBytes(cursor, size);
    else if (id === EBML_ID.defaultDuration) {
      defaultDuration = (await readEbmlUnsigned(cursor, size)) / 1e9;   // ns
    } else if (id === EBML_ID.video) {
      const videoEnd = contentStart + size;
      while (cursor.position < videoEnd && !cursor.atEnd) {
        const videoId = await readEbmlId(cursor);
        const videoSize = await readEbmlVariableInt(cursor);
        if (videoSize === null) throw new Error('unknown-size element in Video');
        const videoContentStart = cursor.position;
        if (videoId === EBML_ID.pixelWidth) width = await readEbmlUnsigned(cursor, videoSize);
        else if (videoId === EBML_ID.pixelHeight) height = await readEbmlUnsigned(cursor, videoSize);
        cursor.position = videoContentStart + videoSize;
      }
    }
    cursor.position = contentStart + size;
  }

  if (trackType !== MATROSKA_TRACK_TYPE_VIDEO || trackNumber === null) return;
  state.videoTrackNumber = trackNumber;
  state.defaultFrameDuration = defaultDuration;
  state.videoWidth = width;
  state.videoHeight = height;
  state.codecId = codecId;
  state.codecPrivate = codecPrivate;
}

async function readMatroskaCluster(cursor, end, state) {
  state.clusterTimestamp = 0;
  while (cursor.position < end && !cursor.atEnd) {
    const idStart = cursor.position;
    const id = await readEbmlId(cursor);
    // An unknown-size cluster ends where the next Segment-level element starts:
    // put that element back for our caller to read.
    if (end === Infinity && EBML_SEGMENT_LEVEL_IDS.has(id)) {
      cursor.position = idStart;
      return;
    }
    const size = await readEbmlVariableInt(cursor);
    if (size === null) throw new Error('unknown-size element in Cluster');
    const contentStart = cursor.position;

    if (id === EBML_ID.clusterTimestamp) {
      state.clusterTimestamp = await readEbmlUnsigned(cursor, size);
    } else if (id === EBML_ID.simpleBlock) {
      // A SimpleBlock says outright whether it is a keyframe, in the top bit of
      // its flags byte.
      await readMatroskaBlock(cursor, contentStart + size, state, null);
    } else if (id === EBML_ID.blockGroup) {
      // A BlockGroup wraps a Block plus its references. The Block's header is
      // laid out exactly like a SimpleBlock's but carries NO keyframe flag —
      // what marks a BlockGroup's frame as a delta is the presence of a
      // ReferenceBlock beside it, which may appear either side of the Block. So
      // record the frame first and settle its keyframe flag once the whole group
      // has been read.
      const groupEnd = contentStart + size;
      let frameIndex = -1;
      let sawReferenceBlock = false;
      while (cursor.position < groupEnd && !cursor.atEnd) {
        const childId = await readEbmlId(cursor);
        const childSize = await readEbmlVariableInt(cursor);
        if (childSize === null) throw new Error('unknown-size element in BlockGroup');
        const childStart = cursor.position;
        if (childId === EBML_ID.block) {
          frameIndex = await readMatroskaBlock(cursor, childStart + childSize, state, false);
        } else if (childId === EBML_ID.referenceBlock) {
          sawReferenceBlock = true;
        }
        cursor.position = childStart + childSize;
      }
      if (frameIndex >= 0 && !sawReferenceBlock) state.frames[frameIndex].isSync = true;
    }
    cursor.position = contentStart + size;
  }
}

// ==================================================================
// From a Matroska track to a WebCodecs decoder configuration.
//
// Matroska names its codec in CodecID and carries whatever out-of-band setup the
// decoder needs in CodecPrivate — for H.264 and HEVC that is literally the same
// `avcC` / `hvcC` bytes an MP4 carries (so frames are length-prefixed here too,
// and need no Annex B conversion, unlike AVI), and for AV1 the `av1C` record.
// VP8 and VP9 carry no setup at all: their frames are self-describing.
//
// What WebCodecs additionally wants is a fully qualified codec STRING, and that
// is the only real work: 'vp9' is not a valid VideoDecoder codec, 'vp09.00.31.08'
// is, and the profile, level, and bit depth in it have to be right. Getting one
// wrong is not a cosmetic error — an over-claimed profile is exactly the
// dishonest-yes shape this library exists to avoid — so every field below is READ
// from the bitstream or the setup record, never assumed, and a codec we cannot
// read all of yields null. Null is a safe answer here in a way it never is for
// AVI: the clip keeps the frame-exact <video> tier it has always had.
// ==================================================================

// How much of the first keyframe to fetch for a VP9 track. Its uncompressed
// header — the only place VP9 states its profile and bit depth — is within the
// first dozen bytes; a kilobyte is slack for a frame that opens with anything
// unexpected, and is one read either way.
const VP9_HEADER_PROBE_BYTES = 1024;

// Codec setup lives in CodecPrivate for every codec we support except VP9, which
// keeps its profile and bit depth in the frames themselves.
function needsFirstKeyframeBytes(codecId) {
  return codecId === 'V_VP9';
}

// The WebCodecs decoder configuration for a Matroska video track, or null when
// the track's codec is one we cannot configure honestly (an unsupported CodecID,
// or a supported one whose CodecPrivate is missing or malformed).
export function buildMatroskaDecoderConfig(track) {
  const { codecId, codecPrivate, videoWidth, videoHeight,
          firstKeyframeBytes, frameRate } = track;
  if (!videoWidth || !videoHeight) return null;

  const configuration = (codec, description) => {
    const config = {
      codec,
      codedWidth: videoWidth,
      codedHeight: videoHeight,
      optimizeForLatency: true,
    };
    if (description) config.description = description;
    return config;
  };

  if (codecId === 'V_MPEG4/ISO/AVC') {
    // CodecPrivate IS the avcC box body — the same bytes mp4box hands back for an
    // MP4 — so the codec string comes out of it exactly as it does there.
    if (!codecPrivate || codecPrivate.length < 4) return null;
    const hex = (value) => value.toString(16).padStart(2, '0');
    return configuration(
      `avc1.${hex(codecPrivate[1])}${hex(codecPrivate[2])}${hex(codecPrivate[3])}`,
      codecPrivate);
  }

  if (codecId === 'V_MPEGH/ISO/HEVC') {
    const codec = hevcCodecString(codecPrivate);
    return codec ? configuration(codec, codecPrivate) : null;
  }

  if (codecId === 'V_VP8') {
    // VP8 has exactly one profile and one bit depth, so its codec string is the
    // whole story (WebCodecs registers it as plain 'vp8').
    return configuration('vp8');
  }

  if (codecId === 'V_VP9') {
    const codec = vp9CodecString(firstKeyframeBytes, videoWidth, videoHeight, frameRate);
    return codec ? configuration(codec) : null;
  }

  if (codecId === 'V_AV1') {
    const codec = av1CodecString(codecPrivate);
    // The av1C record holds the sequence header the decoder needs when the
    // frames do not repeat it, so pass it through as the description.
    return codec ? configuration(codec, codecPrivate) : null;
  }

  return null;   // MPEG-4 ASP, Theora-in-Matroska, VFW-wrapped oddities, ...
}

// The codec string for an HEVC track, from its `hvcC` record (ISO 14496-15
// §8.3.3.1), in the form ISO 14496-15 Annex E defines and browsers parse:
//
//   hvc1.<profile space><profile idc>.<compatibility flags>.<tier><level>.<constraints>
//   e.g. hvc1.1.6.L93.B0
//
// 'hvc1' rather than 'hev1' because Matroska keeps the parameter sets out of band
// in CodecPrivate, which is precisely what the two four-character codes
// distinguish. Returns null if the record is too short to read.
export function hevcCodecString(hvcC) {
  if (!hvcC || hvcC.length < 13) return null;
  const profileSpace = ['', 'A', 'B', 'C'][(hvcC[1] >> 6) & 0x03];
  const tierFlag = (hvcC[1] >> 5) & 0x01;
  const profileIdc = hvcC[1] & 0x1F;

  // The 32 compatibility flags are written most-significant-bit first and read
  // back reversed, then printed as hex with no leading zeros (so the common
  // 0x60000000 becomes '6').
  let compatibility = 0;
  for (let i = 0; i < 32; i++) {
    const bit = (hvcC[2 + (i >> 3)] >> (7 - (i & 7))) & 1;
    compatibility = (compatibility >>> 1) | (bit << 31);
  }

  // The six constraint bytes, trailing zero bytes dropped, each in hex with no
  // leading zeros.
  let lastNonZero = -1;
  for (let i = 0; i < 6; i++) if (hvcC[6 + i] !== 0) lastNonZero = i;
  const constraints = [];
  for (let i = 0; i <= lastNonZero; i++) {
    constraints.push(hvcC[6 + i].toString(16).toUpperCase());
  }

  const parts = [
    `hvc1.${profileSpace}${profileIdc}`,
    (compatibility >>> 0).toString(16),
    `${tierFlag ? 'H' : 'L'}${hvcC[12]}`,
  ];
  return parts.concat(constraints).join('.');
}

// The codec string for an AV1 track, from its `av1C` record (AV1 Codec ISO Media
// File Format Binding §2.3.3), in the form the AV1 codec-string registry defines:
//
//   av01.<profile>.<level><tier>.<bit depth>    e.g. av01.0.05M.08
//
// Every field is a fixed bit position in the record's first three bytes, so this
// is a read, not an inference. Returns null if the record is too short.
export function av1CodecString(av1C) {
  if (!av1C || av1C.length < 3) return null;
  const profile = (av1C[1] >> 5) & 0x07;
  const levelIndex = av1C[1] & 0x1F;
  const tier = (av1C[2] >> 7) & 0x01;
  const highBitDepth = (av1C[2] >> 6) & 0x01;
  const twelveBit = (av1C[2] >> 5) & 0x01;
  // Profile 2 is the only one that reaches 12-bit; elsewhere high_bitdepth means
  // 10-bit and nothing else.
  const bitDepth = (profile === 2 && highBitDepth)
    ? (twelveBit ? 12 : 10) : (highBitDepth ? 10 : 8);
  return `av01.${profile}.${String(levelIndex).padStart(2, '0')}`
    + `${tier ? 'H' : 'M'}.${String(bitDepth).padStart(2, '0')}`;
}

// The codec string for a VP9 track: 'vp09.<profile>.<level>.<bit depth>'.
//
// VP9 carries no setup record in practice, so the profile and bit depth are read
// out of the first keyframe's uncompressed header — the same bytes the decoder
// itself reads — and the level is computed from the picture size and frame rate
// against the level table in the VP9 specification (Annex A), which is what a
// level means. Returns null if the frame is not a readable VP9 keyframe.
export function vp9CodecString(firstKeyframeBytes, width, height, frameRate) {
  const header = parseVp9KeyframeHeader(firstKeyframeBytes);
  if (!header) return null;
  const level = vp9Level(width, height, frameRate);
  return `vp09.${String(header.profile).padStart(2, '0')}`
    + `.${String(level).padStart(2, '0')}`
    + `.${String(header.bitDepth).padStart(2, '0')}`;
}

// Profile and bit depth from a VP9 keyframe's uncompressed header (VP9 bitstream
// specification §6.2), which is plain bits at the very start of the frame:
// frame_marker(2) = 2, then the two profile bits, then — for a keyframe — a sync
// code, then the colour configuration whose first bit (profiles 2 and 3 only)
// says 10- or 12-bit. Returns null for anything that is not a VP9 keyframe.
function parseVp9KeyframeHeader(bytes) {
  if (!bytes || bytes.length < 6) return null;
  const reader = new BitReader(bytes);
  if (reader.read(2) !== 2) return null;                  // frame_marker
  const profileLowBit = reader.read(1);
  const profileHighBit = reader.read(1);
  const profile = (profileHighBit << 1) | profileLowBit;
  if (profile === 3) reader.read(1);                      // reserved_zero
  if (reader.read(1)) return null;                        // show_existing_frame
  if (reader.read(1) !== 0) return null;                  // frame_type: 0 = key
  reader.read(1);                                         // show_frame
  reader.read(1);                                         // error_resilient_mode
  if (reader.read(24) !== 0x498342) return null;          // frame_sync_code
  let bitDepth = 8;
  if (profile >= 2) bitDepth = reader.read(1) ? 12 : 10;  // ten_or_twelve_bit
  return { profile, bitDepth };
}

// The VP9 level table (VP9 specification Annex A): each level caps a luma sample
// RATE and a luma picture SIZE, and a stream's level is the lowest one that fits
// both. Levels are written in the codec string as the level number times ten
// (level 3.1 is '31').
const VP9_LEVELS = [
  { level: 10, maxSampleRate: 829440, maxPictureSize: 36864 },
  { level: 11, maxSampleRate: 2764800, maxPictureSize: 73728 },
  { level: 20, maxSampleRate: 4608000, maxPictureSize: 122880 },
  { level: 21, maxSampleRate: 9216000, maxPictureSize: 245760 },
  { level: 30, maxSampleRate: 20736000, maxPictureSize: 552960 },
  { level: 31, maxSampleRate: 36864000, maxPictureSize: 983040 },
  { level: 40, maxSampleRate: 83558400, maxPictureSize: 2228224 },
  { level: 41, maxSampleRate: 160432128, maxPictureSize: 2228224 },
  { level: 50, maxSampleRate: 311951360, maxPictureSize: 8912896 },
  { level: 51, maxSampleRate: 588251136, maxPictureSize: 8912896 },
  { level: 52, maxSampleRate: 1176502272, maxPictureSize: 8912896 },
  { level: 60, maxSampleRate: 1176502272, maxPictureSize: 35651584 },
  { level: 61, maxSampleRate: 2353004544, maxPictureSize: 35651584 },
  { level: 62, maxSampleRate: 4706009088, maxPictureSize: 35651584 },
];

function vp9Level(width, height, frameRate) {
  const pictureSize = width * height;
  const sampleRate = pictureSize * (frameRate > 0 ? frameRate : 30);
  for (const entry of VP9_LEVELS) {
    if (sampleRate <= entry.maxSampleRate && pictureSize <= entry.maxPictureSize) {
      return entry.level;
    }
  }
  return VP9_LEVELS[VP9_LEVELS.length - 1].level;   // beyond the table: the top level
}

// Most-significant-bit-first bit reader, for the handful of bitstream headers
// read here (VP9's frame header). Reads up to 24 bits at a time, which is all
// any field above needs.
class BitReader {
  constructor(bytes) { this.bytes = bytes; this.position = 0; }
  read(bitCount) {
    let value = 0;
    for (let i = 0; i < bitCount; i++) {
      const bit = (this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1;
      value = (value << 1) | bit;
      this.position += 1;
    }
    return value;
  }
}

// A block header: track number (variable-length), then the frame's timestamp as
// a signed 16-bit offset from its cluster's, then flags. Everything after the
// header, up to blockEnd, is the encoded frame — we record where it is and how
// long it is, and never read a byte of it here.
//
// keyframeFlagOverride: null for a SimpleBlock, whose flags byte states outright
// whether the frame is a keyframe; false for a BlockGroup's Block, which has no
// such flag (the caller decides from the group's ReferenceBlock).
//
// Returns the index of the frame recorded in state.frames, or -1 for a block
// belonging to another track.
async function readMatroskaBlock(cursor, blockEnd, state, keyframeFlagOverride) {
  const trackNumber = await readEbmlVariableInt(cursor);
  await cursor.ensure(3);
  const relative = ((cursor.peek(0) << 8) | cursor.peek(1)) << 16 >> 16;   // signed
  const flags = cursor.peek(2);
  cursor.advance(3);

  if (state.videoTrackNumber === null) throw new Error('WebM cluster before Tracks');
  if (trackNumber !== state.videoTrackNumber) return -1;   // audio, subtitles, ...
  // Lacing packs several frames into one block under a single timestamp, so
  // their individual times would have to be invented from DefaultDuration — and
  // their byte ranges parsed out of a lacing header. It is an audio feature and
  // essentially never used for video; refuse rather than hand back timestamps we
  // made up.
  if (flags & 0x06) throw new Error('this WebM laces its video blocks');

  const offset = cursor.position;   // the frame's own bytes start here
  state.frames.push({
    offset,
    size: blockEnd - offset,
    isSync: (keyframeFlagOverride === null) ? !!(flags & 0x80) : keyframeFlagOverride,
    ticks: state.clusterTimestamp + relative,
  });
  return state.frames.length - 1;
}

