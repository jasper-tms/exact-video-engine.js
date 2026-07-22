import { createRangeReader } from './range-readers.js';
import { deriveIndexCacheKey, loadCachedIndexPayload, storeCachedIndexPayload, serializeContainerIndex, hydrateContainerIndex } from './index-cache.js';
import { readMatroskaFrameTable, IndexBudgetExceededError } from './matroska.js';
import { readOggFrameTable } from './ogg.js';
import { readAviFrameTable } from './avi.js';

// A build faster than this is not worth caching: a classic single-moov MP4
// indexes in a few range reads and would only churn the cache, while a
// full-file pass (WebM, fragmented MP4, Ogg) that took this long once is
// exactly the cost the cache exists to not pay twice. Matches the npimage
// heuristic. Overridable per call (options.cacheMinimumBuildMilliseconds),
// which the tests use to force tiny fixtures through the cache path.
const CACHE_MINIMUM_BUILD_MILLISECONDS = 500;

// ==================================================================
// ContainerIndex — everything the container tells us, with nothing decoded.
//
// This is the piece both engines want and neither can get from a <video>
// element: the real per-frame presentation timestamp table (B-frame safe,
// variable-frame-rate safe), plus (where the container carries them) the sample
// table, the display rotation, and the decoder configuration. Building it never
// decodes a frame, so it works in browsers that have no WebCodecs at all, which
// is exactly what makes the <video> fallback frame-exact rather than fps-guessing.
//
// Four containers, four ways in, one table out.
//
//   * ISOBMFF (mp4/m4v/mov) goes through mp4box. A classic single-`moov` file is
//     the cheap case: a few range reads hand back a full sample table (times,
//     byte ranges, keyframes, decoder configuration) however long the clip is. A
//     FRAGMENTED file (fMP4/CMAF: the samples live in `moof` boxes scattered the
//     length of the file, not in the `moov`) is not cheap — its sample table is
//     empty at `onReady`, so we keep feeding the whole file through mp4box, and
//     that full-file pass takes the same budget/progress contract as the WebM and
//     Ogg scans below.
//   * WebM/Matroska goes through readMatroskaFrameTable, which streams the file to
//     collect the timestamps alone. So a WebM index is deliberately a lesser
//     thing: it carries the per-frame presentation-time table (which is what makes
//     the <video> path exact, and the whole point of the exercise) but no sample
//     table and no decoder configuration.
//   * Ogg/Theora goes through readOggFrameTable, likewise a full-file pass for the
//     timestamps alone, and likewise no sample table or decoder configuration —
//     Ogg plays only through the native <video> path (Firefox), never WebCodecs.
//   * AVI (RIFF/`AVI `) goes through readAviFrameTable, and is the odd one out: it
//     builds a FULL decode-order sample table plus a decoderConfig, exactly like
//     the ISOBMFF path, NOT a timestamps-only table like WebM/Ogg. It must, because
//     no browser plays AVI through a <video> element — there is no native tier for
//     it — so the WebCodecs engine is the only way an AVI ever plays, and that
//     engine needs the sample table and the decoder configuration. Building the
//     table does not read the frame bytes (the idx1 / OpenDML index enumerates
//     them), only the header, the index, and the first keyframe (for the H.264
//     SPS/PPS, from which the AVCC decoder configuration is built).
//     An AVI whose codec WebCodecs cannot decode yields no decoderConfig and is
//     refused cleanly, since it has no native fallback to land on.
//
// `supportsWebCodecs` is how the ladder in createBestEngine tells the decodable
// indexes (ISOBMFF and AVI) from the native-only ones (WebM and Ogg).
//
// Anything else (HLS and other segmented delivery, raw elementary streams) still
// fails here, and the <video> element cannot play those either. That is the
// intended refusal, not a bug.
// ==================================================================
export class ContainerIndex {
  constructor(reader) {
    this.reader = reader;
    this.timescale = 1;
    this.containerFormat = null;     // 'isobmff' | 'matroska' | 'ogg' | 'avi'

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
    // True when this.samples carry an Annex B bitstream (AVI's H.264) that the
    // decode path must convert to length-prefixed AVCC before feeding the decoder,
    // which is configured in AVCC mode (decoderConfig.description present). False
    // for containers whose samples are already length-prefixed (ISOBMFF).
    this.samplesAreAnnexB = false;
    this.rotation = 0;               // 0/90/180/270
    this.videoWidth = 0;             // upright display dimensions (rotation applied)
    this.videoHeight = 0;
    this.numFrames = 0;
    this.duration = 0;               // seconds (sum of real frame durations)
    // True when a trimming edit list excluded samples from the display tables
    // (the sample table still holds them for the decoder). Recorded because not
    // every browser honors a trim the same way — Gecko presents the untrimmed
    // frames, a whole-frame shift no runtime check can see — and the native
    // engine refuses the combination rather than mislabel every frame.
    this.trimmedByEditList = false;

    // Set by fromSource: true when this index was hydrated from the IndexedDB
    // cache rather than parsed out of the container, and (on a build that was
    // stored) the promise of the best-effort cache write, so a caller that wants
    // to observe the store — a test, mainly — can await it. Neither affects the
    // index's contents: a hydrated index answers every query identically to a
    // freshly built one, or it would not have been trusted.
    this.fromCache = false;
    this.cacheWritePromise = null;
  }

  // Only an ISOBMFF index has what a VideoDecoder needs (the byte ranges of
  // every sample, and the codec's configuration). A WebM index has timestamps
  // and nothing else, so it can make the <video> element exact but cannot feed
  // the WebCodecs engine.
  get supportsWebCodecs() { return !!(this.samples && this.decoderConfig); }

  // options.timeoutMilliseconds / options.maxBytes / options.onProgress /
  // options.chunkBytes bound and report the full-file passes (WebM, Ogg, and a
  // FRAGMENTED MP4 — see readMatroskaFrameTable / readOggFrameTable /
  // _demuxIsobmff). They are inert for a classic single-`moov` MP4, which is a
  // handful of range reads however long the clip is.
  static async load(reader, options = {}) {
    const index = new ContainerIndex(reader);
    if (await ContainerIndex._isMatroska(reader)) await index._demuxMatroska(reader, options);
    else if (await ContainerIndex._isOgg(reader)) await index._demuxOgg(reader, options);
    else if (await ContainerIndex._isAvi(reader)) await index._demuxAvi(reader, options);
    else await index._demuxIsobmff(reader, options);
    return index;
  }

  // Build an index straight from a source, for hosts that want the frame table
  // without instantiating an engine. This is also where the index cache lives:
  // an expensive build (a full-file pass over a WebM, fragmented MP4, or Ogg)
  // is stored in IndexedDB and reused when the SAME clip is opened again.
  //
  // Sameness is proven, never assumed — a stale cached index is a WRONG index,
  // the silent off-by-one this library exists to prevent — so the key is the
  // source's full identity ((name, size, lastModified) for a File; URL + size +
  // strong ETag/Last-Modified for a URL; see deriveIndexCacheKey), and anything
  // doubtful is a miss and a rebuild. Every cache failure degrades to
  // rebuilding, never to guessing. options.cache: false skips the cache
  // entirely; options.cacheMinimumBuildMilliseconds overrides the store
  // threshold (tests force it to 0 so tiny fixtures exercise the cache path).
  static async fromSource(source, options = {}) {
    const reader = createRangeReader(source);
    await reader.init();

    const cacheKey = (options.cache === false)
      ? null : deriveIndexCacheKey(source, reader);
    if (cacheKey) {
      const payload = await loadCachedIndexPayload(cacheKey);
      if (payload) {
        const cachedIndex = new ContainerIndex(reader);
        // hydrate can still refuse (a schema mismatch that slipped the version
        // check); that is a miss like any other, and we fall through to a build.
        if (hydrateContainerIndex(cachedIndex, payload)) {
          cachedIndex.fromCache = true;
          return cachedIndex;
        }
      }
    }

    const buildStartedAt = performance.now();
    const index = await ContainerIndex.load(reader, options);
    const buildMilliseconds = performance.now() - buildStartedAt;
    const minimumBuildMilliseconds = (options.cacheMinimumBuildMilliseconds === undefined)
      ? CACHE_MINIMUM_BUILD_MILLISECONDS : options.cacheMinimumBuildMilliseconds;
    if (cacheKey && buildMilliseconds >= minimumBuildMilliseconds) {
      // Fire-and-forget: the write never throws and the caller is not made to
      // wait on bookkeeping. The promise is exposed for tests that must not
      // race it.
      index.cacheWritePromise =
        storeCachedIndexPayload(cacheKey, serializeContainerIndex(index));
    }
    return index;
  }

  // WebM and MP4 are told apart by their first bytes, not by a file extension or
  // a MIME type: the source may be a Blob with neither.
  static async _isMatroska(reader) {
    if (reader.size < 4) return false;
    const magic = new Uint8Array(await reader.read(0, 3));
    return magic[0] === 0x1A && magic[1] === 0x45
      && magic[2] === 0xDF && magic[3] === 0xA3;   // EBML
  }

  // Ogg is likewise told apart by its first bytes, not an extension: every Ogg
  // file (and every page in it) begins with the "OggS" capture pattern.
  static async _isOgg(reader) {
    if (reader.size < 4) return false;
    const magic = new Uint8Array(await reader.read(0, 3));
    return magic[0] === 0x4F && magic[1] === 0x67
      && magic[2] === 0x67 && magic[3] === 0x53;   // "OggS"
  }

  // AVI is a RIFF file whose form type is `AVI `: bytes 0..3 are "RIFF" and bytes
  // 8..11 are "AVI " (bytes 4..7 are the RIFF size, which we do not need here).
  // Read the 12 bytes that carry both, guarding on the file being that long.
  static async _isAvi(reader) {
    if (reader.size < 12) return false;
    const magic = new Uint8Array(await reader.read(0, 11));
    return magic[0] === 0x52 && magic[1] === 0x49
      && magic[2] === 0x46 && magic[3] === 0x46    // "RIFF"
      && magic[8] === 0x41 && magic[9] === 0x56
      && magic[10] === 0x49 && magic[11] === 0x20; // "AVI "
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

  async _demuxIsobmff(reader, options = {}) {
    if (typeof MP4Box === 'undefined') throw new Error('mp4box.js is not loaded');
    const file = MP4Box.createFile(false);   // false: discard mdat bytes
    let info = null, demuxError = null;
    file.onReady = (i) => { info = i; };
    file.onError = (e) => { demuxError = new Error('mp4box: ' + e); };

    // Phase 1 — feed the container until the moov (index) is parsed. appendBuffer
    // returns the next byte offset it wants, which jumps past the mdat when the
    // moov sits at the end of the file — so we never read frame bytes here. This
    // is the whole cost for a classic single-`moov` MP4, and it stays exactly as
    // cheap as before: a few range reads, no budget, no progress ticks, no yields.
    const READY_CHUNK = 1 << 18;   // 256 KB
    let offset = 0;
    while (info === null && demuxError === null && offset < reader.size) {
      const end = Math.min(offset + READY_CHUNK, reader.size) - 1;
      const buffer = await reader.read(offset, end);
      if (!buffer.byteLength) break;
      buffer.fileStart = offset;
      offset = file.appendBuffer(buffer);
    }
    if (demuxError) throw demuxError;
    if (!info) { file.flush(); throw new Error('no moov found (not a valid MP4?)'); }

    const videoTrack = info.videoTracks && info.videoTracks[0];
    if (!videoTrack) { file.flush(); throw new Error('no video track in file'); }

    // Is this a fragmented MP4 (fMP4/CMAF)? Its samples live in `moof` boxes
    // scattered the length of the file rather than in the `moov`, so at onReady
    // the sample table is empty and the real work is still ahead. mp4box reports
    // the presence of an `mvex` box as info.isFragmented; as a belt-and-braces
    // check we also treat an empty video sample table with file still unread as
    // fragmented (a classic file's table is already complete here, even a
    // faststart one whose mdat we have not touched).
    const readySampleCount = file.getTrackSamplesInfo(videoTrack.id).length;
    const isFragmented = !!info.isFragmented || (readySampleCount === 0 && offset < reader.size);

    if (isFragmented) {
      await this._demuxFragmentedIsobmff(reader, file, videoTrack, options,
        () => demuxError, offset);
    }
    file.flush();
    if (demuxError) throw demuxError;

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

    this._buildTables(file.getTrackSamplesInfo(videoTrack.id),
      this._editListWindow(videoTrack));
    this.containerFormat = 'isobmff';
  }

  // Phase 2 of the ISOBMFF open, for a fragmented file only: feed the whole file
  // through mp4box so every `moof` box is parsed and the sample table is complete
  // before _demuxIsobmff reads it. This is the expensive path a classic MP4 never
  // touches, so it carries the same budget/progress/yield contract as the WebM and
  // Ogg passes (see readMatroskaFrameTable). Still no frame bytes are decoded —
  // createFile(false) discards mdat payloads and appendBuffer skips past them — so
  // this reads the container's structure, not its pixels.
  //
  // getDemuxError() surfaces a late mp4box parse error from _demuxIsobmff's onError
  // closure; startOffset is where phase 1 left the cursor (just past the moov).
  async _demuxFragmentedIsobmff(reader, file, videoTrack, options, getDemuxError, startOffset) {
    const maxBytes = (options.maxBytes === undefined) ? Infinity : options.maxBytes;
    // Refuse an oversized file BEFORE the full-file pass, the same gate the
    // Matroska and Ogg scans apply — reading all of it is exactly the cost.
    if (reader.size > maxBytes) {
      throw new IndexBudgetExceededError(
        `fragmented MP4 is ${reader.size} bytes; indexing it means reading all of `
        + `them, and the caller's limit is ${maxBytes}`);
    }
    const timeoutMilliseconds = (options.timeoutMilliseconds === undefined)
      ? Infinity : options.timeoutMilliseconds;
    if (!(timeoutMilliseconds > 0)) {
      throw new IndexBudgetExceededError('no time allowed to index this fragmented MP4');
    }

    const onProgress = (typeof options.onProgress === 'function') ? options.onProgress : null;
    const chunkBytes = options.chunkBytes || (1 << 20);   // 1 MB, like the Matroska pass

    const startedAt = performance.now();
    let lastYieldedAt = startedAt;

    // The same report shape the Matroska/Ogg passes emit. framesFound is
    // best-effort: the number of video samples mp4box has parsed from `moof` boxes
    // so far (a cheap read of the track's growing sample array; 0 before any
    // appear).
    const report = (bytesRead) => {
      if (!onProgress) return;
      const elapsedMs = performance.now() - startedAt;
      const fraction = reader.size ? Math.min(1, bytesRead / reader.size) : 1;
      const etaMs = (fraction > 0 && fraction < 1) ? elapsedMs * (1 - fraction) / fraction : 0;
      try {
        onProgress({
          bytesRead, totalBytes: reader.size, fraction, elapsedMs, etaMs,
          framesFound: file.getTrackSamplesInfo(videoTrack.id).length,
        });
      } catch (progressError) {
        // A throwing indicator is the host's bug, not ours; keep indexing.
      }
    };

    // appendBuffer returns the next byte offset it wants (often skipping an mdat);
    // follow it exactly as phase 1 does. If it fails to advance, step to the end of
    // the chunk ourselves so a stubborn file cannot stall the pass.
    let offset = startOffset;
    while (getDemuxError() === null && offset < reader.size) {
      const now = performance.now();
      if (now - startedAt > timeoutMilliseconds) {
        throw new IndexBudgetExceededError(
          `indexing this fragmented MP4 did not finish within ${timeoutMilliseconds} ms `
          + `(read ${offset} of ${reader.size} bytes)`);
      }
      // A chunk of progress: report it, then let the event loop breathe so a large
      // local file cannot freeze the page (awaiting the read usually yields, but a
      // fast disk can resolve quickly enough to starve rendering).
      report(offset);
      if (now - lastYieldedAt > 16) {
        lastYieldedAt = now;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const end = Math.min(offset + chunkBytes, reader.size) - 1;
      const buffer = await reader.read(offset, end);
      if (!buffer.byteLength) break;
      buffer.fileStart = offset;
      const next = file.appendBuffer(buffer);
      offset = (next > offset) ? next : end + 1;
    }
    report(reader.size);   // a final 100% tick, so the host can settle the bar
  }

  // Ogg/Theora: the timestamps and nothing else (see readOggFrameTable), the same
  // shape as the Matroska path. samples, keyframeDecodeIndices and decoderConfig
  // stay null, so supportsWebCodecs reports false and the clip plays only through
  // the native <video> element (Firefox).
  async _demuxOgg(reader, options) {
    const table = await readOggFrameTable(reader, options);
    this.containerFormat = 'ogg';
    this.videoWidth = table.videoWidth;
    this.videoHeight = table.videoHeight;
    // Ogg carries no display rotation matrix (and the <video> element applies
    // none either, so the two agree).
    this.rotation = 0;

    // readOggFrameTable already returns times in presentation order with the first
    // frame at t = 0 (Theora is constant-frame-duration, so there is no B-frame
    // reordering to undo — unlike the Matroska path, which must sort). Build the
    // display tables directly.
    const times = table.presentationTimes;
    const n = times.length;
    this.presentationTimes = new Float64Array(n);
    this.frameDurations = new Float64Array(n);
    for (let d = 0; d < n; d++) this.presentationTimes[d] = times[d];
    // A frame lasts until the next one starts; the last frame has no next one, so
    // it falls back to the codec's constant frame duration (then, defensively, to
    // the previous frame's, then to a nominal 30fps) — mirroring the Matroska path.
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

  // The composition-time window the container's edit list actually presents, in
  // MEDIA timescale units (the same units sample.cts is in), or null for "the
  // whole track". A trimming edit list makes the sample table describe more
  // frames than the element ever shows — the samples before the trim point stay
  // in the table because the decoder needs them, but they are never presented —
  // and _buildTables uses this window to number frames over only the presented
  // ones, so display frame 0 is the first frame the viewer sees on either engine.
  //
  // Scope is deliberately the common real-world shape: a phone-style trim, which
  // is one normal-rate edit (optionally preceded by an empty edit — a leading
  // gap, media_time -1, which shifts the presentation clock but presents no media
  // and is handled by the timeline calibration, not here). Anything more elaborate
  // — several edits, a rate change — returns null, leaving every frame presented
  // (the pre-existing behaviour): the WebCodecs path shows them all and the native
  // path's duration check still refuses an index it cannot trust.
  _editListWindow(videoTrack) {
    const edits = videoTrack.edits;
    if (!edits || !edits.length) return null;
    const presentedEdits = edits.filter((e) => e.media_time >= 0);
    if (presentedEdits.length !== 1) return null;
    const edit = presentedEdits[0];
    if (edit.media_rate_integer !== undefined && edit.media_rate_integer !== 1) {
      return null;   // a slow/fast edit; not a plain trim
    }
    const mediaTimescale = videoTrack.timescale;
    const movieTimescale = videoTrack.movie_timescale || mediaTimescale;
    // media_time is already in media units; segment_duration is in MOVIE units,
    // so convert it across before adding.
    const start = edit.media_time;
    const spanMediaUnits = edit.segment_duration * mediaTimescale / movieTimescale;
    return { start, end: start + spanMediaUnits };
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

  // AVI: unlike the WebM and Ogg paths above, this builds a FULL decode-order
  // sample table and a decoderConfig — the ISOBMFF shape, not the timestamps-only
  // one — because AVI has no native <video> fallback, so the WebCodecs engine is
  // the only tier that can ever play it (see readAviFrameTable and the class
  // comment). AVI is constant-frame-rate with no B-frames, so each frame's
  // composition time is synthesized as frameIndex * dwScale in a timescale of
  // dwRate, and there is no edit list to apply (editWindow = null).
  //
  // A clip whose codec we cannot form a decoderConfig for (uncompressed, MJPEG,
  // …) arrives here with decoderConfig === null; we throw a clear error rather
  // than build a half-index that would leave supportsWebCodecs false with nothing
  // to fall back to. createBestEngine turns that into the same clean refusal any
  // unindexable clip gets.
  async _demuxAvi(reader, options) {
    const table = await readAviFrameTable(reader, options);
    this.containerFormat = 'avi';

    if (!table.decoderConfig) {
      throw new Error(
        `this AVI's video codec (${JSON.stringify(table.fourCc)}) is not one WebCodecs `
        + 'can decode, and AVI has no native <video> fallback, so the clip is refused. '
        + '(Uncompressed and MJPEG AVI are intentionally out of scope.)');
    }

    // Synthesize the decode-order sample records _buildTables consumes. The frame
    // rate is the rational dwRate/dwScale, so composition time and duration live
    // in a timescale of dwRate: frame n at cts = n * dwScale, each frame lasting
    // dwScale ticks, giving presentation times of exactly n * dwScale / dwRate
    // seconds.
    const scale = table.frameRateDenominator;   // dwScale
    const rate = table.frameRateNumerator;       // dwRate
    const samples = table.frames.map((frame, frameIndex) => ({
      offset: frame.offset,
      size: frame.size,
      is_sync: frame.isSync,
      cts: frameIndex * scale,
      duration: scale,
      timescale: rate,
    }));

    // AVI carries no display rotation matrix, and there is no <video> element to
    // apply one anyway.
    this.rotation = 0;
    this.videoWidth = table.videoWidth;
    this.videoHeight = table.videoHeight;
    this.decoderConfig = {
      codec: table.decoderConfig.codec,
      codedWidth: table.decoderConfig.codedWidth,
      codedHeight: table.decoderConfig.codedHeight,
      optimizeForLatency: true,
    };
    // AVI's H.264 is configured in AVCC mode: the description is an `avcC` built
    // from the first keyframe's SPS/PPS, and the samples (Annex B in the file) are
    // converted to AVCC in the decode path. WebKit's WebCodecs claims to support
    // Annex-B-no-description and then fails the decode, so AVCC is the only path
    // that works on every engine (see src/avi.js and the decode-support-matrix
    // skill).
    if (table.decoderConfig.description !== undefined) {
      this.decoderConfig.description = table.decoderConfig.description;
    }
    this.samplesAreAnnexB = !!table.samplesAreAnnexB;

    this._buildTables(samples, null);
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

  // editWindow (optional): {start, end} in media units, the composition-time
  // range the edit list presents. Frames outside it stay in the DECODE table
  // (the decoder needs them to reconstruct the ones inside) but are left out of
  // the DISPLAY tables, so display frame 0 is the first frame the viewer sees.
  _buildTables(samples, editWindow) {
    const n = samples.length;
    this.timescale = n ? samples[0].timescale : 1;

    // Decode-order records (the first sample is always a keyframe). Always the
    // full set — a trimming edit list removes frames from the presentation, not
    // from what the decoder must run through to rebuild them.
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

    // Which decode indices the edit list actually presents. A frame counts if
    // its composition time falls in the window, with a quarter-frame tolerance
    // to absorb the movie-vs-media timescale rounding in the window's bounds. No
    // window (or a window that covers everything, e.g. an identity or shifting
    // edit list) leaves every frame presented, and this whole path collapses to
    // the untrimmed construction below.
    const presented = [];
    for (let k = 0; k < n; k++) {
      const s = this.samples[k];
      const slack = 0.25 * s.duration;
      if (!editWindow
          || (s.cts >= editWindow.start - slack && s.cts < editWindow.end - slack)) {
        presented.push(k);
      }
    }

    // Display order = presented samples sorted by composition time (B-frame
    // safe). Times are normalized so display frame 0 sits at t = 0: with a trim
    // the first presented frame's cts is a nonzero offset, and (independently)
    // with B-frames the first composition time is too — both engines want a
    // timeline whose origin is the first frame the viewer sees.
    const order = presented.slice().sort((a, b) => this.samples[a].cts - this.samples[b].cts);
    const p = order.length;
    this.trimmedByEditList = p < n;
    const cts0 = p ? this.samples[order[0]].cts : 0;
    this.presentationTimes = new Float64Array(p);
    this.frameDurations = new Float64Array(p);
    this.displayToDecode = new Int32Array(p);
    this.microsToDisplay = new Map();
    for (let d = 0; d < p; d++) {
      const k = order[d];
      const s = this.samples[k];
      this.presentationTimes[d] = (s.cts - cts0) / this.timescale;
      this.frameDurations[d] = s.duration / this.timescale;
      this.displayToDecode[d] = k;
      this.microsToDisplay.set(Math.round(s.cts * 1e6 / this.timescale), d);
    }
    this.numFrames = p;
    this.duration = p
      ? this.presentationTimes[p - 1] + this.frameDurations[p - 1] : 0;
  }
}

