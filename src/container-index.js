import { createRangeReader } from './range-readers.js';
import { deriveIndexCacheKey, loadCachedIndexPayload, storeCachedIndexPayload, serializeContainerIndex, hydrateContainerIndex } from './index-cache.js';
import { readMatroskaFrameTable, IndexBudgetExceededError } from './matroska.js';
import { readOggFrameTable } from './ogg.js';
import { readAviFrameTable } from './avi.js';
import { declaredFrameReorderDepth } from './frame-reorder-bound.js';
import { longestCertifiedRun, DeclaredReorderWatermark } from './certified-prefix.js';
import { MOTION_JPEG_CODEC } from './image-frame-decoder.js';

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
//   * WebM/Matroska goes through readMatroskaFrameTable, a sequential pass over the
//     whole file (Matroska keeps no central sample table) that reads every block's
//     header and skips its payload. It collects the presentation times AND the
//     frames' byte ranges and keyframe flags, so a Matroska index is a full one:
//     the <video> path gets its exact timestamps, and WebCodecs gets a sample table
//     plus a decoderConfig built from the track's CodecID/CodecPrivate — for H.264,
//     HEVC, VP8, VP9 and AV1. A codec we cannot configure leaves decoderConfig null
//     and the clip on the <video> tier, which is always available for Matroska.
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
// `supportsWebCodecs` is how the ladder in createBestEngine tells a decodable
// index (ISOBMFF, AVI, and Matroska with a codec we can configure) from a
// native-only one (Ogg, and Matroska carrying something more exotic).
//
// Anything else (HLS and other segmented delivery, raw elementary streams) still
// fails here, and the <video> element cannot play those either. That is the
// intended refusal, not a bug.
// ==================================================================

// A frame turned up whose display position sorts before one already published,
// which means the watermark that published it was not a watermark at all. Its
// own class because it is the one failure that cannot be softened into a
// truncated index: the frames already handed out are the wrong frames, not
// merely fewer of them. See ContainerIndex.load and _appendDisplayFrames.
export class CertifiedPrefixViolationError extends Error {
  constructor(message) { super(message); this.name = 'CertifiedPrefixViolationError'; }
}

// Which setup record an ISOBMFF codec string's reorder declaration lives in, and
// what it says. `avc3` and `hev1` keep their parameter sets in the frames rather
// than in the `stsd`, so their description is empty or absent and the answer is
// honestly "unknown" — the same as for a codec that declares nothing at all.
// A QuickTime/MP4 track whose samples are whole JPEG images. The sample entry
// is plain `jpeg`; Motion JPEG A and B (`mjpa`, `mjpb`) are deliberately absent,
// since those wrap their fields in extra framing rather than storing one JPEG
// per sample, and a JPEG decoder handed one would fail or decode half a picture.
// mp4box sorts a track into video, audio or metadata by recognizing its sample
// entry, and `jpeg` is not one it knows — so a Motion JPEG QuickTime file
// arrives with an empty videoTracks list and its video track filed under
// metadata. Nothing is missing from the file or from what mp4box parsed of it;
// only the classification is wrong. So rather than teach mp4box a sample entry,
// recognize this one case and supply the `video` shape a video track would have
// carried. Returns null for any file where that is not what is going on, which
// leaves the caller's "no video track" refusal exactly as it was.
function motionJpegTrack(file, info) {
  for (const track of (info.tracks || [])) {
    const trak = file.getTrackById(track.id);
    const entry = trak && trak.mdia && trak.mdia.minf.stbl.stsd.entries[0];
    if (!entry || !isobmffMotionJpegSampleEntry(entry.type)) continue;
    // The handler is the file's own statement that this track is visual, and it
    // is right even where mp4box's classification is not.
    if (trak.mdia.hdlr && trak.mdia.hdlr.handler !== 'vide') continue;
    const width = entry.width || track.track_width;
    const height = entry.height || track.track_height;
    if (!width || !height) continue;
    return {
      ...track,
      codec: entry.type,
      video: { width, height },
      matrix: track.matrix || (trak.tkhd && trak.tkhd.matrix),
    };
  }
  return null;
}

function isobmffMotionJpegSampleEntry(codec) {
  return codec === 'jpeg';
}

// ------------------------------------------------------------------
// MPEG-4 Part 2 (`mp4v`) — read the track, name the codec, decode nowhere.
//
// This is what OpenCV's VideoWriter writes by default (`VideoWriter_fourcc(*'mp4v')`),
// so it is what a great many lab pipelines have on disk, and until now the engine
// refused those files with "no video track in file" — which is both unhelpful and
// untrue.
//
// The situation is exactly motionJpegTrack's: mp4box.js registers a sample entry
// for avc1/avc3/hvc1/hev1/vp08/vp09/av01 and nothing else, so an `mp4v` entry is
// parsed as an opaque box, the track is filed under `metadata` rather than
// `video`, and info.videoTracks comes back empty. Nothing is missing from the
// file — the sample table (byte ranges, sync flags, per-frame times) is parsed
// exactly as it would be for H.264 — only the classification and the sample
// entry's own fields are. So, as there, recognize the one case and supply the
// `video` shape a video track would have carried.
//
// What this does NOT do is make the clip decodable. No Blink or Gecko build ships
// an MPEG-4 Part 2 decoder in either WebCodecs or the <video> element, so on
// Chrome and Firefox this turns "we could not read the container" into an honest
// "the container is fine, the codec is undecodable here" — which is the error
// message the host actually needs, and the reason to do this even where it cannot
// end in playback. WebKit's <video> element decodes MPEG-4 Part 2 through
// AVFoundation, so on Safari the clip plays, and this index is what makes it
// frame-exact there.
const MPEG4_VISUAL_OBJECT_TYPE_INDICATION = 0x20;
const ELEMENTARY_STREAM_DESCRIPTOR_TAG = 0x03;
const DECODER_CONFIG_DESCRIPTOR_TAG = 0x04;
const DECODER_SPECIFIC_INFO_TAG = 0x05;
// The start code that opens a VisualObjectSequence header, whose next byte is the
// profile_and_level_indication an `mp4v.20.<n>` codec string names.
const VISUAL_OBJECT_SEQUENCE_START_CODE = [0x00, 0x00, 0x01, 0xb0];

// One MPEG-4 systems descriptor: a tag byte, then a length spread over one to
// four bytes with a continuation bit set on all but the last.
function readMpeg4Descriptor(bytes, offset) {
  const tag = bytes[offset];
  let cursor = offset + 1;
  let length = 0;
  for (let i = 0; i < 4 && cursor < bytes.length; i++) {
    const byte = bytes[cursor];
    cursor += 1;
    length = (length << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return { tag, bodyOffset: cursor, end: cursor + length };
}

// The `esds` box body (past its version and flags) down to the two things a
// decoder configuration wants: which codec this elementary stream carries, and
// its out-of-band setup bytes. Returns null if the descriptor tree is not the
// shape the specification requires, which is the same answer as "not ours".
function readElementaryStreamDescriptor(esdsBody) {
  if (esdsBody.length < 5) return null;
  const bytes = esdsBody.subarray(4);   // past version + flags
  const elementaryStream = readMpeg4Descriptor(bytes, 0);
  if (elementaryStream.tag !== ELEMENTARY_STREAM_DESCRIPTOR_TAG) return null;

  // ES_ID (2 bytes) then a flags byte, whose top three bits each add an optional
  // field before the descriptors we are after. libavformat sets none of them, but
  // reading them properly costs six lines and is the difference between working
  // for every muxer and working for the one that wrote the file in front of us.
  let cursor = elementaryStream.bodyOffset + 2;
  const flags = bytes[cursor];
  cursor += 1;
  if (flags & 0x80) cursor += 2;                  // depends on another stream
  if (flags & 0x40) cursor += 1 + bytes[cursor];  // a URL, length-prefixed
  if (flags & 0x20) cursor += 2;                  // an object clock reference

  while (cursor < elementaryStream.end && cursor < bytes.length) {
    const descriptor = readMpeg4Descriptor(bytes, cursor);
    if (descriptor.tag !== DECODER_CONFIG_DESCRIPTOR_TAG) {
      cursor = descriptor.end;
      continue;
    }
    const objectTypeIndication = bytes[descriptor.bodyOffset];
    // Past the object type indication (1), the stream type and buffer size (4),
    // and the maximum and average bit rates (8) lie the nested descriptors.
    let inner = descriptor.bodyOffset + 13;
    let decoderSpecificInfo = null;
    while (inner < descriptor.end && inner < bytes.length) {
      const nested = readMpeg4Descriptor(bytes, inner);
      if (nested.tag === DECODER_SPECIFIC_INFO_TAG) {
        decoderSpecificInfo = bytes.subarray(nested.bodyOffset,
          Math.min(nested.end, bytes.length));
      }
      inner = nested.end;
    }
    return { objectTypeIndication, decoderSpecificInfo };
  }
  return null;
}

// Walk the child boxes appended to a sample entry, looking for one type.
function findSampleEntryChildBox(sampleEntryBytes, startOffset, wantedType) {
  const view = new DataView(sampleEntryBytes.buffer,
    sampleEntryBytes.byteOffset, sampleEntryBytes.byteLength);
  let offset = startOffset;
  while (offset + 8 <= sampleEntryBytes.length) {
    const size = view.getUint32(offset);
    if (size < 8 || offset + size > sampleEntryBytes.length) return null;
    const type = String.fromCharCode(
      sampleEntryBytes[offset + 4], sampleEntryBytes[offset + 5],
      sampleEntryBytes[offset + 6], sampleEntryBytes[offset + 7]);
    if (type === wantedType) {
      return sampleEntryBytes.subarray(offset + 8, offset + size);
    }
    offset += size;
  }
  return null;
}

// A VisualSampleEntry's fixed fields, given the box body mp4box hands back with
// the eight-byte box header and the six reserved bytes plus data_reference_index
// already consumed (its `hdr_size`). What remains starts with 16 bytes of
// pre_defined and reserved, then the coded dimensions; the child boxes that carry
// the real codec configuration begin 70 bytes in, past the resolutions, the frame
// count, the 32-byte compressor name and the depth.
const VISUAL_SAMPLE_ENTRY_CHILD_BOXES_OFFSET = 70;

// Everything an `mp4v` sample entry states, or null if these bytes are not an
// MPEG-4 Part 2 one. Exported for test/mp4v-sample-entry-test.mjs, which pins the
// parsing against real muxer output without needing mp4box or a browser.
export function readMpeg4VisualSampleEntry(sampleEntryBytes) {
  if (!sampleEntryBytes
      || sampleEntryBytes.length < VISUAL_SAMPLE_ENTRY_CHILD_BOXES_OFFSET) return null;
  const view = new DataView(sampleEntryBytes.buffer,
    sampleEntryBytes.byteOffset, sampleEntryBytes.byteLength);
  const esdsBody = findSampleEntryChildBox(sampleEntryBytes,
    VISUAL_SAMPLE_ENTRY_CHILD_BOXES_OFFSET, 'esds');
  if (!esdsBody) return null;
  const descriptor = readElementaryStreamDescriptor(esdsBody);
  // An `mp4v` sample entry is the generic MPEG-4 elementary stream box: the
  // object type indication inside it, not the four-character code, is what says
  // the stream is MPEG-4 Part 2 video rather than something else entirely.
  if (!descriptor
      || descriptor.objectTypeIndication !== MPEG4_VISUAL_OBJECT_TYPE_INDICATION) return null;

  const decoderSpecificInfo = descriptor.decoderSpecificInfo;
  // The profile and level, where the setup bytes open with the sequence header
  // that declares them. A stream that keeps its headers in-band carries no
  // DecoderSpecificInfo at all, and then the codec string honestly stops short
  // rather than inventing a level.
  const declaresSequenceHeader = decoderSpecificInfo
    && decoderSpecificInfo.length > VISUAL_OBJECT_SEQUENCE_START_CODE.length
    && VISUAL_OBJECT_SEQUENCE_START_CODE.every(
      (byte, i) => decoderSpecificInfo[i] === byte);
  const profileLevel = declaresSequenceHeader
    ? decoderSpecificInfo[VISUAL_OBJECT_SEQUENCE_START_CODE.length] : null;

  return {
    width: view.getUint16(16),
    height: view.getUint16(18),
    // RFC 6381's form: the four-character code, the object type indication in
    // hexadecimal, and the profile_and_level_indication in decimal. OpenCV's
    // default output is Simple Profile Level 1, so `mp4v.20.1`.
    codec: profileLevel === null ? 'mp4v.20' : `mp4v.20.${profileLevel}`,
    decoderSpecificInfo: decoderSpecificInfo || undefined,
  };
}

// The `video` track shape for an MPEG-4 Part 2 track mp4box filed as metadata,
// or null for any file where that is not what is going on — which leaves the
// caller's "no video track" refusal exactly as it was.
function mpeg4VisualTrack(file, info) {
  for (const track of (info.tracks || [])) {
    const trak = file.getTrackById(track.id);
    const entry = trak && trak.mdia && trak.mdia.minf.stbl.stsd.entries[0];
    if (!entry || entry.type !== 'mp4v' || !entry.data) continue;
    // The handler is the file's own statement that this track is visual, and it
    // is right even where mp4box's classification is not.
    if (trak.mdia.hdlr && trak.mdia.hdlr.handler !== 'vide') continue;
    const sampleEntry = readMpeg4VisualSampleEntry(entry.data);
    if (!sampleEntry) continue;
    const width = sampleEntry.width || track.track_width;
    const height = sampleEntry.height || track.track_height;
    if (!width || !height) continue;
    return {
      ...track,
      codec: sampleEntry.codec,
      video: { width, height },
      matrix: track.matrix || (trak.tkhd && trak.tkhd.matrix),
      // Carried here rather than re-read in _codecDescription: the sample entry
      // is one mp4box did not parse, so the bytes come from this walk or from a
      // second identical one.
      decoderSpecificInfo: sampleEntry.decoderSpecificInfo,
    };
  }
  return null;
}
// ------------------------------------------------------------------

function isobmffReorderDepth(codec, description) {
  if (/^avc[13]/.test(codec)) return declaredFrameReorderDepth('avcC', description);
  if (/^(hvc1|hev1)/.test(codec)) return declaredFrameReorderDepth('hvcC', description);
  return null;
}

// Codecs with no presentation reordering, by WebCodecs codec string: their
// frames are stored in the order they are shown. This is a property of the
// codecs — VP8 has no B-frames at all, and VP9's altref frames are hidden inside
// superframes rather than reordered for display — not a habit of muxers, which
// is why a frame can be settled the moment the next one is read. (AV1 reorders,
// and its sequence header declares no bound we can read.)
function isobmffCodecHasNoPresentationReordering(codec) {
  return /^(vp08|vp8|vp09)/.test(codec);
}

export class ContainerIndex extends EventTarget {
  constructor(reader) {
    super();
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

    // ----------------------------------------------------------------
    // Growth. An index that comes out of a full-file pass can be published in
    // certified prefixes while the pass is still running, so a host can name and
    // show the opening frames of a two-hour WebM without waiting for its last
    // byte (see the certified-prefix note above _appendDisplayFrames).
    //
    // 'growing'   more frames are still coming
    // 'complete'  the whole container has been read; this table is final
    // 'truncated' the pass stopped early (a budget, a corrupt tail, an ordering
    //             violation). What is here is final; nothing more is coming.
    //
    // A one-shot build is 'complete' from the moment it is handed back, so a host
    // that never opts into growth sees exactly what it always did.
    // ----------------------------------------------------------------
    this.completionState = 'complete';
    this.completionError = null;
    // The presentation time (seconds, on the normalized display timeline) through
    // which this index is certified. Equal to `duration` — named separately
    // because that is the question a host asks of a growing index.
    this.indexedThroughSeconds = 0;
    // The container's DECLARED total duration in seconds, where it states one
    // (Matroska's Info/Duration), so a scrubber can size itself before the pass
    // finishes rather than grow a track under the user's cursor. 0 when the
    // container states none. NEVER used for frame mapping — a declared duration
    // is a claim, and only the scanned table names frames.
    this.expectedDuration = 0;

    // Backing buffers for the display tables, grown by doubling. The public
    // presentationTimes / frameDurations / displayToDecode are subarray VIEWS
    // onto these, so `.length` is always the certified frame count and every
    // existing reader of them (frameAtTime, midpointOfFrame, both engines) works
    // unchanged against a table that is still growing.
    this._presentationTimesBuffer = null;
    this._frameDurationsBuffer = null;
    this._displayToDecodeBuffer = null;
    this._displayCount = 0;
    // The composition time display frame 0 sits at, frozen at the first publish
    // so that t = 0 means one thing for the life of the index.
    this._compositionTimeOrigin = 0;
    this._editWindow = null;
  }

  // Has this index what a VideoDecoder needs — the byte ranges of every sample,
  // and the codec's configuration? True for ISOBMFF, AVI, and Matroska whose
  // codec we could configure; false for Ogg (timestamps only) and for a Matroska
  // track whose codec we could not, both of which can still make the <video>
  // element frame-exact.
  get supportsWebCodecs() { return !!(this.samples && this.decoderConfig); }

  // options.timeoutMilliseconds / options.maxBytes / options.onProgress /
  // options.chunkBytes bound and report the full-file passes (WebM, Ogg, and a
  // FRAGMENTED MP4 — see readMatroskaFrameTable / readOggFrameTable /
  // _demuxIsobmff). They are inert for a classic single-`moov` MP4, which is a
  // handful of range reads however long the clip is.
  // options.publishPartialIndex makes a full-file pass publish each certified
  // prefix as it goes (Matroska only so far), and options.onIndexCreated hands
  // the index over the moment it exists — before a byte has been parsed — so a
  // caller can subscribe to 'extended' / 'complete' / 'truncated' and use the
  // opening frames while the rest of the file is still going past. Without
  // publishPartialIndex the index is handed back finished, exactly as before.
  static async load(reader, options = {}) {
    const index = new ContainerIndex(reader);
    if (typeof options.onIndexCreated === 'function') options.onIndexCreated(index);
    try {
      if (await ContainerIndex._isMatroska(reader)) await index._demuxMatroska(reader, options);
      else if (await ContainerIndex._isOgg(reader)) await index._demuxOgg(reader, options);
      else if (await ContainerIndex._isAvi(reader)) await index._demuxAvi(reader, options);
      else await index._demuxIsobmff(reader, options);
    } catch (err) {
      // One failure is not survivable, and it is the one that says so: a frame
      // turning up before one already published means the watermark that let
      // that frame out was wrong, so the numbers already handed over are wrong
      // too. Keeping them as a truncated index would hand the host exactly the
      // frame numbers this error exists to say cannot be trusted, so it goes
      // straight out and the clip is refused.
      if (err instanceof CertifiedPrefixViolationError) throw err;
      // Everything else is a pass that stopped early rather than one that lied.
      // A pass that had already published a certified prefix keeps it. Those
      // frames were certified BEFORE they went out — the guarantee is that every
      // frame number reported is exact and permanent, not that every clip can be
      // read to the end — so a budget running out or a corrupt tail takes away
      // only the frames we never got to. A build that had published nothing has
      // nothing to stand on and throws, exactly as it always did.
      if (index.completionState === 'growing' && index.numFrames > 0) {
        index._truncateTables(err);
        return index;
      }
      throw err;
    }
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
    // A truncated index is the frames we managed to read before the pass died,
    // which is a property of that attempt and not of the clip. Caching it would
    // make a network hiccup permanent: every later open of the same file would
    // get the short table back without even trying to read the rest.
    if (cacheKey && index.completionState === 'complete'
        && buildMilliseconds >= minimumBuildMilliseconds) {
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
    // 256 KB by default: big enough that a moov at the front of the file arrives
    // in one read. options.chunkBytes overrides it, which is how a test forces a
    // small fixture to be discovered a little at a time instead of whole in the
    // first read — the shape a real file of any size has anyway.
    const readyChunk = options.chunkBytes || (1 << 18);
    let offset = 0;
    while (info === null && demuxError === null && offset < reader.size) {
      const end = Math.min(offset + readyChunk, reader.size) - 1;
      const buffer = await reader.read(offset, end);
      if (!buffer.byteLength) break;
      buffer.fileStart = offset;
      offset = file.appendBuffer(buffer);
    }
    if (demuxError) throw demuxError;
    if (!info) { file.flush(); throw new Error('no moov found (not a valid MP4?)'); }

    const videoTrack = (info.videoTracks && info.videoTracks[0])
      || motionJpegTrack(file, info)
      || mpeg4VisualTrack(file, info);
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

    // Everything that decides what a frame NUMBER means — the codec, the display
    // geometry, the timescale, the edit window — is in the `moov`, which phase 1
    // has already read. Settling it HERE rather than after the fragment pass is
    // what lets that pass publish frames while it is still running: an index
    // cannot hand out a frame before it knows its own geometry.
    this.decoderConfig = {
      codec: isobmffMotionJpegSampleEntry(videoTrack.codec)
        ? MOTION_JPEG_CODEC : videoTrack.codec,
      codedWidth: videoTrack.video.width,
      codedHeight: videoTrack.video.height,
      // A rescued MPEG-4 Part 2 track brings its own setup bytes (mp4box parsed
      // no sample entry to read them back out of); everything else reads its
      // avcC/hvcC/vpcC/av1C out of the stsd.
      description: videoTrack.decoderSpecificInfo
        || this._codecDescription(file, videoTrack.id),
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
    this.containerFormat = 'isobmff';
    const editWindow = this._editListWindow(videoTrack);

    if (isFragmented) {
      // A fragmented file is the only ISOBMFF shape whose samples arrive over
      // the length of the file, so it is the only one that can publish early.
      const publisher = options.publishPartialIndex
        ? this._fragmentedPublisher(file, videoTrack, editWindow) : null;
      await this._demuxFragmentedIsobmff(reader, file, videoTrack, options,
        () => demuxError, offset, publisher);
      file.flush();
      if (demuxError) throw demuxError;
      if (publisher) { publisher.finish(); return; }
    } else {
      file.flush();
      if (demuxError) throw demuxError;
    }

    this._buildTables(file.getTrackSamplesInfo(videoTrack.id), editWindow);
  }

  // Publishing a fragmented MP4's frames while the pass that finds them is still
  // going, on the same terms the Matroska scan publishes on: a frame is handed
  // out only once nothing still to be read can present before it (see
  // longestCertifiedRun for the shape of the argument, and the certified-prefix
  // invariant in _appendDisplayFrames for what enforces it).
  //
  // What differs is the proof. Matroska has the signed-16-bit block offset to
  // fall back on; an unread `moof` is bounded by nothing at all, so a fragmented
  // file publishes early only where the stream itself says how far it reorders:
  //
  //   * H.264 and HEVC declare it in the sequence parameter set sitting in the
  //     `stsd` we have already parsed (see src/frame-reorder-bound.js). This is
  //     nearly every fragmented MP4 in existence — it is what CMAF packagers and
  //     MediaRecorder write.
  //   * VP8 and VP9 do not reorder at all, so decode order IS presentation order
  //     and a frame settles the moment the next one is read.
  //   * Anything else (AV1, or an `avc3`/`hev1` track carrying its parameter sets
  //     in-band rather than in the `stsd`) publishes nothing early and indexes in
  //     one pass, which is the correct conservative answer rather than a failure.
  //
  // Unlike Matroska, no frame is ever held back for its duration: an ISOBMFF
  // sample carries its own, so a certified frame is immediately complete.
  _fragmentedPublisher(file, videoTrack, editWindow) {
    const declared = new DeclaredReorderWatermark(
      isobmffReorderDepth(videoTrack.codec, this.decoderConfig.description));
    const decodeOrderIsDisplayOrder = isobmffCodecHasNoPresentationReordering(videoTrack.codec);

    let observedCount = 0;      // samples fed to the watermark
    let publishedCount = 0;     // samples appended to the tables
    let certifiedWatermark = -Infinity;
    let samplesAreInPresentationOrder = true;
    let lastCompositionTime = -Infinity;

    // The timescale and edit window are fixed for the life of the index, and both
    // are known now, so the table can be opened before a fragment is read.
    this._beginTables(videoTrack.timescale, editWindow);

    const observe = (samples) => {
      for (; observedCount < samples.length; observedCount++) {
        const compositionTime = samples[observedCount].cts;
        if (compositionTime < lastCompositionTime) samplesAreInPresentationOrder = false;
        lastCompositionTime = compositionTime;
        declared.observe(compositionTime);
      }
    };

    const append = (samples, end) => {
      const decodeIndices = this._appendSamples(samples.slice(publishedCount, end));
      this._appendDisplayFrames(this._presentedInDisplayOrder(decodeIndices));
      publishedCount = end;
    };

    return {
      // Called after each chunk of the file has gone through mp4box.
      certify: () => {
        const samples = file.getTrackSamplesInfo(videoTrack.id);
        observe(samples);
        const watermark = Math.max(
          (decodeOrderIsDisplayOrder && samplesAreInPresentationOrder)
            ? lastCompositionTime : -Infinity,
          declared.watermark);
        const run = longestCertifiedRun((index) => samples[index].cts,
          samples.length, publishedCount, watermark, certifiedWatermark);
        if (!run) return;
        append(samples, run.end);
        certifiedWatermark = run.watermark;
        this._publish();
      },
      // The pass reached the end of the file: whatever the certified runs did not
      // cover is settled now by there being nothing left to read.
      finish: () => {
        const samples = file.getTrackSamplesInfo(videoTrack.id);
        append(samples, samples.length);
        this._finishTables();
      },
    };
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
  // publisher, when the caller asked for a growing index, is given each chunk's
  // worth of newly parsed samples to certify and publish (see _fragmentedPublisher).
  async _demuxFragmentedIsobmff(
    reader, file, videoTrack, options, getDemuxError, startOffset, publisher
  ) {
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
      // Whatever that chunk's fragments settled can go out now rather than at
      // the end of the file.
      if (publisher) publisher.certify();
    }
    report(reader.size);   // a final 100% tick, so the host can settle the bar
  }

  // Ogg/Theora: the timestamps and nothing else (see readOggFrameTable) — the one
  // container here that still indexes to a timestamps-only table. samples,
  // keyframeDecodeIndices and decoderConfig stay null, so supportsWebCodecs
  // reports false and the clip plays only through the native <video> element
  // (Firefox). No browser's WebCodecs decodes Theora, so there would be nothing
  // to feed a sample table to.
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

  // WebM/Matroska: a full decode-order sample table, and a decoderConfig
  // whenever the track's codec is one we can configure honestly (H.264, HEVC,
  // VP8, VP9, AV1 — see buildMatroskaDecoderConfig). The scan that reads the
  // timestamps walks past every block header anyway, and a block header is where
  // the frame's byte range and keyframe flag are, so the decode table costs
  // almost nothing on top of the table that makes the <video> element exact.
  //
  // Where this differs from AVI: a Matroska track whose codec we cannot
  // configure still yields a perfectly good index, because Matroska HAS a native
  // tier. decoderConfig stays null, supportsWebCodecs reports false, and the clip
  // plays frame-exact through the <video> element exactly as it did before.
  // Matroska stores no per-frame duration: a frame lasts until the next one
  // starts. So a frame's duration is only final once the frame that shows after
  // it has been read — which is the whole reason this path builds its table in
  // runs rather than in one pass, and why one frame is always held back.
  //
  // With options.publishPartialIndex the same runs are published as they are
  // certified (see readMatroskaFrameTable's onFramesCertified) instead of only at
  // the end. The two orders of arrival go through the identical code below, which
  // is what makes a progressively built index the same table as a one-shot build
  // of the same file rather than merely a similar one.
  async _demuxMatroska(reader, options) {
    // Decode indices read but not yet placed on the display timeline: after each
    // run this holds exactly the frame that shows last, whose duration the next
    // run settles. At the end of the file it is the clip's final frame.
    let heldBack = [];
    let defaultFrameDurationTicks = 0;
    let lastSettledDurationTicks = 0;
    let started = false;

    const begin = (track) => {
      if (started) return;
      started = true;
      this.containerFormat = 'matroska';
      this.videoWidth = track.videoWidth;
      this.videoHeight = track.videoHeight;
      // Matroska carries no display rotation matrix (the element applies none
      // either, so the two agree).
      this.rotation = 0;
      this.decoderConfig = track.decoderConfig;
      // Matroska stores H.264 and HEVC the way an MP4 does — length-prefixed, with
      // the parameter sets out of band in CodecPrivate — so unlike AVI there is
      // nothing to convert before the decoder.
      this.samplesAreAnnexB = false;
      this.expectedDuration = track.declaredDuration || 0;
      defaultFrameDurationTicks = track.defaultFrameDuration * track.timescale;
      this._beginTables(track.timescale, null);
    };

    // Take a run of decode-order frames whose display positions are settled,
    // append them to the decode table, and extend the display timeline by every
    // one of them whose duration is now known.
    const extend = (frames) => {
      const decodeIndices = this._appendSamples(frames.map((frame) => ({
        offset: frame.offset,
        size: frame.size,
        is_sync: frame.isSync,
        cts: frame.ticks,
        duration: 0,   // settled below, once the frame that follows it is known
      })));
      const displayOrder = heldBack.concat(decodeIndices)
        .sort((a, b) => this.samples[a].cts - this.samples[b].cts);
      const settled = displayOrder.slice(0, -1);
      for (let d = 0; d < settled.length; d++) {
        lastSettledDurationTicks =
          this.samples[displayOrder[d + 1]].cts - this.samples[settled[d]].cts;
        this.samples[settled[d]].duration = lastSettledDurationTicks;
      }
      heldBack = displayOrder.slice(settled.length);
      this._appendDisplayFrames(settled);
    };

    // The clip's last frame has no next one to measure against: fall back to the
    // track's declared DefaultDuration, then to the frame before it, then to a
    // nominal 30fps.
    const placeFinalFrame = () => {
      for (const k of heldBack) {
        this.samples[k].duration = defaultFrameDurationTicks
          || lastSettledDurationTicks || (this.timescale / 30);
        this._appendDisplayFrames([k]);
      }
      heldBack = [];
    };

    const table = await readMatroskaFrameTable(reader, {
      ...options,
      onFramesCertified: options.publishPartialIndex
        ? (frames, watermarkTicks, track) => {
          begin(track);
          extend(frames);
          this._publish();
        }
        : undefined,
    });

    // Whatever the certified runs did not cover — everything, for a one-shot
    // build; the tail after the last certified run, for a progressive one.
    begin({
      decoderConfig: table.decoderConfig,
      timescale: table.timescale,
      defaultFrameDuration: table.defaultFrameDuration,
      declaredDuration: table.declaredDuration,
      videoWidth: table.videoWidth,
      videoHeight: table.videoHeight,
    });
    extend(table.frames.slice(table.certifiedFrameCount));
    placeFinalFrame();
    this._finishTables();
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
        `this AVI's video codec (${JSON.stringify(table.fourCc)}) is not one this `
        + 'browser can decode, and AVI has no native <video> fallback, so the clip '
        + 'is refused. (H.264 and Motion JPEG are the AVI codecs supported; '
        + 'uncompressed BI_RGB is intentionally out of scope.)');
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
    // that works on every engine (see src/avi.js and the video-format-support-per-browser
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
  //
  // The whole-table build every container but a progressive Matroska pass uses:
  // begin, append everything, finish. It is the same three calls the progressive
  // path makes, just once instead of many, which is what makes a progressively
  // built index provably identical to the one-shot build of the same file.
  _buildTables(samples, editWindow) {
    this._beginTables(samples.length ? samples[0].timescale : 1, editWindow);
    const decodeIndices = this._appendSamples(samples);
    this._appendDisplayFrames(this._presentedInDisplayOrder(decodeIndices));
    this._finishTables();
  }

  // Start an empty table. timescale and the edit window are fixed for the life of
  // the index: both decide what a frame NUMBER means, so neither may be revised
  // once a single frame has been published under them.
  _beginTables(timescale, editWindow) {
    this.completionState = 'growing';
    this.timescale = timescale || 1;
    this._editWindow = editWindow || null;
    this.samples = [];
    this.keyframeDecodeIndices = [];
    this.microsToDisplay = new Map();
    this._presentationTimesBuffer = null;
    this._frameDurationsBuffer = null;
    this._displayToDecodeBuffer = null;
    this._displayCount = 0;
    this._compositionTimeOrigin = 0;
    this._refreshDisplayViews();
  }

  // Append decode-order sample records, returning the decode indices they landed
  // at. Decode order is scan order and is never revised, so this is a pure
  // append — a frame's decode index, once assigned, is permanent.
  _appendSamples(samples) {
    const base = this.samples.length;
    const decodeIndices = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const k = base + i;
      const isSync = !!s.is_sync || k === 0;
      if (isSync) this.keyframeDecodeIndices.push(k);   // ascending == decode order
      this.samples.push({
        offset: s.offset, size: s.size, isSync, cts: s.cts, duration: s.duration,
      });
      decodeIndices.push(k);
    }
    return decodeIndices;
  }

  // Which of these decode indices the edit list actually presents, in display
  // order. A frame counts if its composition time falls in the window, with a
  // quarter-frame tolerance to absorb the movie-vs-media timescale rounding in
  // the window's bounds. No window (or one that covers everything, e.g. an
  // identity or shifting edit list) presents every frame.
  _presentedInDisplayOrder(decodeIndices) {
    const window = this._editWindow;
    const presented = window ? decodeIndices.filter((k) => {
      const s = this.samples[k];
      const slack = 0.25 * s.duration;
      return s.cts >= window.start - slack && s.cts < window.end - slack;
    }) : decodeIndices.slice();
    // Display order is composition-time order (B-frame safe) — the same sort the
    // one-shot build has always done, here over one batch at a time.
    return presented.sort((a, b) => this.samples[a].cts - this.samples[b].cts);
  }

  // Extend the display timeline by a batch of decode indices already sorted into
  // composition-time order, each carrying its FINAL duration.
  //
  // THE CERTIFIED-PREFIX INVARIANT. Display indices are append-only and
  // immutable: display frame 412 must mean the same picture for the life of the
  // index, because a host may already have written an annotation against it. A
  // batch may therefore only be appended when no frame still to be scanned can
  // present before its last frame — which is what each container's certified
  // watermark establishes. Here we enforce the consequence of that rather than
  // trust it: a batch whose first frame does not sort after the last frame
  // already published means the watermark that produced it was wrong, and the
  // numbers already handed out are wrong with it. That is not recoverable, so it
  // throws rather than quietly repairing anything.
  _appendDisplayFrames(decodeIndices) {
    if (!decodeIndices.length) return;
    const first = this.samples[decodeIndices[0]];
    if (this._displayCount === 0) {
      // Display frame 0 sits at t = 0. With a trim the first presented frame's
      // cts is a nonzero offset, and (independently) with B-frames the first
      // composition time is too; both engines want a timeline whose origin is the
      // first frame the viewer sees. Frozen here, for good.
      this._compositionTimeOrigin = first.cts;
    } else {
      const lastPublished = this.samples[this._displayToDecodeBuffer[this._displayCount - 1]];
      if (first.cts < lastPublished.cts) {
        throw new CertifiedPrefixViolationError(
          `container index: a frame at composition time ${first.cts} was scanned `
          + `after display frame ${this._displayCount - 1} at ${lastPublished.cts} `
          + 'had already been published, so the certified prefix was not certified '
          + 'and every frame number reported for this clip is unreliable');
      }
    }

    this._ensureDisplayCapacity(this._displayCount + decodeIndices.length);
    for (const k of decodeIndices) {
      const s = this.samples[k];
      const d = this._displayCount;
      this._presentationTimesBuffer[d] = (s.cts - this._compositionTimeOrigin) / this.timescale;
      this._frameDurationsBuffer[d] = s.duration / this.timescale;
      this._displayToDecodeBuffer[d] = k;
      this.microsToDisplay.set(Math.round(s.cts * 1e6 / this.timescale), d);
      this._displayCount = d + 1;
    }
  }

  // Grow the display buffers to hold at least `needed` frames, by doubling. Nine
  // reallocations carry a two-hour 60fps clip, and each is a memcpy of a few
  // megabytes — as against re-deriving the whole table on every publish, which
  // would hold two full sample arrays live at once.
  _ensureDisplayCapacity(needed) {
    const capacity = this._presentationTimesBuffer ? this._presentationTimesBuffer.length : 0;
    if (capacity >= needed) return;
    let grown = capacity || 64;
    while (grown < needed) grown *= 2;
    const times = new Float64Array(grown);
    const durations = new Float64Array(grown);
    const toDecode = new Int32Array(grown);
    if (this._presentationTimesBuffer) {
      times.set(this._presentationTimesBuffer);
      durations.set(this._frameDurationsBuffer);
      toDecode.set(this._displayToDecodeBuffer);
    }
    this._presentationTimesBuffer = times;
    this._frameDurationsBuffer = durations;
    this._displayToDecodeBuffer = toDecode;
  }

  // Point the public tables at the certified prefix of the backing buffers.
  _refreshDisplayViews() {
    const count = this._displayCount;
    this.presentationTimes = this._presentationTimesBuffer
      ? this._presentationTimesBuffer.subarray(0, count) : new Float64Array(0);
    this.frameDurations = this._frameDurationsBuffer
      ? this._frameDurationsBuffer.subarray(0, count) : new Float64Array(0);
    this.displayToDecode = this._displayToDecodeBuffer
      ? this._displayToDecodeBuffer.subarray(0, count) : new Int32Array(0);
  }

  // Make the frames appended since the last publish visible, and say so.
  //
  // Deliberately synchronous from first statement to last: a listener runs inside
  // dispatchEvent, so an engine that re-reads the tables here cannot observe them
  // half-grown. Nothing in this method may await.
  _publish() {
    this._refreshDisplayViews();
    const count = this._displayCount;
    this.numFrames = count;
    this.duration = count
      ? this.presentationTimes[count - 1] + this.frameDurations[count - 1] : 0;
    this.indexedThroughSeconds = this.duration;
    this.dispatchEvent(new Event('extended'));
  }

  // Seal the table: compact the buffers down to the frames actually in them and
  // publish the final state.
  //
  // The compaction is not cosmetic. serializeContainerIndex stores these arrays
  // as they are, and structured-cloning a subarray VIEW clones the whole backing
  // buffer behind it — so an index cached without this would carry its unused
  // capacity into IndexedDB.
  _finishTables() {
    this._sealTables();
    this.completionState = 'complete';
    this.dispatchEvent(new Event('extended'));
    this.dispatchEvent(new Event('complete'));
  }

  // The pass stopped before the end of the container. Everything published stays
  // exactly as published — those frames were certified before they were handed
  // out — but nothing more is coming.
  _truncateTables(error) {
    if (this.completionState !== 'growing') return;
    this._sealTables();
    this.completionState = 'truncated';
    this.completionError = error || null;
    this.dispatchEvent(new Event('extended'));
    this.dispatchEvent(new Event('truncated'));
  }

  // Compact the display buffers down to the frames actually in them and settle
  // the derived totals. Shared by both ways a pass can end.
  _sealTables() {
    const count = this._displayCount;
    this.presentationTimes = this._presentationTimesBuffer
      ? this._presentationTimesBuffer.slice(0, count) : new Float64Array(0);
    this.frameDurations = this._frameDurationsBuffer
      ? this._frameDurationsBuffer.slice(0, count) : new Float64Array(0);
    this.displayToDecode = this._displayToDecodeBuffer
      ? this._displayToDecodeBuffer.slice(0, count) : new Int32Array(0);
    this._presentationTimesBuffer = this.presentationTimes;
    this._frameDurationsBuffer = this.frameDurations;
    this._displayToDecodeBuffer = this.displayToDecode;
    // A trimming edit list is the only thing that leaves the decode table longer
    // than the display one once the pass has finished.
    this.trimmedByEditList = count < this.samples.length;
    this.numFrames = count;
    this.duration = count
      ? this.presentationTimes[count - 1] + this.frameDurations[count - 1] : 0;
    this.indexedThroughSeconds = this.duration;
  }
}

