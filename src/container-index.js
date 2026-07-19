import { createRangeReader } from './range-readers.js';
import { readMatroskaFrameTable } from './matroska.js';

// ==================================================================
// ContainerIndex — everything the moov tells us, with nothing decoded.
//
// This is the piece both engines want and neither can get from a <video>
// element: the real per-frame presentation timestamp table (B-frame safe,
// variable-frame-rate safe), plus the sample table, the display rotation, and
// the decoder configuration. Building it reads only the moov — a few range
// requests, no frame bytes, no VideoDecoder — so it works in browsers that have
// no WebCodecs at all, which is exactly what makes the <video> fallback
// frame-exact rather than fps-guessing.
//
// Two containers, two ways in, one table out. ISOBMFF (mp4/m4v/mov) goes
// through mp4box, which reads the moov and hands back a full sample table:
// timestamps, byte ranges, keyframes, decoder configuration — everything, from a
// few range requests. WebM/Matroska goes through readMatroskaFrameTable above,
// which streams the file to collect the timestamps alone. So a WebM index is
// deliberately a lesser thing: it carries the per-frame PTS table (which is what
// makes the <video> path exact, and the whole point of the exercise) but no
// sample table and no decoder configuration, so WebCodecs cannot decode from it.
// `supportsWebCodecs` is how the ladder in createBestEngine tells them apart.
//
// Anything else (Ogg, HLS) still fails here, and the <video> element still plays
// it without an exact index. That is the intended degradation, not a bug.
// ==================================================================
export class ContainerIndex {
  constructor(reader) {
    this.reader = reader;
    this.timescale = 1;
    this.containerFormat = null;     // 'isobmff' | 'matroska'

    // Decode-order sample table (no frame bytes): {offset, size, isSync, cts,
    // duration}. The byte ranges the decoder will later fetch on demand.
    this.samples = null;
    this.keyframeDecodeIndices = null;   // sorted decode indices of sync samples

    // Display order (samples sorted by composition time).
    this.presentationTimes = null;   // Float64Array, seconds, frame 0 at t = 0
    this.frameDurations = null;      // Float64Array, seconds
    this.displayToDecode = null;     // Int32Array, displayIndex -> decode index
    this.microsToDisplay = null;     // Map<chunkTimestampMicros, displayIndex>

    this.decoderConfig = null;
    this.rotation = 0;               // 0/90/180/270
    this.videoWidth = 0;             // upright display dimensions (rotation applied)
    this.videoHeight = 0;
    this.numFrames = 0;
    this.duration = 0;               // seconds (sum of real frame durations)
  }

  // Only an ISOBMFF index has what a VideoDecoder needs (the byte ranges of
  // every sample, and the codec's configuration). A WebM index has timestamps
  // and nothing else, so it can make the <video> element exact but cannot feed
  // the WebCodecs engine.
  get supportsWebCodecs() { return !!(this.samples && this.decoderConfig); }

  // options.timeoutMilliseconds / options.maxBytes bound the WebM pass (see
  // readMatroskaFrameTable); they are ignored for ISOBMFF, which is a handful of
  // range reads however long the clip is.
  static async load(reader, options = {}) {
    const index = new ContainerIndex(reader);
    if (await ContainerIndex._isMatroska(reader)) await index._demuxMatroska(reader, options);
    else await index._demuxIsobmff(reader);
    return index;
  }

  // Build an index straight from a source, for hosts that want the frame table
  // without instantiating an engine.
  static async fromSource(source, options = {}) {
    const reader = createRangeReader(source);
    await reader.init();
    return await ContainerIndex.load(reader, options);
  }

  // WebM and MP4 are told apart by their first bytes, not by a file extension or
  // a MIME type: the source may be a Blob with neither.
  static async _isMatroska(reader) {
    if (reader.size < 4) return false;
    const magic = new Uint8Array(await reader.read(0, 3));
    return magic[0] === 0x1A && magic[1] === 0x45
      && magic[2] === 0xDF && magic[3] === 0xA3;   // EBML
  }

  // Largest display frame whose presentation time is <= t (binary search over
  // the real per-frame PTS table — no fps assumption, so constant and variable
  // frame rate alike).
  frameAtTime(t) {
    const times = this.presentationTimes;
    if (!times || !times.length) return 0;
    let lo = 0, hi = times.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // Frame index plus the fraction elapsed through that frame's real display
  // interval — the continuous playhead a synchronized overlay should follow.
  frameFloatAtTime(t) {
    const times = this.presentationTimes;
    if (!times || !times.length) return 0;
    const n = this.frameAtTime(t);
    const start = times[n];
    const end = (n + 1 < times.length)
      ? times[n + 1] : start + this.frameDurations[n];
    const span = end - start;
    const fraction = span > 0 ? (t - start) / span : 0;
    return n + Math.max(0, Math.min(1, fraction));
  }

  // The frame index of a timestamp that is known to BE a frame's presentation
  // time — what requestVideoFrameCallback reports for the frame on screen.
  //
  // Not the same question as frameAtTime, and it must not be answered the same
  // way. Our table computes each time from the container's integer composition
  // time and timescale; the browser computes its mediaTime (and its duration,
  // which it clamps seeks against) its own way, and the two disagree in the last
  // few microseconds. Under "largest entry at or below t" an undershoot that
  // small reads as the PREVIOUS frame — a whole frame wrong, from a rounding
  // error a thousand times smaller than a frame. Snapping to the entry within a
  // tolerance far below any real frame duration is immune to that.
  frameOfPresentedTime(t) {
    const SNAP_SECONDS = 1e-4;   // ~100x the disagreement, ~1/40th of a 240fps frame
    return this.frameAtTime(t + SNAP_SECONDS);
  }

  // The midpoint of frame n's display interval. Seeking a <video> element here
  // (rather than to the frame's start, which sits exactly on the boundary the
  // browser rounds at) is what makes it land on frame n and not its neighbour.
  midpointOfFrame(n) {
    const times = this.presentationTimes;
    const start = times[n];
    const end = (n + 1 < times.length)
      ? times[n + 1] : start + this.frameDurations[n];
    return (start + end) / 2;
  }

  async _demuxIsobmff(reader) {
    if (typeof MP4Box === 'undefined') throw new Error('mp4box.js is not loaded');
    const file = MP4Box.createFile(false);   // false: discard mdat bytes
    let info = null, demuxError = null;
    file.onReady = (i) => { info = i; };
    file.onError = (e) => { demuxError = new Error('mp4box: ' + e); };

    // Feed the container until the moov (index) is parsed. appendBuffer returns
    // the next byte offset it wants, which jumps past the mdat when the moov
    // sits at the end of the file — so we never read frame bytes here.
    const CHUNK = 1 << 18;   // 256 KB
    let offset = 0;
    while (info === null && demuxError === null && offset < reader.size) {
      const end = Math.min(offset + CHUNK, reader.size) - 1;
      const buffer = await reader.read(offset, end);
      if (!buffer.byteLength) break;
      buffer.fileStart = offset;
      offset = file.appendBuffer(buffer);
    }
    file.flush();
    if (demuxError) throw demuxError;
    if (!info) throw new Error('no moov found (not a valid MP4?)');

    const videoTrack = info.videoTracks && info.videoTracks[0];
    if (!videoTrack) throw new Error('no video track in file');

    this.decoderConfig = {
      codec: videoTrack.codec,
      codedWidth: videoTrack.video.width,
      codedHeight: videoTrack.video.height,
      description: this._codecDescription(file, videoTrack.id),
      optimizeForLatency: true,   // emit frames promptly; less internal buffering
    };

    // Display geometry. Phone clips are commonly coded landscape with a 90°
    // track rotation matrix; a <video> tag applies it but VideoDecoder does
    // not, so VideoEngine's presentation (and any consumer annotating over the
    // video) must. videoWidth/videoHeight are the upright *display* dimensions
    // — axes swapped relative to the coded frame when rotation is 90/270 — and
    // mean the same thing in both engines.
    this.rotation = this._trackRotation(videoTrack);
    const swapAxes = this.rotation === 90 || this.rotation === 270;
    this.videoWidth = swapAxes ? videoTrack.video.height : videoTrack.video.width;
    this.videoHeight = swapAxes ? videoTrack.video.width : videoTrack.video.height;

    this._buildTables(file.getTrackSamplesInfo(videoTrack.id));
    this.containerFormat = 'isobmff';
  }

  // WebM: the timestamps and nothing else (see readMatroskaFrameTable). The
  // fields a decoder would need — samples, keyframeDecodeIndices,
  // decoderConfig — stay null, and supportsWebCodecs reports false because of it.
  async _demuxMatroska(reader, options) {
    const table = await readMatroskaFrameTable(reader, options);
    this.containerFormat = 'matroska';
    this.videoWidth = table.videoWidth;
    this.videoHeight = table.videoHeight;
    // Matroska carries no display rotation matrix (the element applies none
    // either, so the two agree).
    this.rotation = 0;

    // Blocks are written in decode order, and a Matroska block's timestamp is
    // already a *presentation* time, so with B-frames the times can arrive out
    // of order. Sorting gives display order — the same normalization the
    // ISOBMFF path does by sorting on composition time.
    const times = table.presentationTimes.slice().sort((a, b) => a - b);
    const n = times.length;
    const firstTime = times[0];

    this.presentationTimes = new Float64Array(n);
    this.frameDurations = new Float64Array(n);
    for (let d = 0; d < n; d++) this.presentationTimes[d] = times[d] - firstTime;
    // Matroska stores no per-frame duration, so a frame lasts until the next one
    // starts. The last frame has no next one: fall back to the track's declared
    // DefaultDuration, then to the previous frame's, then to a nominal 30fps.
    for (let d = 0; d < n - 1; d++) {
      this.frameDurations[d] = this.presentationTimes[d + 1] - this.presentationTimes[d];
    }
    if (n) {
      this.frameDurations[n - 1] = table.defaultFrameDuration
        || (n > 1 ? this.frameDurations[n - 2] : 1 / 30);
    }

    this.numFrames = n;
    this.duration = n
      ? this.presentationTimes[n - 1] + this.frameDurations[n - 1] : 0;
  }

  _codecDescription(file, trackId) {
    // The avcC/hvcC/etc. box bytes that VideoDecoder.configure needs, serialized
    // and stripped of the 8-byte box header (size + type). Recipe from the W3C
    // WebCodecs mp4-decode sample.
    const trak = file.getTrackById(trackId);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
      const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
      if (box) {
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8);
      }
    }
    return undefined;   // VP8/VP9/AV1 may legitimately carry no description
  }

  // The track's display rotation in degrees (0/90/180/270), read from the
  // tkhd matrix (2x2 rotation part, 16.16 fixed point). Anything that isn't a
  // clean multiple of 90 is treated as 0.
  _trackRotation(videoTrack) {
    const matrix = videoTrack.matrix;
    if (!matrix || matrix.length < 5) return 0;
    const a = matrix[0] / 65536, b = matrix[1] / 65536;
    const degrees = Math.round(Math.atan2(b, a) * 180 / Math.PI);
    const normalized = ((degrees % 360) + 360) % 360;
    return (normalized % 90 === 0) ? normalized : 0;
  }

  _buildTables(samples) {
    const n = samples.length;
    this.timescale = n ? samples[0].timescale : 1;

    // Decode-order records (the first sample is always a keyframe).
    this.samples = new Array(n);
    const keyframes = [];
    for (let k = 0; k < n; k++) {
      const s = samples[k];
      const isSync = !!s.is_sync || k === 0;
      if (isSync) keyframes.push(k);
      this.samples[k] = {
        offset: s.offset, size: s.size, isSync, cts: s.cts, duration: s.duration,
      };
    }
    this.keyframeDecodeIndices = keyframes;   // ascending == decode order

    // Display order = samples sorted by composition time (B-frame safe). Times
    // are normalized so display frame 0 sits at t = 0: with B-frames the first
    // composition time is often a nonzero offset, and both engines want a
    // timeline whose origin is the first frame the viewer sees.
    const order = Array.from({ length: n }, (_, k) => k);
    order.sort((a, b) => this.samples[a].cts - this.samples[b].cts);
    const cts0 = n ? this.samples[order[0]].cts : 0;
    this.presentationTimes = new Float64Array(n);
    this.frameDurations = new Float64Array(n);
    this.displayToDecode = new Int32Array(n);
    this.microsToDisplay = new Map();
    for (let d = 0; d < n; d++) {
      const k = order[d];
      const s = this.samples[k];
      this.presentationTimes[d] = (s.cts - cts0) / this.timescale;
      this.frameDurations[d] = s.duration / this.timescale;
      this.displayToDecode[d] = k;
      this.microsToDisplay.set(Math.round(s.cts * 1e6 / this.timescale), d);
    }
    this.numFrames = n;
    this.duration = n
      ? this.presentationTimes[n - 1] + this.frameDurations[n - 1] : 0;
  }
}

