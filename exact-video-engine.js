// GENERATED FILE. Do not edit directly: the source lives in src/, and
// `node build.mjs` writes this file from it. The build only removes the
// module import/export syntax, so every other line here IS the source.
// ==================================================================
// exact-video-engine.js — frame-perfect video playback for the browser.
// https://github.com/jasper-tms/exact-video-engine.js
//
// Why this exists: a native <video> playing via play() stochastically drops a
// frame near the start (Chrome's compositor swallows ~one inter-frame interval
// as the media clock spins up) and its currentTime->frame mapping drifts on
// non-integer / variable-frame-rate clips.
//
// Two engines, one surface. Both expose the same members (play/pause,
// currentFrame, currentFrameFloat, seekToFrame, ...) so a host can hold either
// one in the same variable and never branch on which it got:
//
//   VideoEngine        demuxes the container with mp4box.js, decodes every
//                      frame itself with a WebCodecs VideoDecoder, and presents
//                      onto a canvas on a clock it owns. Nothing is handed to a
//                      compositor, so no startup frame is dropped, and because
//                      the host reads the playhead from the same object that
//                      paints the pixels, a synchronized overlay cannot drift.
//                      It is authoritative: we DECIDE which frame is on screen.
//
//   NativeVideoEngine  plays through a real <video> element (hardware overlay,
//                      battery-friendly, plays containers and codecs WebCodecs
//                      cannot, and is the only path with audio). It is
//                      observational: we can only LEARN which frame the browser
//                      chose to present, which it reports through
//                      requestVideoFrameCallback.
//
// The integer frame index is the source of truth in both. What separates them
// is not the timestamps — requestVideoFrameCallback's `mediaTime` IS the
// presented frame's exact presentation timestamp — but the mapping from a
// timestamp to a frame *index*, which needs the table of every frame's PTS. A
// <video> element never exposes that table, so we read it out of the container
// ourselves, without decoding a single frame: from the moov for MP4 (mp4box),
// the moof fragments for fragmented MP4, the clusters for WebM, and the pages
// for Ogg. Either way the same table goes to whichever engine ends up playing
// (see ContainerIndex), and a full-file pass worth caching lands in IndexedDB
// so it is paid once per clip (see index-cache). That is what makes the
// <video> path frame-exact on variable-frame-rate clips rather than merely
// close.
//
// createBestEngine() picks the best available combination for a given clip and
// browser, choosing between two exact tiers and otherwise refusing:
//
//   1. container index + WebCodecs   exact index, exact decode, owned clock
//                                    (MP4 only, fragmented included: WebM's and
//                                    Ogg's indexes carry timestamps but no
//                                    sample table to decode from)
//   2. container index + <video>     exact index, browser decode + presentation
//                                    (MP4, WebM, Ogg), read out through the
//                                    presented-frame clock (requestVideoFrameCallback)
//
// There is no third tier. A clip whose container we cannot index, or a native-path
// browser with no requestVideoFrameCallback (so no exact presented-frame clock),
// is refused with a clear error rather than played with guessed frame numbers.
// This engine is the *exact* one: an engine it hands back always reports true
// frame indices, never inferred ones.
//
// Decode (engine 1) is windowed by GOP (group of pictures: a keyframe plus the
// frames that depend on it). To show a frame we decode just its GOP, cache the
// results as ImageBitmaps, and evict distant GOPs, so memory stays flat
// regardless of clip length (handles multi-minute clips).
//
// Classic (non-module) script whose host-facing globals are UrlRangeReader,
// FileRangeReader, ContainerIndex, VideoEngine, NativeVideoEngine,
// createBestEngine, and formatProgress (see createBestEngine's onProgress), so
// both module and non-module host pages can use it.
// mp4box.js (the `MP4Box` / `DataStream` globals) should be loaded first to
// index MP4s; WebM and Ogg indexing are built in and need nothing. Without
// mp4box an MP4 cannot be indexed and is refused, while WebM and Ogg still get
// tier 2.
//
// Neither engine touches the host page's DOM beyond the canvas or <video> it is
// given. Errors surface as an 'errormessage' CustomEvent whose detail.message
// is a human-readable string, or null when a previous error should be cleared;
// the host owns rendering (and translating) that message.
// ==================================================================

// ==================================================================
// decode-support — which (browser engine, codec) pairs WebCodecs lies about.
//
// WebCodecs decode support tracks the BROWSER ENGINE, not the device, and its
// feature detection is not always honest. The dangerous class is the "dishonest
// yes": WebKit (desktop Safari and every iOS browser — they are all WebKit
// underneath) answers VideoDecoder.isConfigSupported() = true for 10-bit HEVC
// (the iPhone's own HDR camera format), decodes the first keyframe, and then the
// decoder dies once sustained decoding starts. That death lands AFTER load()
// resolved — past createBestEngine's load-time fallback — so the user sees the
// clip play for a second or two and then stop.
//
// The reactive net for this (v1.7.0) is engine.failed + a fatal errormessage a
// host can rebuild from. This module is the PROACTIVE half: recognize the
// combination up front and route straight to the <video> element, which decodes
// the same clip fine (it uses the platform's own AVFoundation path, not
// WebCodecs). No crash, no flash, and the container index still makes the native
// path frame-exact.
//
// The matrix here is empirical (real-device testing; see the decode-support-matrix
// agent skill). It is deliberately TIGHT — a false positive needlessly gives up
// the WebCodecs owned-clock path — so it names only combinations confirmed to
// crash, and the reactive net still backs up anything it misses.
// ==================================================================

// The browser's underlying engine, inferred from navigator. WebCodecs bugs live
// in the engine, so this — not the device or the browser brand — is what decides
// whether a decode config can be trusted.
//
//   'webkit'  desktop Safari AND all iOS browsers (Chrome/Firefox/Edge on iOS
//             are WebKit-backed by platform mandate). navigator.vendor is
//             'Apple Computer, Inc.' for every one of them.
//   'blink'   Chrome/Edge/Brave/Opera off iOS. navigator.vendor is 'Google Inc.'
//   'gecko'   Firefox off iOS. navigator.vendor is '' (fall back to the UA).
//   'unknown' anything we cannot place; treated as trustworthy (no routing).
function detectBrowserEngine(nav) {
  const navigatorObject = nav
    || (typeof navigator !== 'undefined' ? navigator : null);
  if (!navigatorObject) return 'unknown';
  const vendor = navigatorObject.vendor || '';
  if (vendor === 'Apple Computer, Inc.') return 'webkit';
  if (vendor === 'Google Inc.') return 'blink';
  const userAgent = navigatorObject.userAgent || '';
  if (/firefox|gecko\//i.test(userAgent)) return 'gecko';
  return 'unknown';
}

// Is this codec string 10-bit HEVC — the format WebKit's WebCodecs accepts and
// then fails on? Covers HEVC Main 10 (general_profile_idc 2, the iPhone HDR
// default) declared as hvc1/hev1, and Dolby Vision (dvh1/dvhe), which is
// HEVC-based and always at least 10-bit. Range-Extensions profiles that reach
// 10-bit through a different profile idc are exotic and not matched from the
// codec string alone; the reactive fatal-fallback still covers those.
function isTenBitHevc(codecString) {
  if (!codecString) return false;
  const parts = String(codecString).split('.');
  const fourCharCode = parts[0].toLowerCase();
  // Dolby Vision (HEVC-based) is always >= 10-bit.
  if (fourCharCode === 'dvhe' || fourCharCode === 'dvh1') return true;
  if (fourCharCode === 'hvc1' || fourCharCode === 'hev1') {
    // hvc1.<profile>.<compat>.<tier><level>.<constraints...>; the profile field
    // may carry a one-letter profile-space prefix (A/B/C) before the number.
    const profileField = (parts[1] || '').replace(/^[ABC]/i, '');
    return parseInt(profileField, 10) === 2;   // 2 == HEVC Main 10
  }
  return false;
}

// Should createBestEngine skip the WebCodecs engine for this (codec, engine)
// pair because WebCodecs would accept it and then die mid-stream? True only for
// the confirmed dishonest-yes combinations; everything else goes down the normal
// ladder (try WebCodecs, fall back on an honest rejection).
function webCodecsMayFailMidStream(codecString, browserEngine) {
  return browserEngine === 'webkit' && isTenBitHevc(codecString);
}
// Random-access byte readers used to feed mp4box (the moov index) and to fetch
// encoded samples per GOP on demand — only the bytes actually needed are read.
// URLs go over HTTP Range (the server must answer 206); local Files use
// File.slice.
class UrlRangeReader {
  // Opening a clip is a chain of dependent reads -- learn the size, sniff the
  // container, find the moov, read the frame -- and each one costs a full round
  // trip. Against a bucket 400 ms away (Firebase Storage, measured), eight round
  // trips is four seconds of an empty pane, however few bytes they carry: the
  // first two reads of the old chain asked for ONE byte and FOUR bytes.
  //
  // So the first read is speculative and generous. It answers the size (every
  // 206 names it in Content-Range), the magic number, and, for a faststart clip,
  // the whole moov -- from one round trip instead of three. And a clip small
  // enough to be worth having outright is then fetched outright, rather than
  // groped through a range at a time: a scrub through it would read most of it
  // anyway, and each range is another 400 ms.
  static HEAD_BYTES = 1 << 18;       // 256 KB: enough for a faststart moov
  static WHOLE_FILE_MAX = 8 << 20;   // 8 MB: below this, just take the file

  constructor(url) {
    this.url = url;
    this.size = 0;
    this._cache = null;    // bytes [0, _cache.length) of the file, or null

    // The server's content validator (strong ETag, else Last-Modified, else
    // null), captured from the first response in init(). The index cache keys
    // on it: a byte-offset index is only reusable if the bytes it was built
    // against are byte-for-byte the same, and this header is what promises that.
    // null means the server gave us nothing to trust, so the cache must not
    // store or reuse an index for this URL. See src/index-cache.js.
    this.entityValidator = null;
  }

  async init() {
    const head = await this._fetchRange(0, UrlRangeReader.HEAD_BYTES - 1);
    this._cache = new Uint8Array(head.body);
    this.entityValidator = head.entityValidator;

    if (head.totalSize) this.size = head.totalSize;
    else this.size = this._cache.length;   // a 200: the whole file is in hand

    if (this.size <= this._cache.length) return;
    if (this.size > UrlRangeReader.WHOLE_FILE_MAX) return;

    const rest = await this._fetchRange(this._cache.length, this.size - 1);
    const whole = new Uint8Array(this.size);
    whole.set(this._cache, 0);
    whole.set(new Uint8Array(rest.body), this._cache.length);
    this._cache = whole;
  }

  async read(start, endInclusive) {
    if (this._cache && endInclusive < this._cache.length) {
      // slice() copies, which is what callers want: mp4box takes ownership of
      // the buffers it is appended, and would otherwise be handed a view onto
      // the cache it could detach.
      return this._cache.slice(start, endInclusive + 1).buffer;
    }
    return (await this._fetchRange(start, endInclusive)).body;
  }

  async _fetchRange(start, endInclusive) {
    const response = await fetch(this.url,
      { headers: { Range: `bytes=${start}-${endInclusive}` } });
    if (response.status !== 206 && response.status !== 200) {
      throw new Error(`range read ${response.status}`);
    }
    // A 206 names the file's total size in Content-Range ("bytes 0-99/12345");
    // a 200 means the server ignored Range and sent everything, so what arrived
    // IS the file. Either way we now know how big it is, with no probe request.
    const contentRange = response.headers.get('Content-Range');
    const totalSize = contentRange
      ? parseInt(contentRange.split('/')[1], 10) : 0;
    return {
      body: await response.arrayBuffer(),
      totalSize,
      entityValidator: this._entityValidatorOf(response.headers),
    };
  }

  // The strongest content validator the response headers offer, for the index
  // cache to key on: a strong ETag if there is one, else Last-Modified, else
  // null.
  //
  // A WEAK ETag (one prefixed 'W/') is deliberately skipped. A weak validator
  // promises only that two representations are semantically equivalent — same
  // pixels, perhaps re-muxed — but our index is a table of byte offsets, so it
  // is correct only against byte-for-byte identical content. Semantic sameness
  // is not enough; we need byte identity, which only a strong validator asserts.
  //
  // NOTE on CORS: a cross-origin response exposes ETag and Last-Modified to
  // JavaScript only when the server lists them in Access-Control-Expose-Headers.
  // An unexposed header reads here as absent, so we return null and simply do
  // not cache — which is the safe direction (rebuild rather than risk a stale
  // index), never a wrong one.
  _entityValidatorOf(headers) {
    const etag = headers.get('ETag');
    if (etag && !etag.startsWith('W/')) return etag;
    return headers.get('Last-Modified') || null;
  }
}

class FileRangeReader {
  constructor(file) { this.file = file; this.size = file.size; }
  async init() {}
  async read(start, endInclusive) {
    return await this.file.slice(start, endInclusive + 1).arrayBuffer();
  }
}

// A source is a URL string (server must answer HTTP Range with 206) or a
// File/Blob (browsed local clip).
function createRangeReader(source) {
  return (typeof source === 'string')
    ? new UrlRangeReader(source) : new FileRangeReader(source);
}

// ==================================================================
// Index cache — repeat loads of the same clip, without re-parsing it.
//
// Building an index for a container with no central sample table — WebM,
// fragmented MP4, Ogg — means reading the whole file and walking it end to end
// (see readMatroskaFrameTable). No frame is decoded, but every byte still has
// to go past us, which is disk-speed for a local File and network-speed for a
// URL. That cost is paid on every single load of the clip, and for a long clip
// over a slow link it is the difference between an instant open and a visible
// wait. So we keep the finished index in IndexedDB and hand it back next time.
//
// THE SHARP EDGE, and the reason this file is written the way it is: a stale
// cached index is not a slow index, it is a WRONG index. It is a table of
// per-frame presentation times and byte offsets; reuse it against even slightly
// different bytes and every frame number it reports can be off by one — the
// exact silent error the "index or refuse" plan exists to eliminate. So the
// cache is not allowed to guess. It reuses an entry only when the source's
// content validator (a strong ETag / Last-Modified for a URL, or a File's
// (name, size, lastModified) triple) proves the bytes are the same ones the
// index was built from. When that proof is missing or weak, the correct answer
// is a MISS: rebuild from scratch. deriveIndexCacheKey returning null means
// exactly that — "do not look up, and do not store" — never "probably fine".
//
// The cache is an accelerator, never a dependency. Every entry point here
// swallows its own failures and degrades to "rebuild the index," which is
// always safe: IndexedDB may be undefined (this module runs in plain Node too),
// disabled (private browsing), full, or blocked mid-upgrade, and none of that
// may ever surface to the caller as an error. When in doubt, rebuild.
// ==================================================================

// Bump this on ANY change to the serialized payload's shape (a renamed field, a
// new required field, a changed representation). A stored payload whose
// schemaVersion does not match is treated as a miss, so an old entry from a
// previous build can never be hydrated into a struct it no longer fits.
const INDEX_CACHE_SCHEMA_VERSION = 1;

const DATABASE_NAME = 'exact-video-engine-index-cache';
const DATABASE_VERSION = 1;
const OBJECT_STORE_NAME = 'container-indexes';

// A deliberately simple bound standing in for a real quota policy. The plan
// leaves eviction open (LRU? size cap? quota-aware?); until it is decided we
// keep at most this many entries and drop the least-recently-used past it. A
// multi-hour index is megabytes, so this is a coarse guard against unbounded
// growth, not a tuned cache — and since a missed entry only costs a rebuild,
// evicting too eagerly is never a correctness problem.
const MAXIMUM_ENTRIES = 40;

// The key must be derivable without re-reading the content — otherwise the
// cache saves nothing, because computing the key would cost the same read the
// index does. So it is built entirely from cheap identity metadata the reader
// already has in hand after init().
//
// Returns a stable string identity for the source, or null when the source has
// no trustworthy identity. null is load-bearing in BOTH directions: a null key
// means do not look the cache up (there is nothing safe to look up by) AND do
// not store into it (a future load could collide on a weak key and reuse the
// wrong index). Callers treat null as an unconditional miss-and-do-not-store.
function deriveIndexCacheKey(source, reader) {
  // A local File carries its own strong identity: the browser gives us the
  // name, the byte size, and the last-modified time, and the trio changes
  // whenever the file's bytes could have. A bare Blob (no name, no
  // lastModified) has no such stable identity across loads — two unrelated
  // Blobs of the same size would collide — so it gets no key and is never
  // cached.
  if (source && typeof source === 'object' && typeof source.size === 'number') {
    const hasFileIdentity = typeof source.name === 'string'
      && source.name.length > 0
      && typeof source.lastModified === 'number';
    if (!hasFileIdentity) return null;
    return `file:${source.name}:${source.size}:${source.lastModified}`;
  }

  // A URL is identified by its address, its byte length, and the server's
  // content validator (a strong ETag or Last-Modified — see
  // UrlRangeReader.entityValidator, which already skips weak ETags and
  // unexposed cross-origin headers). No validator means the server gave us
  // nothing to prove the bytes are unchanged, so we refuse to cache rather than
  // risk reusing a stale index: null, a miss.
  if (typeof source === 'string') {
    const validator = reader && reader.entityValidator;
    if (!validator) return null;
    return `url:${source}:${reader.size}:${validator}`;
  }

  return null;
}

// --- IndexedDB, wrapped in promises -------------------------------------------
//
// IndexedDB is an event-based API (requests fire onsuccess/onerror, the open
// request also fires onupgradeneeded/onblocked). These helpers wrap the few
// shapes we need into promises so the logic below reads top to bottom. Each
// rejects rather than throws synchronously, and every caller turns a rejection
// into a miss — the cache never lets an IndexedDB failure escape.

// Open (and, on first use, create) the database. Rejects if IndexedDB is
// missing, if the open errors, or if the upgrade is blocked by another tab
// holding an older version open.
function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB is not available'));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OBJECT_STORE_NAME)) {
        database.createObjectStore(OBJECT_STORE_NAME, { keyPath: 'cacheKey' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB open failed'));
    request.onblocked = () => reject(new Error('indexedDB open blocked'));
  });
}

// Resolve when a request succeeds, reject when it errors — the atom the
// store/get/delete/getAll helpers below are all built from.
function awaitRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('indexedDB request failed'));
  });
}

// Resolve when a transaction commits, reject if it aborts or errors. A
// transaction is not a request — it fires oncomplete, not onsuccess — so
// awaiting one (e.g. after firing several deletes into it) needs its own shape.
function awaitTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('indexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('indexedDB transaction aborted'));
  });
}

// Look up a source's cached index payload, or null.
//
// A hit returns the stored payload only when its schemaVersion matches this
// build's; a version mismatch is a miss (see INDEX_CACHE_SCHEMA_VERSION). Any
// failure at all — no IndexedDB, open error, blocked upgrade, read error —
// resolves to null and never throws, because a failed lookup must be
// indistinguishable from an absent entry: both mean "rebuild."
//
// On a hit we bump the record's lastUsedAtMilliseconds so eviction can favour
// recently-used clips, but that write is fire-and-forget: the payload we are
// about to return is already in hand, and a failed bookkeeping write must not
// turn a good hit into a miss.
async function loadCachedIndexPayload(cacheKey) {
  if (!cacheKey) return null;
  let database = null;
  try {
    database = await openDatabase();
    const transaction = database.transaction(OBJECT_STORE_NAME, 'readonly');
    const store = transaction.objectStore(OBJECT_STORE_NAME);
    const record = await awaitRequest(store.get(cacheKey));
    if (!record || !record.payload
        || record.payload.schemaVersion !== INDEX_CACHE_SCHEMA_VERSION) {
      return null;
    }
    touchRecord(cacheKey).catch(() => {});   // fire-and-forget; failures ignored
    return record.payload;
  } catch (error) {
    return null;
  } finally {
    if (database) database.close();
  }
}

// Rewrite a record's lastUsedAtMilliseconds to now. Best-effort bookkeeping for
// eviction ordering; callers ignore whether it succeeds.
async function touchRecord(cacheKey) {
  let database = null;
  try {
    database = await openDatabase();
    const transaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(OBJECT_STORE_NAME);
    const record = await awaitRequest(store.get(cacheKey));
    if (record) {
      record.lastUsedAtMilliseconds = Date.now();
      await awaitRequest(store.put(record));
    }
  } finally {
    if (database) database.close();
  }
}

// Store a built index payload for a source, best-effort. Never throws: a failed
// write (quota exceeded, IndexedDB disabled, transaction error) only means the
// next load rebuilds, which is always safe. After writing we prune to
// MAXIMUM_ENTRIES, dropping the least-recently-used — likewise best-effort.
async function storeCachedIndexPayload(cacheKey, payload) {
  if (!cacheKey || !payload) return;
  let database = null;
  try {
    database = await openDatabase();
    const transaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(OBJECT_STORE_NAME);
    await awaitRequest(store.put({
      cacheKey,
      lastUsedAtMilliseconds: Date.now(),
      payload,
    }));
  } catch (error) {
    return;   // a store that fails just means the next load rebuilds
  } finally {
    if (database) database.close();
  }
  await pruneToLimit().catch(() => {});   // best-effort; a full store still works
}

// Keep the store at or below MAXIMUM_ENTRIES by deleting the oldest-used
// records. Reads every record's lastUsedAtMilliseconds, sorts, and deletes the
// excess from the front. Best-effort: any failure leaves the store as-is (an
// over-full cache is a space concern, never a correctness one).
async function pruneToLimit() {
  let database = null;
  try {
    database = await openDatabase();
    const readTransaction = database.transaction(OBJECT_STORE_NAME, 'readonly');
    const readStore = readTransaction.objectStore(OBJECT_STORE_NAME);
    const records = await awaitRequest(readStore.getAll());
    if (!records || records.length <= MAXIMUM_ENTRIES) return;

    records.sort((a, b) =>
      (a.lastUsedAtMilliseconds || 0) - (b.lastUsedAtMilliseconds || 0));
    const doomed = records.slice(0, records.length - MAXIMUM_ENTRIES);

    const writeTransaction = database.transaction(OBJECT_STORE_NAME, 'readwrite');
    const writeStore = writeTransaction.objectStore(OBJECT_STORE_NAME);
    for (const record of doomed) writeStore.delete(record.cacheKey);
    await awaitTransaction(writeTransaction);
  } finally {
    if (database) database.close();
  }
}

// --- serialization ------------------------------------------------------------
//
// The payload is a plain, structured-cloneable snapshot of a ContainerIndex —
// everything both engines need to run without the container, and nothing that
// cannot survive IndexedDB's structured clone. Typed arrays (Float64Array,
// Int32Array, Uint8Array) clone as-is, so they are stored directly with no
// conversion to and from plain arrays. The reader is not stored (it is a live
// object bound to a URL or File, rebuilt per load), and neither is
// microsToDisplay — a Map keyed on values derived from the sample table, which
// hydrateContainerIndex reconstructs rather than serialize a redundant copy.

// Snapshot a built ContainerIndex into a storable payload.
function serializeContainerIndex(index) {
  const decoderConfig = index.decoderConfig ? {
    codec: index.decoderConfig.codec,
    codedWidth: index.decoderConfig.codedWidth,
    codedHeight: index.decoderConfig.codedHeight,
    // The avcC/hvcC bytes, a Uint8Array (or undefined for codecs that carry no
    // description); a Uint8Array survives structured clone unchanged.
    description: index.decoderConfig.description,
    optimizeForLatency: index.decoderConfig.optimizeForLatency,
  } : null;

  return {
    schemaVersion: INDEX_CACHE_SCHEMA_VERSION,
    containerFormat: index.containerFormat,
    timescale: index.timescale,
    // Display-order tables (typed arrays, stored as-is).
    presentationTimes: index.presentationTimes,
    frameDurations: index.frameDurations,
    displayToDecode: index.displayToDecode,
    // Decode-order sample table: an array of small plain objects
    // ({offset, size, isSync, cts, duration}), or null for a WebM/Ogg index
    // that has timestamps but no sample table. Stored as-is either way.
    samples: index.samples,
    keyframeDecodeIndices: index.keyframeDecodeIndices,
    decoderConfig,
    rotation: index.rotation,
    videoWidth: index.videoWidth,
    videoHeight: index.videoHeight,
    numFrames: index.numFrames,
    duration: index.duration,
    trimmedByEditList: index.trimmedByEditList,
  };
}

// Assign a payload back onto a freshly constructed (empty) ContainerIndex.
//
// The target is duck-typed: we assign its fields directly rather than import
// ContainerIndex, because container-index.js imports THIS module and importing
// it back would be a cycle. So the contract is "an object with the same fields
// the constructor lays out."
//
// Returns false without touching the target when the payload is falsy or its
// schemaVersion does not match this build — the caller then rebuilds. On
// success every field is restored, microsToDisplay is rebuilt from the sample
// table (see below), and it returns true.
function hydrateContainerIndex(index, payload) {
  if (!payload || payload.schemaVersion !== INDEX_CACHE_SCHEMA_VERSION) return false;

  index.containerFormat = payload.containerFormat;
  index.timescale = payload.timescale;
  index.presentationTimes = payload.presentationTimes;
  index.frameDurations = payload.frameDurations;
  index.displayToDecode = payload.displayToDecode;
  index.samples = payload.samples;
  index.keyframeDecodeIndices = payload.keyframeDecodeIndices;
  index.decoderConfig = payload.decoderConfig;
  index.rotation = payload.rotation;
  index.videoWidth = payload.videoWidth;
  index.videoHeight = payload.videoHeight;
  index.numFrames = payload.numFrames;
  index.duration = payload.duration;
  index.trimmedByEditList = !!payload.trimmedByEditList;

  // microsToDisplay is rebuilt, not stored: it is a Map from a sample's
  // composition time (in whole microseconds) to its display index, and it only
  // exists for an ISOBMFF index that has a sample table. Rebuild it exactly as
  // container-index.js's _buildTables does — key Math.round(cts * 1e6 /
  // timescale), value the display index — so a hydrated index answers
  // microsToDisplay lookups identically to a freshly-built one. A WebM/Ogg
  // index has no samples, so it keeps microsToDisplay null, matching the
  // freshly-built shape.
  if (payload.samples && payload.displayToDecode) {
    const microsToDisplay = new Map();
    for (let displayIndex = 0; displayIndex < payload.displayToDecode.length; displayIndex++) {
      const decodeIndex = payload.displayToDecode[displayIndex];
      const sample = payload.samples[decodeIndex];
      microsToDisplay.set(
        Math.round(sample.cts * 1e6 / payload.timescale), displayIndex);
    }
    index.microsToDisplay = microsToDisplay;
  } else {
    index.microsToDisplay = null;
  }

  return true;
}
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
class IndexBudgetExceededError extends Error {
  constructor(message) { super(message); this.name = 'IndexBudgetExceededError'; }
}

// A forward-only byte cursor over a range reader, holding one chunk at a time.
// Skipping a block's payload costs nothing: it moves the position, and the next
// read that needs bytes refetches from wherever the position now is.
class SequentialByteCursor {
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
function formatProgress(progress) {
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
async function readMatroskaFrameTable(reader, options = {}) {
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
async function readOggFrameTable(reader, options = {}) {
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
// Three containers, three ways in, one table out.
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
//
// `supportsWebCodecs` is how the ladder in createBestEngine tells the ISOBMFF
// index (decodable) from the WebM and Ogg ones (native-only).
//
// Anything else (HLS and other segmented delivery, raw elementary streams) still
// fails here, and the <video> element cannot play those either. That is the
// intended refusal, not a bug.
// ==================================================================
class ContainerIndex {
  constructor(reader) {
    this.reader = reader;
    this.timescale = 1;
    this.containerFormat = null;     // 'isobmff' | 'matroska' | 'ogg'

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

// Frames the cache holds beyond the read-ahead window's far edge. Decoded
// frames arrive a little past the target while the playhead is still catching
// up, and evicting them the moment they land would mean decoding them twice.
const WINDOW_SLACK = 8;
// Never shrink the window below this, whatever the byte budget says: a cache
// that cannot hold the frame being decoded plus its neighbours would evict its
// own read-ahead and thrash.
const MINIMUM_WINDOW_FRAMES = 4;
// How far past a frame we keep feeding the decoder before concluding the frame
// is not going to come out. Decoders hold frames back to settle display order,
// so a frame we asked for can legitimately lag the samples we fed by a few — but
// only a few. Past this, it is not in the pipeline: it was decoded earlier and
// evicted, and it has to be decoded again rather than waited for.
const REORDER_DEPTH = 16;

// ==================================================================
// VideoEngine — WebCodecs. Authoritative: we decide which frame is on screen.
// ==================================================================
class VideoEngine extends EventTarget {
  // options.windowAhead: how many frames to decode ahead of the playhead. The
  // default (56, ≈2 s) is sized for playback, where read-ahead is what absorbs
  // decode jitter. A host that mostly holds still — a frame-by-frame annotation
  // tool, a thumbnail picker — is buying bandwidth and decode work it will not
  // use, and can turn this down. It does not affect which frames are available,
  // only how eagerly they are fetched: the frame you ask for is always decoded.
  //
  // options.cacheBytes: the memory ceiling for decoded frames (default 96 MB).
  // This, not windowAhead, is what bounds the engine's memory — the window is
  // cut to fit it, so a 4K clip caches few frames and a 360p clip caches many.
  constructor(presentationCanvas, options = {}) {
    super();
    this.canvas = presentationCanvas;
    this.context = presentationCanvas.getContext('2d');
    this.ready = false;
    this.playing = false;
    this.loop = true;
    this._playbackRate = 1;

    this.playhead = 0;          // seconds on the composition timeline
    this.duration = 0;
    this.numFrames = 0;

    this._index = null;
    this._reader = null;
    this._videoDecoder = null;
    this._decoderConfig = null;
    // True once the VideoDecoder has reported an unrecoverable error (see
    // _decoderFailed); cleared by load()/_teardown().
    this.failed = false;
    this._timescale = 1;

    // Upright display geometry, taken from the container index: the track's
    // rotation metadata (0/90/180/270) and the dimensions consumers should
    // letterbox and annotate against (coded axes swapped when rotation is
    // 90/270).
    this.rotation = 0;
    this.videoWidth = 0;
    this.videoHeight = 0;

    // Decode-order sample table, aliased from the index (the decode driver
    // reads these on every tick).
    this._samples = null;
    this._keyframeDecodeIndices = null;
    this._displayToDecode = null;
    this._microsToDisplay = null;

    // Frame-level windowed cache. Single-keyframe ("one GOP") clips are common,
    // so we never hold a whole GOP — only a sliding window of decoded frames
    // around the playhead. Decoding streams forward from a keyframe and only
    // restarts (reset + reconfigure + decode forward) on a backward seek.
    this._cache = new Map();          // displayIndex -> ImageBitmap
    // Frames the decoder has emitted whose ImageBitmap is still being made
    // (createImageBitmap is async). They are on their way into the cache, so the
    // driver must not read their absence from _cache as "never decoded" and go
    // decode them all over again.
    this._pending = new Set();        // displayIndex
    // What the host would LIKE to hold: frames behind the playhead (a backward
    // scrub is then free) and ahead of it (playback doesn't stall on the
    // decoder). These are wishes, not the budget — _sizeWindows() cuts them to
    // what the clip's resolution can afford once the index says how big a frame
    // is. windowAhead: 0 means "no read-ahead at all", and stays 0.
    this._wantedWindowBack = 18;
    this._wantedWindowAhead = Math.max(0, options.windowAhead ?? 56);   // ≈2 s
    // A decoded frame's memory is width x height x 4, so a frame-counted cache
    // costs whatever the clip decides: 82 frames of 360p is 75 MB and 82 frames
    // of 1080p is 680 MB. On a phone the second one exhausts the surface pool
    // the decoder draws from and WebKit kills the decode session mid-playback
    // ("Decoder failure"), which is why the cache is sized in BYTES and the
    // window in frames falls out of it. The default is deliberately well under
    // iOS Safari's few-hundred-MB ceiling for image memory, which the
    // presentation canvas and the decoder's own frame pool also draw against.
    this._cacheBytes = Math.max(8 << 20, options.cacheBytes ?? (96 << 20));
    // Filled in by _sizeWindows() from _cacheBytes and the clip's frame size.
    this._windowBack = this._wantedWindowBack;
    this._windowAhead = this._wantedWindowAhead;
    this._windowSlack = WINDOW_SLACK;
    this._cacheBudget = this._windowBack + 1 + this._windowAhead + WINDOW_SLACK;
    // Cached bitmaps are for display only (frame-index accuracy is independent
    // of their resolution), so cap their long side: a 4K frame is 33 MB and the
    // whole byte budget would buy three of them. The canvas pane is never bigger
    // than the screen, so this is invisible. 1080p and smaller keep full
    // resolution (no downscale).
    this._displayCapPixels = 1920;
    this._runKeyframe = -1;           // decode index the current decode run began at
    this._fedThrough = -1;            // highest decode index fed to the decoder
    this._drained = false;            // flushed: the decoder now demands a key frame
    this._target = 0;                 // display frame the driver is steering toward
    this._driving = false;            // a _drive() loop is active
    this._restartTarget = -1;         // circuit-breaker: target of the last restart
    this._restartCount = 0;           // consecutive restarts for that same target
    this._stalledFrame = -1;          // a frame the circuit-breaker gave up on
    this._byteBuffer = null;          // read-ahead buffer of encoded bytes
    this._byteBufferStart = 0;        // its file offset

    this._shownFrame = -1;
    this._lastBitmap = null;
    this._lastNow = 0;
  }

  get paused() { return !this.playing; }
  get playbackRate() { return this._playbackRate; }
  set playbackRate(rate) { this._playbackRate = rate; }
  // The DOM node this engine presents into (for hosts that show/hide it or
  // position other elements relative to it).
  get displayElement() { return this.canvas; }
  // What this engine got, for dev labels and host-side diagnostics.
  get tier() { return 'webcodecs'; }
  // The clip's codec string as the container declares it (e.g.
  // 'hvc1.2.4.L123.b0'), for hosts that want to predict format trouble —
  // say, flagging 10-bit profiles for server-side conversion. Null until
  // load() has adopted an index.
  get codecString() { return this._decoderConfig ? this._decoderConfig.codec : null; }
  // The engine decodes each frame itself, so its frame indices are exact by
  // construction — there is no browser presentation to be uncertain about.
  get frameIndexIsExact() { return true; }

  frameAtTime(t) { return this._index ? this._index.frameAtTime(t) : 0; }

  get currentFrame() { return this.frameAtTime(this.playhead); }

  // Continuous playhead in frame units (frame index + fraction through that
  // frame's display interval) — what a host should drive any frame-indexed
  // display it renders in sync with the video (interpolated overlays etc.)
  // from, in place of the drift-prone `currentTime * frameRate`.
  get currentFrameFloat() {
    return this._index ? this._index.frameFloatAtTime(this.playhead) : 0;
  }

  get currentTime() { return this.playhead; }
  set currentTime(t) { this.playhead = Math.max(0, Math.min(this.duration, t)); }

  // Land the playhead exactly on the start of display frame n. Because we own
  // frameAtTime there is no browser seek-rounding to dodge, so we use the
  // frame's start directly (no midpoint trick, unlike NativeVideoEngine):
  // frameAtTime(presentationTimes[n]) === n exactly.
  seekToFrame(n) {
    if (!this._index) return;
    n = Math.max(0, Math.min(this.numFrames - 1, n | 0));
    this.playhead = this._index.presentationTimes[n];
  }

  play() { if (this.ready && !this.playing) { this.playing = true; this._lastNow = 0; } }
  pause() { this.playing = false; }

  // options.index: a ContainerIndex already built for this source (createBestEngine
  // builds one up front and hands the same one to whichever engine plays, so the
  // moov is never parsed twice). Omit it and the engine builds its own.
  async load(source, options = {}) {
    this._teardown();
    try {
      const index = options.index
        || await ContainerIndex.fromSource(source);
      if (!index.supportsWebCodecs) {
        // A WebM index: exact timestamps, but no sample table and no decoder
        // configuration, so there is nothing here to decode from. The clip is
        // fine — it belongs on NativeVideoEngine, which the same index makes
        // frame-exact anyway.
        throw new Error(`this ${index.containerFormat} container carries no `
          + 'sample table for WebCodecs to decode from');
      }
      this._adoptIndex(index);

      const support = await VideoDecoder.isConfigSupported(this._decoderConfig);
      if (!support.supported) {
        throw new Error('codec not supported: ' + this._decoderConfig.codec);
      }

      this._configureDecoder();
      this.playhead = 0;
      this._shownFrame = -1;
      // Decode and paint frame 0 before resolving (the loadeddata analogue).
      await this.ensureFrame(0);
      this.resizeCanvas();   // size the backing store to the pane before painting
      this._present(0);
      this.ready = true;
      this.dispatchEvent(new Event('loaded'));
    } catch (err) {
      console.error('VideoEngine.load failed:', err);
      this._showError(err && err.message ? err.message : String(err));
      throw err;
    }
  }

  _adoptIndex(index) {
    this._index = index;
    this._reader = index.reader;
    this._decoderConfig = index.decoderConfig;
    this._timescale = index.timescale;
    this._samples = index.samples;
    this._keyframeDecodeIndices = index.keyframeDecodeIndices;
    this._displayToDecode = index.displayToDecode;
    this._microsToDisplay = index.microsToDisplay;
    this.numFrames = index.numFrames;
    this.duration = index.duration;
    this.rotation = index.rotation;
    this.videoWidth = index.videoWidth;
    this.videoHeight = index.videoHeight;
    this._sizeWindows();
  }

  // The size a cached bitmap of this clip's frames comes out at, after the
  // display cap. _absorb downscales to exactly this, so the byte budget below
  // and the memory actually held are the same arithmetic.
  _cachedBitmapSize(width, height) {
    const scale = Math.min(1, this._displayCapPixels / Math.max(width, height));
    return [Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale))];
  }

  // Turn the byte budget into a frame window, now that the index has said how
  // big a frame is. The clip's resolution — not the host — decides how many
  // frames fit: at 96 MB that is ~330 frames of 360p but only ~11 of 1080p.
  _sizeWindows() {
    const [width, height] = this._cachedBitmapSize(this.videoWidth, this.videoHeight);
    const bytesPerFrame = Math.max(1, width * height * 4);
    const affordable = Math.max(MINIMUM_WINDOW_FRAMES,
      Math.floor(this._cacheBytes / bytesPerFrame));

    // Frames resident at once: the ones behind, the centre frame, the ones
    // ahead, and the slack _insideWindow admits past the far edge.
    let back = this._wantedWindowBack;
    let ahead = this._wantedWindowAhead;
    let slack = WINDOW_SLACK;

    if (back + 1 + ahead + slack > affordable) {
      // Everything except the centre frame is negotiable. Read-ahead is bought
      // first — without it playback stalls on the decoder every frame, whereas a
      // short history only costs a re-decode on a backward scrub — and this only
      // ever shrinks the window, so a host that asked for no read-ahead (or a
      // narrow one) keeps what it asked for.
      const spendable = Math.max(0, affordable - 1);
      slack = Math.min(slack, Math.floor(spendable / 3));
      const forWindow = spendable - slack;
      back = Math.min(back, Math.floor(forWindow / 4));
      ahead = Math.min(ahead, forWindow - back);
    }
    this._windowBack = back;
    this._windowAhead = ahead;
    this._windowSlack = slack;
    // Must cover the window on both sides, or the eviction pass would throw away
    // frames the read-ahead just paid to decode.
    this._cacheBudget = back + 1 + ahead + slack;
  }

  // ---- decode (streaming, frame-windowed) ---------------------------------
  _configureDecoder() {
    this._videoDecoder = new VideoDecoder({
      output: (frame) => this._absorb(frame),
      error: (e) => this._decoderFailed(e),
    });
    this._videoDecoder.configure(this._decoderConfig);
    this._runKeyframe = -1;
    this._fedThrough = -1;
  }

  // The VideoDecoder error callback fires only for unrecoverable failures (the
  // decoder is closed once it does). The treacherous case is a browser whose
  // isConfigSupported() said yes and whose decoder survived frame 0 but dies
  // once sustained decoding starts — seen on WebKit with 10-bit HEVC — which
  // is AFTER load() resolved, so createBestEngine's load-time fallback cannot
  // catch it. Mark the engine failed so waiters (ensureFrame) fail fast
  // instead of timing out, and tell the host it is fatal: a host holding a
  // <video> element should rebuild with prefer: 'native', which typically
  // plays the same clip fine.
  _decoderFailed(e) {
    console.error('VideoDecoder error:', e);
    this.failed = true;
    const detail = {
      message: e && e.message ? e.message : String(e),
      fatal: true,
      errorName: (e && e.name) || null,
      codec: this._decoderConfig ? this._decoderConfig.codec : null,
      frame: this.currentFrame,
    };
    this.dispatchEvent(new CustomEvent('errormessage', { detail }));
  }

  // Largest keyframe decode index <= decodeIndex (binary search).
  _keyframeForDecode(decodeIndex) {
    const arr = this._keyframeDecodeIndices;
    let lo = 0, hi = arr.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid] <= decodeIndex) { ans = arr[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  // The frames worth keeping sit around the playhead AND around whatever frame
  // the decode driver is currently steering toward. Those are usually the same
  // number: a seek moves the playhead and the target together, and playback
  // walks both forward. They come apart when a host asks for a frame WITHOUT
  // moving the playhead — ensureFrame(n) on its own, which is how a thumbnail or
  // an annotation tool grabs a frame's pixels.
  //
  // Windowing on the playhead alone made that case impossible: the driver dutifully
  // decoded toward the target, and every frame it produced arrived here, landed
  // outside the playhead's window, and was dropped on the floor. ensureFrame then
  // waited for a frame that was being decoded and discarded over and over, until
  // it timed out. The bug needed a clip longer than the window (~64 frames) to show
  // itself at all, so short test clips sailed straight past it.
  _windowCenters() {
    const current = this.currentFrame;
    return (this._target === current) ? [current] : [current, this._target];
  }

  _insideWindow(displayIndex) {
    return this._windowCenters().some((center) =>
      displayIndex >= center - this._windowBack
      && displayIndex <= center + this._windowAhead + this._windowSlack);
  }

  // A decoded frame arrived. Cache it (as an ImageBitmap, freeing the decoder's
  // bounded frame pool) if it falls inside a window we care about; otherwise drop.
  _absorb(frame) {
    const displayIndex = this._microsToDisplay.get(frame.timestamp);
    if (displayIndex === undefined
        || !this._insideWindow(displayIndex)
        || this._cache.has(displayIndex)) {
      frame.close();
      return;
    }
    const cacheRef = this._cache;   // detect a teardown/reload mid-conversion
    // Downscale oversized frames (e.g. 4K) when caching — display only. Same
    // arithmetic _sizeWindows() budgeted against, so what lands in the cache is
    // the size it was told to expect.
    let options;
    const [width, height] =
      this._cachedBitmapSize(frame.displayWidth, frame.displayHeight);
    if (width !== frame.displayWidth || height !== frame.displayHeight) {
      options = { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' };
    }
    this._pending.add(displayIndex);
    createImageBitmap(frame, options).then((bitmap) => {
      frame.close();
      this._pending.delete(displayIndex);
      if (cacheRef !== this._cache || cacheRef.has(displayIndex)) { bitmap.close(); return; }
      cacheRef.set(displayIndex, bitmap);
      this._evict();
    }).catch(() => {
      this._pending.delete(displayIndex);
      try { frame.close(); } catch (e) { /* already closed */ }
    });
  }

  _evict() {
    if (this._cache.size <= this._cacheBudget) return;
    // Forward-biased: drop frames BEHIND the playhead first (forward playback
    // won't revisit them), farthest-behind first; only then frames far AHEAD.
    // This protects the read-ahead window we just paid to decode — a symmetric
    // distance metric would instead evict the about-to-be-shown read-ahead.
    //
    // Ranked against the nearest window centre, for the same reason _absorb is:
    // when a host has asked for a frame away from the playhead, that frame and
    // its neighbours are the ones being decoded right now, and evicting them by
    // distance-from-playhead would throw out the very thing we are waiting for.
    const centers = this._windowCenters();
    const distance = (k, center) =>
      (k < center) ? 2e6 + (center - k) : (k - center);
    const rank = (k) => Math.min(...centers.map((center) => distance(k, center)));
    const keys = [...this._cache.keys()].sort((a, b) => rank(b) - rank(a));
    while (this._cache.size > this._cacheBudget) {
      const key = keys.shift();
      if (key === undefined) break;
      const bitmap = this._cache.get(key);
      if (bitmap) bitmap.close();
      this._cache.delete(key);
    }
  }

  _bitmapFor(frameIndex) { return this._cache.get(frameIndex); }

  // Steer decoding toward display frame N: kick the driver loop, which streams
  // samples forward from the right keyframe and fills the cache window.
  _request(frameIndex) {
    if (frameIndex === this._stalledFrame) return;   // known-undecodable; don't spin
    this._target = frameIndex;
    if (!this._driving) { this._driving = true; this._drive(); }
  }

  async _drive() {
    try {
      while (this._videoDecoder) {
        const target = this._target;
        const targetDecode = this._displayToDecode[target];
        const keyframe = this._keyframeForDecode(targetDecode);
        // Read-ahead goal in decode-index terms: enough to also produce the
        // frames ahead of the target (so playback doesn't stall every frame).
        const aheadFrame = Math.min(this.numFrames - 1, target + this._windowAhead);
        const decodeGoal = Math.max(targetDecode, this._displayToDecode[aheadFrame]);
        const lastSample = this._samples.length - 1;
        // Decoded, or decoded and still becoming an ImageBitmap. Either way it is
        // coming, and re-decoding it would be wasted work.
        const haveTarget = this._cache.has(target) || this._pending.has(target);

        // Hard restart when the target lives in a different GOP than the current
        // run. Backward seeks within the same GOP are handled below.
        if (this._runKeyframe !== keyframe) this._restartRun(keyframe);

        // Need more frames decoded? Feed the next sample (in decode order).
        //
        // Past the read-ahead goal, keep feeding while the target itself has not
        // surfaced. A decoder holds a frame back until enough LATER samples have
        // arrived to settle the display order (B-frames), so more samples -- not
        // a flush -- are what shake it loose. Flushing here instead would empty
        // the decoder and leave it demanding a key frame, which the next delta
        // sample is not: it throws, and the driver dies with the picture frozen
        // on whatever frame was last painted. That was survivable only while the
        // read-ahead was so deep the target always surfaced before we reached
        // the goal; it is the ordinary case once the byte budget cuts the window
        // on a big clip.
        //
        // Bounded by REORDER_DEPTH: a decoder holds only a few frames back, so
        // once we are well past the target with nothing to show for it, the frame
        // is not in the pipeline at all -- it came out earlier and was evicted
        // (a backward seek), and feeding forward would read to the end of the
        // clip to find something that is behind us.
        const stillComing = !haveTarget
          && this._fedThrough < lastSample
          && this._fedThrough < targetDecode + REORDER_DEPTH;
        if (this._fedThrough < decodeGoal || stillComing) {
          // A drained decoder accepts nothing but a key frame, and the next
          // sample in decode order is a delta. Begin the run again.
          if (this._drained) { this._restartRun(keyframe); continue; }
          // Keep few chunks in flight so few decoded frames (which may be 4K)
          // coexist before we downscale + cache them.
          if (this._videoDecoder.decodeQueueSize > 4) { await this._sleep(0); continue; }
          const k = this._fedThrough + 1;
          const s = this._samples[k];
          // Until the target is on screen, every byte we fetch beyond the ones
          // it depends on is a byte the viewer waits on for nothing. So read
          // only as far as the target's own sample while it is outstanding, and
          // switch to big background blocks once it has surfaced. On a slow link
          // this is the difference between waiting for one keyframe and waiting
          // for a fixed 4 MB block.
          await this._ensureBytes(s.offset, s.size,
            this._cache.has(target) ? 0 : this._bytesThrough(k, targetDecode));
          if (!this._videoDecoder || this._fedThrough !== k - 1) continue;  // restarted mid-read
          this._videoDecoder.decode(new EncodedVideoChunk({
            type: s.isSync ? 'key' : 'delta',
            timestamp: Math.round(s.cts * 1e6 / this._timescale),
            duration: Math.round(s.duration * 1e6 / this._timescale),
            data: this._sliceSample(k),
          }));
          this._fedThrough = k;
          continue;
        }

        if (!haveTarget && this._target === target) {
          // The clip has no sample left to feed and the target still has not come
          // out: it is held in the pipeline with nothing later to release it. Only
          // here is a flush the right instrument -- it drains what is held. The run
          // is over afterwards (the decoder now wants a key frame), so forget it:
          // anything further restarts from a keyframe.
          if (this._fedThrough >= lastSample && !this._drained) {
            await this._videoDecoder.flush();
            this._drained = true;
            if (this._target !== target) continue;     // playhead moved; re-evaluate
            if (this._cache.has(target) || this._pending.has(target)) continue;
          }
          // The target was decoded earlier and evicted (a backward seek beyond
          // the window), so decode it again from its keyframe. Guard against an
          // impossible target so a bad frame can't spin the loop forever.
          if (this._restartTarget === target && ++this._restartCount > 2) {
            console.warn(`VideoEngine: cannot decode frame ${target}; holding`);
            this._stalledFrame = target;
            this._driving = false;
            return;
          }
          if (this._restartTarget !== target) { this._restartTarget = target; this._restartCount = 0; }
          this._restartRun(keyframe);
          continue;
        }

        // Target is shown and read-ahead is satisfied: idle until next request.
        if (this._target === target) { this._driving = false; return; }
      }
    } catch (err) {
      console.error('decode driver:', err);
    }
    this._driving = false;
  }

  _restartRun(keyframe) {
    this._videoDecoder.reset();
    this._videoDecoder.configure(this._decoderConfig);
    this._runKeyframe = keyframe;
    this._fedThrough = keyframe - 1;
    this._drained = false;
  }

  // Encoded bytes from sample `from` through sample `through`, inclusive — what
  // it costs to decode `through`, given a decode run that starts at `from`.
  // Samples are contiguous in decode order, so this is just the span between
  // them; it is what the urgent read below asks for.
  _bytesThrough(from, through) {
    const first = this._samples[from];
    const last = this._samples[Math.max(from, through)];
    return (last.offset + last.size) - first.offset;
  }

  // Ensure the encoded bytes for [offset, offset+size) are in the read-ahead
  // buffer, fetching a larger block (covering many subsequent samples) on a miss.
  //
  // `wanted` is how far ahead this particular read is worth taking: pass 0 (the
  // default) for background read-ahead, which takes a big block because the
  // viewer is not waiting on it and one fat request beats twenty thin ones; pass
  // a byte count while a frame is outstanding, and the block shrinks to just the
  // samples that frame depends on. A fixed block here used to make the first
  // frame of a clip wait on 4 MB when a single keyframe would have done.
  //
  // It is still a floor-and-ceiling, not an exact read: never less than this
  // sample (or the slice below would run off the end of the buffer), never more
  // than MAX_BLOCK, and never so small that a GOP costs one request per frame.
  async _ensureBytes(offset, size, wanted = 0) {
    const buffer = this._byteBuffer;
    if (buffer && offset >= this._byteBufferStart
        && offset + size <= this._byteBufferStart + buffer.length) return;
    const MAX_BLOCK = 1 << 22;   // 4 MB
    const MIN_BLOCK = 1 << 18;   // 256 KB — a round trip costs more than these bytes
    const block = wanted > 0
      ? Math.min(MAX_BLOCK, Math.max(size, Math.min(wanted, MAX_BLOCK), MIN_BLOCK))
      : MAX_BLOCK;
    const end = Math.min(this._reader.size, offset + block) - 1;
    this._byteBuffer = new Uint8Array(await this._reader.read(offset, end));
    this._byteBufferStart = offset;
  }
  _sliceSample(k) {
    const s = this._samples[k];
    const rel = s.offset - this._byteBufferStart;
    return this._byteBuffer.subarray(rel, rel + s.size);
  }
  _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Block until display frame N is decoded and cached (used to paint frame 0
  // on load, and by consumers that grab a frame's pixels — e.g. thumbnail
  // capture). Bounded so a bad clip fails instead of hanging.
  async ensureFrame(frameIndex) {
    this._request(frameIndex);
    const startedAt = performance.now();
    while (!this._cache.has(frameIndex)) {
      // A dead decoder will never produce this frame; fail now, not at the
      // timeout. This is also what lets load() (frame 0 goes through here)
      // reject promptly when the decoder dies during load, so
      // createBestEngine's fallback fires without a 5-second stall.
      if (this.failed) throw new Error('decoder failed');
      await this._sleep(8);
      if (performance.now() - startedAt > 5000) throw new Error('decode timed out');
    }
  }

  // The decoded ImageBitmap for display frame N, if resident in the cache
  // (call ensureFrame first to guarantee it). NOTE: the bitmap is in CODED
  // orientation and may be downscaled to _displayCapPixels on its long side —
  // consumers must apply `rotation` themselves and treat coordinates as
  // relative, not absolute pixels. NativeVideoEngine has no equivalent (a
  // <video> element cannot hand back a frame you can name), so hosts that need
  // pixels should check `frameIndexIsExact` or `tier` first.
  bitmapForFrame(frameIndex) { return this._cache.get(frameIndex); }

  // ---- per-tick clock + presentation --------------------------------------
  // Called once per render tick with the rAF timestamp. Advances the owned
  // playhead, drives decoding of the surrounding window, and paints the frame.
  update(now) {
    if (!this.ready) return;
    // The pane can get its size, or change it, after the clip was loaded — a host
    // that reveals the player only once the clip is ready, a CSS transition, a
    // flex reflow. Nothing announces that, so check it here rather than rely on
    // the host to call resizeCanvas() at exactly the right moment.
    this._syncCanvasSize();
    if (this.playing) {
      if (this._lastNow) {
        this.playhead += (now - this._lastNow) / 1000 * this._playbackRate;
        if (this.playhead >= this.duration) {
          if (this.loop) {
            this.playhead -= this.duration;
            if (!(this.playhead >= 0 && this.playhead < this.duration)) this.playhead = 0;
          } else {
            this.playhead = Math.max(0, this.duration - 1e-6);
            this.playing = false;
          }
        }
      }
      this._lastNow = now;
    } else {
      this._lastNow = 0;
    }

    const frame = this.frameAtTime(this.playhead);
    this._request(frame);   // streams/prefetches the window around `frame`
    if (frame !== this._shownFrame) {
      const bitmap = this._cache.get(frame);
      if (bitmap) this._present(frame, bitmap);   // else hold last frame (stall)
    }
  }

  _present(frameIndex, bitmap) {
    bitmap = bitmap || this._bitmapFor(frameIndex);
    if (!bitmap) return;
    this._lastBitmap = bitmap;
    this._shownFrame = frameIndex;
    this._drawBitmap(bitmap);
  }

  // Size the canvas backing store to the pane (device pixels) and repaint the
  // current frame. Safe to call at any time; update() also calls it every tick,
  // so a host does not have to get the timing right.
  resizeCanvas() { this._syncCanvasSize(); }

  _syncCanvasSize() {
    // No pane at all: the canvas is not in a document tree. That is a real way
    // to use this engine — a host that only wants pixels (bitmapForFrame) and
    // never shows the canvas, e.g. generating a thumbnail during an upload — so
    // it is not an error, it is the 0x0 case below with nothing to measure.
    // Reading clientWidth off the null parent instead would throw out of
    // load(), which createBestEngine catches and reports as "WebCodecs cannot
    // play this clip": a silent, permanent fallback to the <video> element for
    // every offscreen host, on every clip.
    const pane = this.canvas.parentElement;
    if (!pane) return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(pane.clientWidth * dpr);
    const height = Math.round(pane.clientHeight * dpr);

    // A pane with no layout — display:none, not yet in the document, a host that
    // reveals its player only once the clip is ready — measures 0x0. Leave the
    // canvas alone and wait to be called again once it has a box. Sizing it to
    // 1x1 here (the obvious clamp) would quietly replace the frame with a single
    // pixel of its average colour, which CSS then stretches across the pane: a
    // flat wash that looks like a decode failure but is a layout bug.
    //
    // Both early returns self-heal: update() calls this every animation frame,
    // so a canvas that later gains a parent, or a box, starts painting then.
    if (!width || !height) return;

    if (this.canvas.width === width && this.canvas.height === height) return;
    // Assigning either dimension clears the canvas, so this must repaint.
    this.canvas.width = width;
    this.canvas.height = height;
    if (this._lastBitmap) this._drawBitmap(this._lastBitmap);
  }

  _drawBitmap(bitmap) {
    // Letterbox the frame inside the canvas (like <video>'s object-fit:
    // contain), centered, preserving the source aspect — so a host aligning
    // other elements to the video can compute the same rectangle. The track's
    // display rotation is applied here: cached bitmaps stay in coded
    // orientation, and the upright (display) aspect drives the letterbox.
    const cw = this.canvas.width, ch = this.canvas.height, ctx = this.context;
    if (!cw || !ch) return;   // pane not laid out yet; resizeCanvas will repaint
    ctx.clearRect(0, 0, cw, ch);
    const rotation = this.rotation || 0;
    const swapAxes = rotation === 90 || rotation === 270;
    const displayW = swapAxes ? bitmap.height : bitmap.width;
    const displayH = swapAxes ? bitmap.width : bitmap.height;
    const sourceAspect = displayW / displayH, paneAspect = cw / ch;
    let drawWidth, drawHeight;
    if (paneAspect > sourceAspect) { drawHeight = ch; drawWidth = ch * sourceAspect; }
    else { drawWidth = cw; drawHeight = cw / sourceAspect; }
    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    if (rotation) ctx.rotate(rotation * Math.PI / 180);
    // Inside the rotated frame the bitmap's own axes apply, so its draw box
    // is the display box with width/height swapped back when rotated 90/270.
    const bitmapDrawW = swapAxes ? drawHeight : drawWidth;
    const bitmapDrawH = swapAxes ? drawWidth : drawHeight;
    ctx.drawImage(bitmap, -bitmapDrawW / 2, -bitmapDrawH / 2, bitmapDrawW, bitmapDrawH);
    ctx.restore();
  }

  // Release the decoder and all cached bitmaps. Call when done with the
  // engine (e.g. closing the dialog that hosts it) — decoders are a limited
  // browser resource, so discarded engines must not wait for garbage
  // collection. The engine remains usable: load() creates a fresh decoder.
  destroy() { this._teardown(); }

  _teardown() {
    this.ready = false;
    this.playing = false;
    this.failed = false;
    if (this._videoDecoder) {
      try { this._videoDecoder.close(); } catch (e) { /* already closed */ }
      this._videoDecoder = null;
    }
    // Swap in a fresh cache map so any createImageBitmap still resolving from
    // the old session (see _absorb's cacheRef check) closes its bitmap instead
    // of populating the new clip's cache.
    for (const bitmap of this._cache.values()) bitmap.close();
    this._cache = new Map();
    this._pending.clear();
    this._driving = false;
    this._runKeyframe = -1;
    this._fedThrough = -1;
    this._drained = false;
    this._restartTarget = -1;
    this._restartCount = 0;
    this._stalledFrame = -1;
    this._byteBuffer = null;
    this._byteBufferStart = 0;
    this._lastBitmap = null;
    this._shownFrame = -1;
    this._hideError();
  }

  // Error display is the host page's job (it owns the DOM and any i18n):
  // detail.message is the human-readable reason, or null to clear a
  // previously shown error.
  _showError(message) {
    this.dispatchEvent(new CustomEvent('errormessage', { detail: { message } }));
  }
  _hideError() {
    this.dispatchEvent(new CustomEvent('errormessage', { detail: { message: null } }));
  }
}

// ==================================================================
// NativeVideoEngine — a <video> element behind the same surface as VideoEngine.
//
// Observational, not authoritative: the browser decides which frame is on
// screen and we find out afterwards. Two things make that good enough to
// annotate against.
//
// 1. The presented-frame clock. requestVideoFrameCallback hands us, for each
//    frame as it is presented, that frame's exact presentation timestamp
//    (`mediaTime`) and the wall-clock moment it appeared. video.currentTime is
//    unusable for frame mapping twice over: it keeps advancing through decoder
//    stalls (e.g. the restart when a looping clip wraps to 0) while the
//    displayed frame is frozen, which lets a synchronized overlay run away from
//    the pixels; and on iOS WebKit it only refreshes at coarse uneven
//    intervals, which makes between-frame motion jerky. So we extrapolate a
//    smooth playhead from the last presented frame using performance.now()
//    (which advances perfectly evenly), and clamp it to the hold interval of
//    the frame actually on screen — a no-op in steady playback, and during a
//    stall it pins the overlay to the visible frame, so motion degrades to
//    whole-frame steps but stays in sync with the equally stuttering video.
//
// 2. The container index, which is mandatory. `mediaTime` is an exact timestamp,
//    but turning a timestamp into a frame *index* needs the table of every
//    frame's PTS, which a <video> element never exposes. Given a ContainerIndex
//    we binary-search it and the index is exact on variable-frame-rate clips —
//    MP4 and WebM alike, which is the whole reason both are indexed. This engine
//    has no inexact mode to fall back to: load() requires both an index (built
//    here if the caller did not supply one) and the presented-frame clock, and
//    refuses the clip otherwise rather than report guessed frame numbers.
// ==================================================================
class NativeVideoEngine extends EventTarget {
  constructor(videoElement) {
    super();
    this.video = videoElement;
    this.ready = false;
    this.numFrames = 0;
    this.rotation = 0;
    // Latched true if the runtime watcher later catches the index disagreeing
    // with the frames the element presents during playback (see
    // _checkPresentedFrame). Mirrors VideoEngine.failed: the API stays functional
    // but frameIndexIsExact goes false and a fatal errormessage fires.
    this.failed = false;

    this._index = null;
    // Seconds to add to a container-index time to get a time on the element's
    // own timeline. Nonzero when the container carries an edit list or a
    // nonzero start time; calibrated at load (see _calibrateTimeOffset).
    this._timeOffset = 0;
    this._indexStrikes = 0;        // consecutive presented frames that missed the table

    this._loop = true;
    this._rate = 1;                // reapplied after each load (src reset clears it)
    this._objectUrl = null;

    // The presented-frame clock: the exact PTS of the frame currently on screen
    // and the wall-clock moment it was presented. Both stay null/0 until the
    // first frame presents. requestVideoFrameCallback is required (load() refuses
    // without it), so unlike VideoEngine there is no clockless mode here.
    this._presentedMediaTime = null;
    this._presentedAt = 0;
    this._presentWaiters = [];

    videoElement.muted = true;
    videoElement.playsInline = true;   // iOS: play inline, no auto-fullscreen
    videoElement.addEventListener('dblclick', (e) => e.preventDefault());

    // Reset the runtime index-vs-reality strike counter the instant a seek
    // begins: post-seek presented frames are not evidence against the table (see
    // _checkPresentedFrame). Registered once on the element so it cannot pile up
    // across load()s.
    videoElement.addEventListener('seeking', () => { this._indexStrikes = 0; });

    this.hasPresentedFrameClock = 'requestVideoFrameCallback' in videoElement;
    this._clockStopped = false;
    if (this.hasPresentedFrameClock) {
      this._onPresentedFrame = this._onPresentedFrame.bind(this);
      videoElement.requestVideoFrameCallback(this._onPresentedFrame);
    }
  }

  // The presented-frame callback re-registers itself, so it would outlive a
  // destroyed engine and keep a reference to it alive. There is no way to cancel
  // a pending requestVideoFrameCallback, so destroy() sets this and the callback
  // declines to re-register; load() starts it up again if it had stopped.
  _startPresentedFrameClock() {
    if (!this.hasPresentedFrameClock || !this._clockStopped) return;
    this._clockStopped = false;
    this.video.requestVideoFrameCallback(this._onPresentedFrame);
  }

  get displayElement() { return this.video; }
  get paused() { return this.video.paused; }
  play() { const p = this.video.play(); if (p) p.catch(() => {}); }
  pause() { this.video.pause(); }
  get playbackRate() { return this.video.playbackRate; }
  set playbackRate(rate) { this._rate = rate; this.video.playbackRate = rate; }
  get loop() { return this._loop; }
  set loop(value) { this._loop = value; this.video.loop = value; }

  // Upright display dimensions. The element applies the track's rotation
  // itself, so these already account for it — the same meaning VideoEngine's
  // videoWidth/videoHeight carry.
  get videoWidth() {
    return this.video.videoWidth || (this._index ? this._index.videoWidth : 0);
  }
  get videoHeight() {
    return this.video.videoHeight || (this._index ? this._index.videoHeight : 0);
  }

  get duration() {
    // The index's duration is the sum of the real frame durations, which is
    // what VideoEngine reports; fall back to the element's own.
    if (this._index) return this._index.duration;
    return this.video.duration || 0;
  }

  // Normalized to the content timeline (display frame 0 at t = 0), so that
  // currentTime, duration, frameAtTime and seekToFrame mean exactly what they
  // mean on VideoEngine and a host can swap one engine for the other blindly.
  get currentTime() { return this.video.currentTime - this._timeOffset; }
  set currentTime(t) {
    const clamped = Math.max(0, Math.min(this.duration, t));
    this.video.currentTime = clamped + this._timeOffset;
  }

  // What this engine got, for dev labels and host-side diagnostics. Always the
  // exact pairing now — the only native tier that exists.
  get tier() {
    return 'native (container index, presented clock)';
  }
  // Same contract as VideoEngine.codecString. Null when the index carries no
  // decoder configuration (WebM's does not).
  get codecString() {
    return (this._index && this._index.decoderConfig)
      ? this._index.decoderConfig.codec : null;
  }
  // Informational only, never a mapping input: the clip's average frame rate,
  // derived from the index (numFrames / duration). A host may show it; frame
  // indices come from the index's real per-frame timestamps, not from this.
  // Zero when the index is unavailable or reports no duration.
  get framesPerSecond() {
    if (!this._index || !this._index.duration) return 0;
    return this._index.numFrames / this._index.duration;
  }

  // Average frame duration in seconds, for slack/tolerance computations that need
  // a per-frame scale. Derived straight from the index and guarded against a zero
  // frame count so tolerances never blow up to Infinity.
  _averageFrameDuration() {
    if (!this._index || !this._index.numFrames) return 0;
    return this._index.duration / this._index.numFrames;
  }

  // The permanent invariant guard. True for every engine createBestEngine hands
  // back — it never returns an unindexed native engine. Goes false only if the
  // runtime watcher later catches the index disagreeing with the frames the
  // element actually presents during playback (see _checkPresentedFrame), which
  // also latches `failed` and fires a fatal errormessage.
  get frameIndexIsExact() { return this._index !== null && !this.failed; }

  frameAtTime(t) {
    return this._index.frameAtTime(t);
  }

  // Frame index + fraction, for a time on the *element's* timeline.
  _frameFloatAtVideoTime(videoSeconds) {
    return this._index.frameFloatAtTime(videoSeconds - this._timeOffset);
  }

  // The frame on screen, from its own presentation timestamp. Null until one has
  // been presented. Integer and exact, read from the container index.
  _presentedFrame() {
    if (this._presentedMediaTime === null) return null;
    const t = this._presentedMediaTime - this._timeOffset;
    return this._index.frameOfPresentedTime(t);
  }

  get currentFrameFloat() {
    // While paused, currentTime is exact and authoritative — a sub-frame seek
    // must land where it aimed. While playing, extrapolate from the last
    // presented frame instead (see the class comment).
    const smoothVideoTime = (this._presentedMediaTime === null || this.video.paused)
      ? this.video.currentTime
      : this._presentedMediaTime
        + (performance.now() - this._presentedAt) / 1000 * this.video.playbackRate;

    let frameFloat = this._frameFloatAtVideoTime(smoothVideoTime);

    const presented = this._presentedFrame();
    if (presented !== null) {
      // Clamp to the hold interval [P, P+1] of the frame actually on screen, so
      // the reported playhead can never run past the pixels — nor lag behind
      // them, which is what rescues the last frame of a clip: the element clamps
      // a seek there to its own duration, which can land a rounding error below
      // the frame's start, and only the presented frame says which frame that
      // really is.
      frameFloat = Math.max(presented, Math.min(presented + 1, frameFloat));
    }
    return Math.max(0, Math.min(Math.max(0, this.numFrames - 1), frameFloat));
  }

  get currentFrame() { return Math.floor(this.currentFrameFloat); }

  seekToFrame(n) {
    n = Math.max(0, Math.min(Math.max(0, this.numFrames - 1), n | 0));
    // Seek to the midpoint of the frame's display interval, not its start: the
    // start sits exactly on the boundary the browser rounds at, so aiming there
    // can land on frame n-1. The interval is the frame's real one, from the index.
    const midpoint = this._index.midpointOfFrame(n) + this._timeOffset;
    this.video.currentTime = midpoint;
  }

  // Best effort: seek to frame n and wait until it is the frame on screen.
  // Unlike VideoEngine.ensureFrame there is no decoded bitmap to hand back —
  // a <video> element cannot give you a frame you can name — so this only
  // guarantees the element has settled on it.
  async ensureFrame(frameIndex) {
    this.seekToFrame(frameIndex);
    const startedAt = performance.now();
    while (this.currentFrame !== frameIndex) {
      await new Promise((resolve) => setTimeout(resolve, 8));
      if (performance.now() - startedAt > 5000) throw new Error('seek timed out');
    }
  }

  // options.index: a ContainerIndex already built for this source (createBestEngine
  // builds one up front and hands the same one to whichever engine plays, so the
  // container is never parsed twice). Omit it and the engine builds its own. The
  // index is mandatory: this engine has no inexact mode without it. The import of
  // ContainerIndex is safe because the shipped bundle orders container-index
  // before this file (mirroring VideoEngine.load).
  async load(source, options = {}) {
    this._teardown();
    this._startPresentedFrameClock();   // in case a previous destroy() stopped it
    // Enforce item 1b's invariant at the engine level too, since a host can
    // construct a NativeVideoEngine directly rather than through createBestEngine.
    // Without requestVideoFrameCallback there is no exact presented-frame clock to
    // tell us which frame is on screen, and this engine no longer has any inexact
    // mapping to fall back to — so refuse rather than play inexactly.
    if (!this.hasPresentedFrameClock) {
      throw new Error('NativeVideoEngine: this browser lacks requestVideoFrameCallback, '
        + 'so there is no exact presented-frame clock and no inexact mode to fall back '
        + 'to. Use a current browser (Safari 15.4+, Firefox 132+, or any recent '
        + 'Chromium).');
    }
    try {
      this._index = options.index || await ContainerIndex.fromSource(source);
      this.numFrames = this._index.numFrames;
      this.rotation = this._index.rotation;

      // Gecko does not honor a trimming edit list: it presents the untrimmed
      // frames while reporting the trimmed duration, so the element shows frame
      // k where the table (and every other browser) shows frame k + trim. That
      // is a whole-frame shift, which no residual or duration check can see —
      // the shifted timestamps still land exactly on table entries — so it must
      // be refused up front, the same way the WebKit reachability guard below
      // refuses that browser's inconsistent trimmed timeline. The WebCodecs path
      // decodes the trim itself and plays it frame-exact on Firefox, so the auto
      // ladder still plays these clips there; only the native fallback refuses.
      if (this._index.trimmedByEditList && detectBrowserEngine() === 'gecko') {
        throw new Error('NativeVideoEngine: this browser (Gecko) presents a clip '
          + 'with a trimming edit list untrimmed, shifting every frame relative to '
          + 'the container\'s presentation window, so exact frame numbers are '
          + 'impossible on the native path. The clip is refused here rather than '
          + 'mislabeled; the WebCodecs path plays the trim frame-exact.');
      }

      await this._loadElement(source);

      // The container's frame table must describe the same content the element
      // presents; a trimming edit list makes it describe frames the element never
      // shows, which would shift every reported index. Refuse if so — but only
      // after the element's duration has settled (see the race handling inside).
      if (!(await this._indexDescribesElement())) {
        throw new Error('NativeVideoEngine: the container\'s frame table does not '
          + 'describe what this element presents — the element\'s duration is '
          + 'shorter, the signature of a trimming edit list that cuts frames the '
          + 'decoder still needs but never shows. Reporting frame numbers from the '
          + 'table would shift every index, so the clip is refused rather than '
          + 'played with wrong frame numbers.');
      }

      await this._calibrateTimeOffset();
      // WebKit runs currentTime on the MEDIA timeline for a trimming edit list (so
      // the calibrated offset is the trim) but reports the shorter EDITED duration,
      // which leaves the late frames past the end and unreachable — a seek to them
      // clamps. Trusting the index then would report exact frame numbers for frames
      // the element can never show, so refuse rather than be confidently wrong.
      // (Chromium keeps currentTime and duration on the same timeline, so this
      // never fires there and its trimmed clips play fine.)
      if (!this._calibratedTimelineReachable()) {
        throw new Error('NativeVideoEngine: the calibrated container timeline runs '
          + 'past what this element will seek to (an edit-list clip whose currentTime '
          + 'and duration disagree, seen on WebKit), so its late frames are '
          + 'unreachable. The clip is refused rather than played with frame numbers '
          + 'the element cannot reach.');
      }

      this.ready = true;
      this.dispatchEvent(new Event('loaded'));
    } catch (err) {
      console.error('NativeVideoEngine.load failed:', err);
      this._showError(err && err.message ? err.message : String(err));
      throw err;
    }
  }

  _loadElement(source) {
    const url = (typeof source === 'string')
      ? source : (this._objectUrl = URL.createObjectURL(source));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.video.removeEventListener('loadeddata', onLoaded);
        this.video.removeEventListener('error', onError);
      };
      const onLoaded = () => {
        cleanup();
        // Reassigning src resets playbackRate/loop to defaults; reapply.
        this.video.playbackRate = this._rate;
        this.video.loop = this._loop;
        resolve();
      };
      const onError = () => { cleanup(); reject(new Error('native <video> load failed')); };
      this.video.addEventListener('loadeddata', onLoaded);
      this.video.addEventListener('error', onError);
      this.video.src = url;
      this.video.load();
    });
  }

  // Does the sample table describe the same content the element will present?
  //
  // The calibration below anchors on "the first frame the element presents is
  // display frame 0 of the table". An edit list that trims into the middle of a
  // GOP breaks that: the samples before the trim point stay in the table (the
  // decoder needs them) but are never presented, so the first presented frame
  // is really frame k, and every index we report would be shifted by k. A
  // whole-frame shift is invisible to _checkPresentedFrame — a table shifted by
  // whole frames still has every mediaTime landing exactly on an entry — so it
  // has to be caught here or not at all.
  //
  // Durations are the tell. A shifting edit list (the common one: it
  // compensates for the composition offset B-frames introduce) leaves the
  // presented duration equal to the table's. A trimming one makes the element's
  // duration shorter by everything it cut, which is at least a GOP. Anything
  // beyond a couple of frames of container rounding, we do not trust the table.
  //
  // Async, and it rides out a known Chromium race before believing a
  // disagreement: right after 'loadeddata', video.duration for an edit-list clip
  // is transiently the (shorter) MEDIA duration and only later updates to the
  // longer edit-list-extended value (see the long note in
  // test/frame-index-test.mjs around MAX_ATTEMPTS). Under the old design this
  // race caused an occasional silent drop to the declared rate; now that a
  // disagreement is fatal, believing the transient would instead spuriously
  // REFUSE a perfectly good clip, which is unacceptable. So on an initial
  // disagreement we wait for the element's duration to settle and re-check,
  // throwing only if it still disagrees.
  async _indexDescribesElement() {
    const agrees = () => {
      const elementDuration = this.video.duration;
      if (!isFinite(elementDuration) || elementDuration <= 0) return true;
      const slack = 2 * this._averageFrameDuration();
      return Math.abs(this._index.duration - elementDuration) <= slack;
    };
    if (agrees()) return true;
    await this._waitForDurationToSettle(700);
    if (agrees()) return true;
    console.warn('NativeVideoEngine: the container\'s frame table spans '
      + `${this._index.duration.toFixed(3)}s but the element presents `
      + `${(this.video.duration || 0).toFixed(3)}s even after its duration `
      + 'settled, so the table describes frames the element never shows (a '
      + 'trimming edit list?).');
    return false;
  }

  // Wait until the element's reported duration stops changing, up to a timeout.
  // Resolves on the first 'durationchange' after now, or when a short poll sees
  // the value change, or on timeout — whichever comes first. Used only to ride
  // out the Chromium edit-list duration race above before judging agreement.
  _waitForDurationToSettle(timeoutMilliseconds) {
    return new Promise((resolve) => {
      const startDuration = this.video.duration;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.video.removeEventListener('durationchange', onChange);
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      };
      const onChange = () => finish();
      const poll = setInterval(() => {
        if (this.video.duration !== startDuration) finish();
      }, 50);
      const timer = setTimeout(finish, timeoutMilliseconds);
      this.video.addEventListener('durationchange', onChange);
    });
  }

  // Does the calibrated timeline stay within the range the element will seek to?
  //
  // Calibration anchors the first presented frame; this checks the far end. The
  // last frame's presentation time, shifted by the offset, must be a currentTime
  // the element can actually reach — i.e. within its duration. It usually is (the
  // offset is zero or the duration accommodates it), but a trimming edit list on
  // WebKit breaks the assumption: WebKit puts currentTime on the media timeline
  // (nonzero offset) yet reports the shorter edited duration, so the tail frames
  // sit past the end and clamp. A generous slack keeps the ordinary last-frame
  // rounding (which the presented-frame clamp already rescues) from tripping it.
  _calibratedTimelineReachable() {
    const elementDuration = this.video.duration;
    if (!isFinite(elementDuration) || elementDuration <= 0) return true;
    const n = this._index.numFrames;
    if (!n) return true;
    const lastFrameStart = this._index.presentationTimes[n - 1];
    const slack = 1.5 * this._averageFrameDuration();
    return this._timeOffset + lastFrameStart <= elementDuration + slack;
  }

  // Find the constant offset between the container index's timeline and the
  // element's own.
  //
  // The first frame the element presents after load is display frame 0, and
  // requestVideoFrameCallback reports its exact PTS on the element's timeline.
  // Our table puts frame 0 at t = 0 by construction, so that reported PTS *is*
  // the offset (it is nonzero when the container carries an edit list or a
  // nonzero start time). Anchoring on a frame whose identity we already know is
  // what makes this immune to whole-frame errors — a residual check alone
  // cannot catch those, because a table shifted by exactly one frame still has
  // every mediaTime landing precisely on an entry.
  async _calibrateTimeOffset() {
    const mediaTime = await this._nextPresentedMediaTime(2000);
    if (mediaTime === null) {
      // The presented-frame clock exists (load() refuses without it) but no frame
      // presented within the timeout — a transient, not a missing feature: an
      // autoplay-blocked or not-yet-painting element. The timelines coincide for
      // ordinary clips, so assume a zero offset, but say so, because an edit list
      // would then silently shift every frame number.
      console.warn('NativeVideoEngine: no presented frame within the calibration '
        + 'timeout; assuming the container timeline matches the element\'s. If this '
        + 'clip carries an edit list, frame numbers may be shifted until a frame '
        + 'presents.');
      this._timeOffset = 0;
      return;
    }
    this._timeOffset = mediaTime - this._index.presentationTimes[0];
  }

  // Resolves with the mediaTime of the next presented frame, or null if the
  // clock is unavailable or nothing presents within timeoutMilliseconds.
  _nextPresentedMediaTime(timeoutMilliseconds) {
    if (!this.hasPresentedFrameClock) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMilliseconds);
      this._presentWaiters.push(finish);
    });
  }

  _onPresentedFrame(now, metadata) {
    if (this._clockStopped) return;   // destroyed; stop the self-perpetuating loop
    this._presentedMediaTime = metadata.mediaTime;
    this._presentedAt = now;

    this._checkPresentedFrame();

    const waiters = this._presentWaiters;
    this._presentWaiters = [];
    for (const resolve of waiters) resolve(metadata.mediaTime);

    this.video.requestVideoFrameCallback(this._onPresentedFrame);
  }

  // A presented frame's mediaTime IS some frame's exact PTS, so once calibrated
  // it must land essentially on an entry of our table. Persistent misses DURING
  // PLAYBACK mean the table does not describe what the element is actually
  // presenting (a different track, or a container we mis-parsed), and indexing
  // from it would report confidently wrong frame numbers.
  //
  // Only playback frames count. We skip while the element is paused or seeking,
  // and the constructor's 'seeking' listener resets the strike counter, because
  // after a programmatic seek Firefox's requestVideoFrameCallback echoes the seek
  // TARGET rather than the presented frame's true presentation timestamp — so a
  // post-seek readback is not evidence against the table. During real playback
  // mediaTime is exact on every engine, so a sustained miss there is real. (This
  // deliberately replaces the old behavior, where Firefox's post-seek echoes
  // could deterministically knock out the index.)
  //
  // There is no fallback mapping to drop to anymore, so on strike-out we do NOT
  // null the index: we keep it in place so the API stays functional and let the
  // host decide what to do. Instead we latch `failed` (which turns
  // frameIndexIsExact false, mirroring VideoEngine) and fire a fatal errormessage.
  _checkPresentedFrame() {
    if (!this._index || this.failed) return;
    if (this.video.paused || this.video.seeking) return;
    const t = this._presentedMediaTime - this._timeOffset;
    const n = this._index.frameOfPresentedTime(t);
    const residual = Math.abs(t - this._index.presentationTimes[n]);
    const tolerance = 0.25
      * (this._index.frameDurations[n] || this._averageFrameDuration() || 1);
    if (residual <= tolerance) { this._indexStrikes = 0; return; }
    if (++this._indexStrikes < 5) return;   // tolerate a transient straggler
    this.failed = true;
    const message = 'This video\'s container index disagrees with the frames the '
      + 'element is presenting during playback, so its reported frame numbers can '
      + 'no longer be trusted.';
    console.warn('NativeVideoEngine: ' + message);
    this.dispatchEvent(new CustomEvent('errormessage', { detail: {
      message,
      fatal: true,
      inexact: true,
    } }));
  }

  update() {}          // the <video> element advances its own clock
  resizeCanvas() {}    // CSS object-fit handles letterboxing

  // Drop the element's decoded media and stop the presented-frame clock, rather
  // than wait for garbage collection. Like VideoEngine, the engine stays usable:
  // load() restarts both.
  destroy() {
    this._clockStopped = true;
    this._teardown();
    this.video.removeAttribute('src');
    this.video.load();
  }

  _teardown() {
    this.ready = false;
    try { this.video.pause(); } catch (e) { /* not loaded */ }
    if (this._objectUrl) { URL.revokeObjectURL(this._objectUrl); this._objectUrl = null; }
    // The previous clip's clock says nothing about the next one's.
    this._presentedMediaTime = null;
    this._presentedAt = 0;
    for (const resolve of this._presentWaiters) resolve(null);
    this._presentWaiters = [];
    this._index = null;
    this._timeOffset = 0;
    this._indexStrikes = 0;
    this.failed = false;
    this._hideError();
  }

  _showError(message) {
    this.dispatchEvent(new CustomEvent('errormessage', { detail: { message } }));
  }
  _hideError() {
    this.dispatchEvent(new CustomEvent('errormessage', { detail: { message: null } }));
  }
}

// ==================================================================
// createBestEngine — walk the ladder and return a loaded engine.
//
// The container index is built once, up front, and handed to whichever engine
// ends up playing: it is what WebCodecs decodes from, and it is also what gives
// the <video> path exact per-frame timestamps. So it is worth building even when
// WebCodecs is nowhere in sight, and it is never built twice. An index is
// mandatory: a container we cannot index is refused, since this engine reports
// only true frame indices, never inferred ones.
//
//   createBestEngine(source, {canvas, video})  ->  VideoEngine | NativeVideoEngine
//
// The returned engine is loaded and ready. `engine.displayElement` is the one of
// the two elements the host should show; `engine.tier` says what it got, and
// `engine.frameIndexIsExact` whether frame numbers can be trusted absolutely.
// ==================================================================
async function createBestEngine(source, options = {}) {
  const {
    canvas = null,
    video = null,
    // 'auto' (default) tries WebCodecs first; 'native' skips it; 'webcodecs'
    // still falls back if WebCodecs cannot play the clip — there is no point
    // refusing to show a video the browser can play perfectly well.
    prefer = 'auto',
    // Passed through to VideoEngine; ignored by the <video> element, which does
    // its own buffering. See the VideoEngine constructor.
    windowAhead,
    // How long the WebM index is allowed to take. Building it means reading the
    // whole file (Matroska keeps no central sample table), which is quick from
    // disk and as slow as the network from a URL — so it gets a deadline. A clip
    // that blows through it is now REFUSED (the throw below) rather than played
    // with guessed frame numbers; the index cache (added separately) is what
    // softens the repeat-visit cost of a full-file parse. Infinity to let it run
    // as long as it needs; indexMaxBytes refuses outsized files before reading a
    // byte of them. Neither touches the MP4 path, which is a few range reads
    // either way.
    indexTimeoutMilliseconds = 10000,
    indexMaxBytes = Infinity,
    // Called ~once per megabyte while a WebM is being indexed (the one pass long
    // enough to be worth showing), and once more at 100% when it finishes, with
    // a progress report: { bytesRead, totalBytes, fraction, elapsedMs, etaMs,
    // framesFound }. formatProgress() turns one into "Indexing… 42% (~8s left)".
    // An MP4's index is a few range reads however long the clip is, so it emits
    // no ticks — drive a bar's visibility off this promise and let onProgress
    // fill in the WebM case. Ignored when a prebuilt index is passed in.
    onProgress,
    // A caller that has already built the index for this source passes it here,
    // so the moov is not parsed twice. Passing null means "already tried, not
    // available" — which is different from leaving it out, which means "build it
    // for me". A host that wants to report whether the container could be indexed
    // needs that distinction.
    index: providedIndex,
  } = options;

  let index = (providedIndex !== undefined) ? providedIndex : null;
  // The build error, kept so the refusal below can name what actually went wrong
  // (an unsupported container, mp4box.js absent, or the WebM pass timing out).
  let indexBuildError = null;
  if (providedIndex === undefined) {
    try {
      index = await ContainerIndex.fromSource(source, {
        timeoutMilliseconds: indexTimeoutMilliseconds,
        maxBytes: indexMaxBytes,
        onProgress,
      });
    } catch (err) {
      indexBuildError = err;
    }
  }

  // Index or refuse. Every engine this function returns reports true per-frame
  // indices read from the container, never numbers inferred from an assumed
  // frame rate — so a container we could not index has no engine we are willing
  // to hand back. This fires when the build failed above or when the caller
  // explicitly passed index: null. A WebM whose indexing pass exceeded
  // indexTimeoutMilliseconds lands here too: it now refuses rather than falling
  // back to a declared rate, and the index cache (added separately) is what
  // softens the cost the next time the same clip is opened.
  if (!index) {
    let message = 'createBestEngine: no index could be built for this container; '
      + 'it is not a format we can index (supported: MP4/MOV, WebM/MKV, and Ogg). '
      + 'Without a per-frame timestamp table there is no way to report exact frame '
      + 'numbers, so this clip is refused rather than played with guesses.';
    if (indexBuildError && indexBuildError.message) {
      message += ` (underlying error: ${indexBuildError.message})`;
    }
    throw new Error(message);
  }

  // Proactively route away from WebCodecs for combinations it is known to
  // accept and then fail on mid-stream (WebKit + 10-bit HEVC — the iPhone HDR
  // default). Left to the normal ladder, isConfigSupported() and the frame-0
  // decode both pass, so the load-time fallback below never fires and the user
  // gets a hard crash a second or two into playback. The <video> element plays
  // the same clip fine, and the index still makes it frame-exact. This is the
  // proactive half of the mid-stream-death handling; VideoEngine's fatal
  // errormessage remains the reactive net for anything this table does not name.
  const codec = index && index.decoderConfig && index.decoderConfig.codec;
  const webCodecsUnreliable = webCodecsMayFailMidStream(codec, detectBrowserEngine());
  if (webCodecsUnreliable && prefer !== 'native') {
    console.info('exact-video-engine: routing this clip to the native <video> '
      + `element up front — ${codec} on this browser passes WebCodecs support `
      + 'checks and then dies mid-stream. The container index keeps it '
      + 'frame-exact.');
  }

  if (prefer !== 'native' && !webCodecsUnreliable
      && canvas && index && index.supportsWebCodecs
      && typeof VideoDecoder !== 'undefined') {
    const engine = new VideoEngine(canvas, { windowAhead });
    try {
      await engine.load(source, { index });
      return engine;
    } catch (err) {
      // Container parsed but the codec will not decode here (an unsupported
      // profile, or a browser with a partial WebCodecs). The element may well
      // play it natively, and we keep the exact index either way.
      engine.destroy();
      console.warn('exact-video-engine: WebCodecs could not play this clip; '
        + 'falling back to the native <video> element.', err);
    }
  }

  if (!video) {
    throw new Error('createBestEngine: no <video> element supplied to fall back to');
  }

  // The native <video> path reads which frame is on screen out of
  // requestVideoFrameCallback's presented-frame clock, whose mediaTime is the
  // exact presentation timestamp of the displayed frame. Without that clock there
  // is no way to know which indexed frame the element is actually showing (raw
  // currentTime keeps advancing through decoder stalls while the picture is
  // frozen, and refreshes at coarse uneven intervals on older WebKit), so a
  // perfect index is not enough — refuse rather than report inexact frame
  // numbers. This gate is only on the native fallback: the WebCodecs path above
  // owns its own clock and needs no requestVideoFrameCallback, so it is never
  // gated on it.
  if (!('requestVideoFrameCallback' in video)) {
    throw new Error('createBestEngine: this browser lacks requestVideoFrameCallback, '
      + 'which the exact native <video> path requires to know which frame is on '
      + 'screen. Please use a current browser (Safari 15.4+, Firefox 132+, or any '
      + 'recent Chromium).');
  }

  const engine = new NativeVideoEngine(video);
  await engine.load(source, { index });
  return engine;
}
