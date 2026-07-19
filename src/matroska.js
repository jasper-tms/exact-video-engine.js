// ==================================================================
// Matroska/WebM frame table — the second way to get real timestamps.
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
  cluster: 0x1F43B675,
  clusterTimestamp: 0xE7,
  simpleBlock: 0xA3,
  blockGroup: 0xA0,
  block: 0xA1,
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

// Read the timestamps of every frame of the file's first video track.
//
// options.timeoutMilliseconds  give up after this long (Infinity: never)
// options.maxBytes             refuse a file bigger than this (Infinity: any)
// options.onProgress           called ~once per megabyte with a progress report
//                              (see formatProgress) during the pass, and once
//                              more at 100% when it finishes. A throw from it is
//                              swallowed so a buggy indicator cannot abort a load.
//
// Returns {presentationTimes (seconds, file order), defaultFrameDuration,
// videoWidth, videoHeight}. Throws IndexBudgetExceededError when it runs out of
// budget, and a plain Error when the file is not one we can read.
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
    clusterTimestamp: 0,
    presentationTimes: [],
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
        framesFound: state.presentationTimes.length,
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

  if (!state.presentationTimes.length) {
    throw new Error('no video frames found in this WebM');
  }
  report(reader.size);   // a final 100% tick, so the host can settle the bar
  return state;
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

  while (cursor.position < end && !cursor.atEnd) {
    const id = await readEbmlId(cursor);
    const size = await readEbmlVariableInt(cursor);
    if (size === null) throw new Error('unknown-size element in TrackEntry');
    const contentStart = cursor.position;

    if (id === EBML_ID.trackNumber) trackNumber = await readEbmlUnsigned(cursor, size);
    else if (id === EBML_ID.trackType) trackType = await readEbmlUnsigned(cursor, size);
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
      await readMatroskaBlock(cursor, state);
    } else if (id === EBML_ID.blockGroup) {
      // A BlockGroup wraps a Block plus its references; the Block's header is
      // laid out exactly like a SimpleBlock's, and only its timestamp interests
      // us (keyframe flags do not: this index never feeds a decoder).
      const groupEnd = contentStart + size;
      while (cursor.position < groupEnd && !cursor.atEnd) {
        const childId = await readEbmlId(cursor);
        const childSize = await readEbmlVariableInt(cursor);
        if (childSize === null) throw new Error('unknown-size element in BlockGroup');
        const childStart = cursor.position;
        if (childId === EBML_ID.block) await readMatroskaBlock(cursor, state);
        cursor.position = childStart + childSize;
      }
    }
    cursor.position = contentStart + size;
  }
}

// A block header: track number (variable-length), then the frame's timestamp as
// a signed 16-bit offset from its cluster's, then flags. The payload after it is
// the encoded frame, which we never read.
async function readMatroskaBlock(cursor, state) {
  const trackNumber = await readEbmlVariableInt(cursor);
  await cursor.ensure(3);
  const relative = ((cursor.peek(0) << 8) | cursor.peek(1)) << 16 >> 16;   // signed
  const flags = cursor.peek(2);
  cursor.advance(3);

  if (state.videoTrackNumber === null) throw new Error('WebM cluster before Tracks');
  if (trackNumber !== state.videoTrackNumber) return;   // audio, subtitles, ...
  // Lacing packs several frames into one block under a single timestamp, so
  // their individual times would have to be invented from DefaultDuration. It is
  // an audio feature and essentially never used for video; refuse rather than
  // hand back timestamps we made up.
  if (flags & 0x06) throw new Error('this WebM laces its video blocks');

  state.presentationTimes.push(
    (state.clusterTimestamp + relative) * state.timestampScaleSeconds);
}

