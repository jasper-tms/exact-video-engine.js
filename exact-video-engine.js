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
// the moof fragments for fragmented MP4, the clusters for WebM, the pages for
// Ogg, and the idx1 / OpenDML index for AVI. Either way the same table goes to
// whichever engine ends up playing
// (see ContainerIndex), and a full-file pass worth caching lands in IndexedDB
// so it is paid once per clip (see index-cache). That is what makes the
// <video> path frame-exact on variable-frame-rate clips rather than merely
// close.
//
// createBestEngine() picks the best available combination for a given clip and
// browser, choosing between two exact tiers and otherwise refusing:
//
//   1. container index + WebCodecs   exact index, exact decode, owned clock
//                                    (MP4, AVI, and WebM/MKV whose codec we can
//                                    configure; Ogg's index carries timestamps
//                                    but no sample table to decode from)
//   2. container index + <video>     exact index, browser decode + presentation
//                                    (MP4, WebM/MKV, Ogg), read out through the
//                                    presented-frame clock (requestVideoFrameCallback)
//
// AVI is the one container that lives ONLY in tier 1: browsers do not reliably
// play AVI through a <video> element (Chromium and Firefox refuse it outright), so
// AVI gets no tier-2 fallback. That is why an AVI whose codec WebCodecs cannot
// decode is refused rather than handed to a <video> element that would (on most
// browsers) reject it too, while a Matroska track we cannot configure simply
// stays on tier 2. AVI's H.264 is stored Annex B but decoded in AVCC mode:
// WebKit's WebCodecs claims to support Annex B and then fails the decode, so the
// sample table's bytes are converted to length-prefixed AVCC (see src/avi.js) —
// the one form every engine decodes. Matroska needs none of that: it stores
// H.264 and HEVC length-prefixed already, with the parameter sets in
// CodecPrivate.
//
// There is no third tier. A clip whose container we cannot index, or a native-path
// browser with no requestVideoFrameCallback (so no exact presented-frame clock),
// is refused with a clear error rather than played with guessed frame numbers.
// This engine is the *exact* one: an engine it hands back always reports true
// frame indices, never inferred ones.
//
// That rule holds at the level of the frame, not the file, and the difference
// matters once an index can be published while it is still being built (see
// createBestEngine's playWhileIndexing, and the certified-prefix note in
// container-index):
//
//   Every frame number this library reports is exact and PERMANENT. The set of
//   frames it is willing to report grows.
//
// So display indices are append-only and immutable. A frame is published only
// once no frame still to be read can present before it, because a host may
// already have written an annotation against frame 412 — and 412 coming to mean
// a different picture later would be exactly the silent off-by-one this library
// exists to prevent, worse than refusing the clip outright.
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
// Read priority — keep a bulk scan out of the way of a read someone is waiting on.
//
// Once an index can be published in certified prefixes, two readers are on the
// same source at the same time: the sequential pass streaming the rest of the
// container, and the decoder fetching the bytes of a frame near the playhead.
// They never want the same bytes — the playhead trails the scanner, so whatever
// the decoder asks for went past the scanner long ago — which is why there is no
// shared chunk cache here. Caching would miss every time.
//
// What they do compete for is bandwidth, and they are not equally urgent: a
// viewer is waiting on the decoder's read, and nobody is waiting on the scan's.
// So the scan asks here before taking its next chunk, and waits while any urgent
// read is outstanding. That is the whole mechanism: no queue, no cancellation,
// no priorities beyond "someone is waiting" and "nobody is".
//
// Deliberately a module-level counter rather than an object threaded through
// every call: the thing being shared is the network, which is global, and a host
// playing two clips at once wants the same courtesy between them.
// ==================================================================

// How many latency-critical reads are in flight right now.
let priorityReadsInFlight = 0;
// Resolvers for scans parked in awaitPriorityReadsQuiet, released together when
// the last urgent read lands.
let quietWaiters = [];
// A scan is never parked longer than this, however busy the playhead is. A host
// that scrubs continuously would otherwise starve the pass forever, and an index
// that never finishes is worse than one that shares the pipe.
const MAXIMUM_YIELD_MILLISECONDS = 250;

// Bracket a read the user is waiting on. Always pair these — a `finally` — or a
// failed read leaves the scan parked until the timeout above rescues it.
function beginPriorityRead() {
  priorityReadsInFlight += 1;
}

function endPriorityRead() {
  priorityReadsInFlight = Math.max(0, priorityReadsInFlight - 1);
  if (priorityReadsInFlight === 0 && quietWaiters.length) {
    const waiting = quietWaiters;
    quietWaiters = [];
    for (const resolve of waiting) resolve();
  }
}

// Wait for the urgent reads to land, up to MAXIMUM_YIELD_MILLISECONDS. Resolves
// immediately — without touching the event loop — when there are none, so a scan
// with no engine alongside it pays nothing for this call.
function awaitPriorityReadsQuiet() {
  if (priorityReadsInFlight === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, MAXIMUM_YIELD_MILLISECONDS);
    quietWaiters.push(finish);
  });
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
// new required field, a changed representation) — or to what a given container's
// payload MEANS. A stored payload whose schemaVersion does not match is treated
// as a miss, so an old entry from a previous build can never be hydrated into a
// struct it no longer fits.
//
// 2: Matroska indexes gained a sample table and a decoderConfig. Version 1
//    entries for a WebM/MKV are structurally valid but semantically stale — they
//    carry timestamps alone, which would pin a cached clip to the <video> tier
//    forever while a freshly built index of the same file plays through
//    WebCodecs. A miss and a rebuild is the honest answer.
const INDEX_CACHE_SCHEMA_VERSION = 2;

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
    // ({offset, size, isSync, cts, duration}), or null for an index that has
    // timestamps but no sample table (Ogg). Stored as-is either way.
    samples: index.samples,
    keyframeDecodeIndices: index.keyframeDecodeIndices,
    decoderConfig,
    rotation: index.rotation,
    videoWidth: index.videoWidth,
    videoHeight: index.videoHeight,
    numFrames: index.numFrames,
    duration: index.duration,
    trimmedByEditList: index.trimmedByEditList,
    // Whether the sample bytes are Annex B (AVI's H.264) and need converting to
    // AVCC in the decode path. False for every other container we index —
    // ISOBMFF and Matroska both store length-prefixed samples.
    samplesAreAnnexB: index.samplesAreAnnexB,
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
  index.samplesAreAnnexB = !!payload.samplesAreAnnexB;

  // microsToDisplay is rebuilt, not stored: it is a Map from a sample's
  // composition time (in whole microseconds) to its display index, and it only
  // exists for an ISOBMFF index that has a sample table. Rebuild it exactly as
  // container-index.js's _buildTables does — key Math.round(cts * 1e6 /
  // timescale), value the display index — so a hydrated index answers
  // microsToDisplay lookups identically to a freshly-built one. An index with no
  // sample table (Ogg) keeps microsToDisplay null, matching the freshly-built
  // shape.
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
// How far a codec is allowed to reorder frames, read out of the bitstream's own
// sequence parameter set.
//
// WHY THIS EXISTS. A container that stores frames in decode order cannot publish
// a frame's display number until it knows that no frame still unread can present
// before it. Matroska proves almost nothing about that on its own: a block's
// timestamp is its cluster's plus a SIGNED 16-BIT offset, so the only bound the
// container itself gives is that window — 32768 ticks, 32.8 seconds at the
// default 1 ms timestamp scale. Waiting out 32.8 seconds of content before
// naming a single frame is correct and nearly useless.
//
// The bitstream is far less coy. H.264's `max_num_reorder_frames` and HEVC's
// `sps_max_num_reorder_pics` state exactly this quantity, in frames:
//
//   the greatest number of frames that may precede a frame in decode order and
//   follow it in presentation order
//
// Typical real-world values are 0 (no B-frames at all), 1, or 2 — so a bound of
// a handful of frames replaces a bound of half a minute.
//
// WHY IT IS A FACT AND NOT A GUESS. This is not an observation about how muxers
// usually behave, which is the kind of thing this library refuses to lean on. It
// is a field the encoder wrote into the stream describing the stream, in the
// same setup record whose profile and level we already trust to build the codec
// string a decoder is configured from. A stream that violates it is malformed,
// and the certified-prefix invariant in container-index.js catches that case
// outright rather than silently mis-numbering frames.
//
// Where H.264 omits the field — it lives in the optional VUI, and plenty of
// encoders write no VUI at all — the specification says to infer it, and the
// inference is itself a hard limit rather than a habit: a conforming stream can
// never reorder by more than its level's decoded-picture-buffer capacity. So
// there is an answer for every readable H.264 stream, and `null` is reserved for
// a record we genuinely cannot parse.

// Ceiling on decoded-picture-buffer size, in macroblocks, per H.264 level
// (ITU-T H.264 Table A-1). A level bounds the DPB in macroblocks rather than in
// frames, so the frame count depends on the picture size as well.
const H264_MAX_DECODED_PICTURE_BUFFER_MACROBLOCKS = new Map([
  [10, 396], [11, 900], [12, 2376], [13, 2376],
  [20, 2376], [21, 4752], [22, 8100],
  [30, 8100], [31, 18000], [32, 20480],
  [40, 32768], [41, 32768], [42, 34816],
  [50, 110400], [51, 184320], [52, 184320],
  [60, 696320], [61, 696320], [62, 696320],
]);

// The profiles for which constraint_set3_flag means "this stream does not
// reorder at all" (H.264 §E.2.1, the max_num_reorder_frames inference).
const H264_CONSTRAINED_PROFILES = new Set([44, 86, 100, 110, 122, 244]);

// The profiles whose sequence parameter set carries the chroma format, bit
// depths and scaling matrices that Baseline and Main do not (H.264 §7.3.2.1.1).
const H264_PROFILES_WITH_CHROMA_FORMAT = new Set([
  100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
]);

// The NAL unit type of an HEVC sequence parameter set (ITU-T H.265 Table 7-1).
const HEVC_SEQUENCE_PARAMETER_SET_NAL_TYPE = 33;

// The greatest number of frames that may precede a frame in decode order and
// follow it in presentation order, read from a codec setup record, or null when
// the record cannot be read.
//
// setupRecordKind is 'avcC' or 'hvcC'; setupRecordBytes is that record's body —
// the bytes Matroska stores in CodecPrivate and an MP4 stores in the box of the
// same name. Any other codec returns null: there is no such declaration in a VP8
// or VP9 stream (neither reorders, which callers establish another way) and none
// in an AV1 sequence header either.
function declaredFrameReorderDepth(setupRecordKind, setupRecordBytes) {
  if (!setupRecordBytes || !setupRecordBytes.length) return null;
  try {
    if (setupRecordKind === 'avcC') return h264ReorderDepth(setupRecordBytes);
    if (setupRecordKind === 'hvcC') return hevcReorderDepth(setupRecordBytes);
  } catch (parseError) {
    // A record we cannot walk tells us nothing, and guessing at a reorder bound
    // is precisely the thing that would corrupt frame numbers. The caller falls
    // back to whatever its container proves on its own.
    return null;
  }
  return null;
}

// ==================================================================
// H.264
// ==================================================================

// avcC (ISO 14496-15 §5.3.3.1): a fixed 6-byte head, then a count of sequence
// parameter sets and each one's length and bytes.
function h264ReorderDepth(avcC) {
  if (avcC.length < 8) return null;
  const sequenceParameterSetCount = avcC[5] & 0x1F;
  if (!sequenceParameterSetCount) return null;
  const length = (avcC[6] << 8) | avcC[7];
  if (avcC.length < 8 + length || length < 2) return null;
  // Skip the one-byte NAL header; what follows is the sequence parameter set.
  const rawByteSequence =
    removeEmulationPrevention(avcC.subarray(9, 8 + length));
  return h264ReorderDepthFromSequenceParameterSet(rawByteSequence);
}

// Walk an H.264 sequence parameter set (ITU-T H.264 §7.3.2.1.1) as far as the
// VUI's max_num_reorder_frames, or to the end if the stream carries no VUI —
// in which case the specification's own inference applies (§E.2.1).
//
// Every field before the one we want has to be read rather than skipped: they
// are variable-length, so there is no seeking past them.
function h264ReorderDepthFromSequenceParameterSet(rawByteSequence) {
  const bits = new BitstreamReader(rawByteSequence);
  const profileIdc = bits.readBits(8);
  const constraintFlags = bits.readBits(8);
  const constraintSet3Flag = (constraintFlags >> 4) & 1;
  const levelIdc = bits.readBits(8);
  bits.readUnsignedExpGolomb();                       // seq_parameter_set_id

  let chromaFormatIdc = 1;
  if (H264_PROFILES_WITH_CHROMA_FORMAT.has(profileIdc)) {
    chromaFormatIdc = bits.readUnsignedExpGolomb();
    if (chromaFormatIdc === 3) bits.readBits(1);      // separate_colour_plane_flag
    bits.readUnsignedExpGolomb();                     // bit_depth_luma_minus8
    bits.readUnsignedExpGolomb();                     // bit_depth_chroma_minus8
    bits.readBits(1);                        // qpprime_y_zero_transform_bypass
    if (bits.readBits(1)) {                  // seq_scaling_matrix_present_flag
      const listCount = (chromaFormatIdc !== 3) ? 8 : 12;
      for (let i = 0; i < listCount; i++) {
        if (bits.readBits(1)) skipScalingList(bits, i < 6 ? 16 : 64);
      }
    }
  }

  bits.readUnsignedExpGolomb();                       // log2_max_frame_num_minus4
  const pictureOrderCountType = bits.readUnsignedExpGolomb();
  if (pictureOrderCountType === 0) {
    bits.readUnsignedExpGolomb();               // log2_max_pic_order_cnt_lsb_minus4
  } else if (pictureOrderCountType === 1) {
    bits.readBits(1);                           // delta_pic_order_always_zero_flag
    bits.readSignedExpGolomb();                 // offset_for_non_ref_pic
    bits.readSignedExpGolomb();                 // offset_for_top_to_bottom_field
    const cycleLength = bits.readUnsignedExpGolomb();
    for (let i = 0; i < cycleLength; i++) bits.readSignedExpGolomb();
  }

  bits.readUnsignedExpGolomb();                       // max_num_ref_frames
  bits.readBits(1);                        // gaps_in_frame_num_value_allowed_flag
  const pictureWidthInMacroblocks = bits.readUnsignedExpGolomb() + 1;
  const pictureHeightInMapUnits = bits.readUnsignedExpGolomb() + 1;
  const frameMacroblocksOnlyFlag = bits.readBits(1);
  if (!frameMacroblocksOnlyFlag) bits.readBits(1);   // mb_adaptive_frame_field_flag
  bits.readBits(1);                                  // direct_8x8_inference_flag
  if (bits.readBits(1)) {                            // frame_cropping_flag
    for (let i = 0; i < 4; i++) bits.readUnsignedExpGolomb();
  }

  // A frame is two field-heights tall unless the stream is frames-only.
  const frameHeightInMacroblocks =
    (2 - frameMacroblocksOnlyFlag) * pictureHeightInMapUnits;

  // Everything this field counts is measured in FRAMES. A field-coded stream
  // can put two fields where a caller counts one picture, so the bound would no
  // longer line up with what the caller is counting. Rather than reason about
  // which of those two a container's frames are, decline: an unknown bound
  // costs a caller its tighter watermark, and a wrong one costs it correctness.
  if (!frameMacroblocksOnlyFlag) return null;

  if (bits.readBits(1)) {                     // vui_parameters_present_flag
    const declared = h264ReorderDepthFromVideoUsability(bits);
    if (declared !== null) return declared;
  }

  // No VUI, or a VUI that stops before the bitstream restrictions: fall back to
  // the inference the specification itself defines.
  if (H264_CONSTRAINED_PROFILES.has(profileIdc) && constraintSet3Flag) return 0;
  return h264MaximumDecodedPictureBufferFrames(
    profileIdc, constraintSet3Flag, levelIdc,
    pictureWidthInMacroblocks, frameHeightInMacroblocks);
}

// The VUI (H.264 Annex E), read only as far as bitstream_restriction_flag.
// Returns the declared value, or null when the stream declares no restrictions.
function h264ReorderDepthFromVideoUsability(bits) {
  if (bits.readBits(1)) {                     // aspect_ratio_info_present_flag
    const aspectRatioIdc = bits.readBits(8);
    if (aspectRatioIdc === 255) bits.readBits(32);      // sar_width, sar_height
  }
  if (bits.readBits(1)) bits.readBits(1);     // overscan_info / overscan_appropriate
  if (bits.readBits(1)) {                     // video_signal_type_present_flag
    bits.readBits(4);                         // video_format, video_full_range_flag
    if (bits.readBits(1)) bits.readBits(24);  // the three colour description bytes
  }
  if (bits.readBits(1)) {                     // chroma_loc_info_present_flag
    bits.readUnsignedExpGolomb();
    bits.readUnsignedExpGolomb();
  }
  if (bits.readBits(1)) {                     // timing_info_present_flag
    bits.readBits(32);                        // num_units_in_tick
    bits.readBits(32);                        // time_scale
    bits.readBits(1);                         // fixed_frame_rate_flag
  }
  const nalHypotheticalReferenceDecoder = bits.readBits(1);
  if (nalHypotheticalReferenceDecoder) skipHypotheticalReferenceDecoder(bits);
  const videoCodingHypotheticalReferenceDecoder = bits.readBits(1);
  if (videoCodingHypotheticalReferenceDecoder) skipHypotheticalReferenceDecoder(bits);
  if (nalHypotheticalReferenceDecoder || videoCodingHypotheticalReferenceDecoder) {
    bits.readBits(1);                         // low_delay_hrd_flag
  }
  bits.readBits(1);                           // pic_struct_present_flag
  if (!bits.readBits(1)) return null;         // bitstream_restriction_flag

  bits.readBits(1);              // motion_vectors_over_pic_boundaries_flag
  bits.readUnsignedExpGolomb();  // max_bytes_per_pic_denom
  bits.readUnsignedExpGolomb();  // max_bits_per_mb_denom
  bits.readUnsignedExpGolomb();  // log2_max_mv_length_horizontal
  bits.readUnsignedExpGolomb();  // log2_max_mv_length_vertical
  return bits.readUnsignedExpGolomb();               // max_num_reorder_frames
}

function skipHypotheticalReferenceDecoder(bits) {
  const codedPictureBufferCount = bits.readUnsignedExpGolomb() + 1;
  bits.readBits(8);                           // bit_rate_scale, cpb_size_scale
  for (let i = 0; i < codedPictureBufferCount; i++) {
    bits.readUnsignedExpGolomb();             // bit_rate_value_minus1
    bits.readUnsignedExpGolomb();             // cpb_size_value_minus1
    bits.readBits(1);                         // cbr_flag
  }
  bits.readBits(20);      // the four delay-length fields, five bits each
}

function skipScalingList(bits, entryCount) {
  let lastScale = 8;
  let nextScale = 8;
  for (let i = 0; i < entryCount; i++) {
    if (nextScale !== 0) {
      const deltaScale = bits.readSignedExpGolomb();
      nextScale = (lastScale + deltaScale + 256) % 256;
    }
    if (nextScale !== 0) lastScale = nextScale;
  }
}

// How many frames this stream's level lets the decoded picture buffer hold
// (H.264 §A.3.1). A stream can never reorder by more than this, so it is a
// legitimate — if loose — bound where the encoder declared none.
function h264MaximumDecodedPictureBufferFrames(
  profileIdc, constraintSet3Flag, levelIdc,
  pictureWidthInMacroblocks, frameHeightInMacroblocks
) {
  // Level 1b is written as level_idc 11 with constraint_set3_flag set, on the
  // profiles where that flag is not the "no reordering" signal handled above.
  const isLevel1b = levelIdc === 11 && constraintSet3Flag
    && (profileIdc === 66 || profileIdc === 77 || profileIdc === 88);
  const macroblocks = isLevel1b
    ? 396 : H264_MAX_DECODED_PICTURE_BUFFER_MACROBLOCKS.get(levelIdc);
  if (!macroblocks) return null;
  const macroblocksPerFrame = pictureWidthInMacroblocks * frameHeightInMacroblocks;
  if (!macroblocksPerFrame) return null;
  return Math.min(Math.floor(macroblocks / macroblocksPerFrame), 16);
}

// ==================================================================
// HEVC
// ==================================================================

// hvcC (ISO 14496-15 §8.3.3.1): a 22-byte head, then arrays of parameter-set
// NAL units grouped by type. The sequence parameter set is type 33.
function hevcReorderDepth(hvcC) {
  if (hvcC.length < 23) return null;
  let at = 22;
  const arrayCount = hvcC[at++];
  for (let array = 0; array < arrayCount; array++) {
    if (at + 3 > hvcC.length) return null;
    const nalUnitType = hvcC[at] & 0x3F;
    const nalUnitCount = (hvcC[at + 1] << 8) | hvcC[at + 2];
    at += 3;
    for (let unit = 0; unit < nalUnitCount; unit++) {
      if (at + 2 > hvcC.length) return null;
      const length = (hvcC[at] << 8) | hvcC[at + 1];
      at += 2;
      if (at + length > hvcC.length) return null;
      if (nalUnitType === HEVC_SEQUENCE_PARAMETER_SET_NAL_TYPE && length > 2) {
        // Skip the two-byte NAL header.
        return hevcReorderDepthFromSequenceParameterSet(
          removeEmulationPrevention(hvcC.subarray(at + 2, at + length)));
      }
      at += length;
    }
  }
  return null;
}

// Walk an HEVC sequence parameter set (ITU-T H.265 §7.3.2.2.1) to
// sps_max_num_reorder_pics. Unlike H.264 this field is mandatory and sits early,
// so the only real work is stepping over profile_tier_level.
function hevcReorderDepthFromSequenceParameterSet(rawByteSequence) {
  const bits = new BitstreamReader(rawByteSequence);
  bits.readBits(4);                                   // sps_video_parameter_set_id
  const maximumSubLayersMinusOne = bits.readBits(3);
  bits.readBits(1);                                // sps_temporal_id_nesting_flag
  skipProfileTierLevel(bits, maximumSubLayersMinusOne);
  bits.readUnsignedExpGolomb();                       // sps_seq_parameter_set_id
  const chromaFormatIdc = bits.readUnsignedExpGolomb();
  if (chromaFormatIdc === 3) bits.readBits(1);     // separate_colour_plane_flag
  bits.readUnsignedExpGolomb();                       // pic_width_in_luma_samples
  bits.readUnsignedExpGolomb();                      // pic_height_in_luma_samples
  if (bits.readBits(1)) {                             // conformance_window_flag
    for (let i = 0; i < 4; i++) bits.readUnsignedExpGolomb();
  }
  bits.readUnsignedExpGolomb();                       // bit_depth_luma_minus8
  bits.readUnsignedExpGolomb();                       // bit_depth_chroma_minus8
  bits.readUnsignedExpGolomb();               // log2_max_pic_order_cnt_lsb_minus4
  const perSubLayer = bits.readBits(1);
  // The bound that matters is the one for the highest temporal sub-layer, which
  // is the last entry written — every frame the file presents is in it.
  let reorderDepth = null;
  for (let i = perSubLayer ? 0 : maximumSubLayersMinusOne;
       i <= maximumSubLayersMinusOne; i++) {
    bits.readUnsignedExpGolomb();            // sps_max_dec_pic_buffering_minus1
    reorderDepth = bits.readUnsignedExpGolomb();      // sps_max_num_reorder_pics
    bits.readUnsignedExpGolomb();            // sps_max_latency_increase_plus1
  }
  return reorderDepth;
}

// profile_tier_level (H.265 §7.3.3), with profilePresentFlag always 1 as it is
// when called from a sequence parameter set. Nothing in it is needed here; the
// point is to land on the bit after it.
function skipProfileTierLevel(bits, maximumSubLayersMinusOne) {
  bits.skipBits(88);                     // the general profile and constraint block
  bits.readBits(8);                      // general_level_idc
  const profilePresent = [];
  const levelPresent = [];
  for (let i = 0; i < maximumSubLayersMinusOne; i++) {
    profilePresent.push(bits.readBits(1));
    levelPresent.push(bits.readBits(1));
  }
  if (maximumSubLayersMinusOne > 0) {
    bits.skipBits(2 * (8 - maximumSubLayersMinusOne));   // reserved_zero_2bits
  }
  for (let i = 0; i < maximumSubLayersMinusOne; i++) {
    if (profilePresent[i]) bits.skipBits(88);
    if (levelPresent[i]) bits.readBits(8);
  }
}

// ==================================================================
// Bitstream plumbing
// ==================================================================

// A NAL unit's payload has 0x03 stuffed into it wherever the encoded bytes would
// otherwise have spelled a start code (00 00 00/01/02/03). Undo that to get the
// raw byte sequence the syntax above is written against.
function removeEmulationPrevention(bytes) {
  // Nothing to undo in the common case; do not allocate for it.
  let stuffed = 0;
  for (let i = 2; i < bytes.length; i++) {
    if (bytes[i] === 0x03 && bytes[i - 1] === 0 && bytes[i - 2] === 0) stuffed++;
  }
  if (!stuffed) return bytes;
  const out = new Uint8Array(bytes.length - stuffed);
  let written = 0;
  let zeroRun = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (zeroRun === 2 && bytes[i] === 0x03) { zeroRun = 0; continue; }
    zeroRun = (bytes[i] === 0) ? zeroRun + 1 : 0;
    out[written++] = bytes[i];
  }
  return out.subarray(0, written);
}

// Most-significant-bit-first reader with the two exponential-Golomb forms the
// H.264 and H.265 syntax are written in. Running off the end throws, which the
// entry point turns into "this record cannot be read" — never into a guess.
class BitstreamReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.position = 0;
    this.bitCount = bytes.length * 8;
  }

  readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i++) {
      if (this.position >= this.bitCount) throw new RangeError('bitstream ended');
      const bit = (this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1;
      // Multiplication rather than a shift: 32-bit fields would otherwise turn
      // negative, and every value here is small enough to stay exact.
      value = value * 2 + bit;
      this.position++;
    }
    return value;
  }

  skipBits(count) {
    if (this.position + count > this.bitCount) throw new RangeError('bitstream ended');
    this.position += count;
  }

  // ue(v): a run of N zeros, a 1, then N more bits, worth 2^N - 1 plus those.
  readUnsignedExpGolomb() {
    let leadingZeros = 0;
    while (this.readBits(1) === 0) {
      leadingZeros++;
      // A valid field is at most 32 bits wide; a longer run means we have lost
      // our place in the syntax and everything after it would be invented.
      if (leadingZeros > 32) throw new RangeError('malformed exp-Golomb code');
    }
    if (leadingZeros === 0) return 0;
    return (2 ** leadingZeros - 1) + this.readBits(leadingZeros);
  }

  // se(v): the unsigned form folded into an alternating sequence 0, 1, -1, 2, ...
  readSignedExpGolomb() {
    const unsigned = this.readUnsignedExpGolomb();
    const magnitude = Math.ceil(unsigned / 2);
    return (unsigned % 2 === 0) ? -magnitude : magnitude;
  }
}
// Deciding which frames of a half-read container may be given display numbers.
//
// A container that stores frames in decode order can hand a host the opening of
// a clip long before its last byte arrives — but only under one promise, which
// is the whole reason this file is separate and small enough to check by eye:
//
//   Every frame number reported is exact and PERMANENT. The set of frames the
//   index is willing to report grows; what any one of them means never changes.
//
// A host may already have written an annotation against display frame 412. If
// 412 came to mean a different picture once more of the file had been read, this
// library would have committed exactly the silent off-by-one it exists to
// prevent. So a frame is published only once nothing still to be read — and
// nothing already read but not yet placed — can present before it.
//
// Both full-file passes that publish early (Matroska's cluster scan, and the
// fragmented-MP4 pass through mp4box) use the machinery here, so the two build
// the same table from the same reasoning and differ only in how they prove their
// watermark.

// The longest prefix of decode-order frames whose place on the display timeline
// is settled, or null when nothing new can be settled yet.
//
// timeAt(index)        presentation time of a frame, in decode order, in
//                      whatever unit the caller's watermarks are in
// frameCount           how many frames have been read so far
// from                 how many have already been published
// containerWatermark   the earliest presentation time anything STILL TO BE READ
//                      could carry — the caller's proof, and the only thing here
//                      that differs between containers
// certifiedWatermark   the watermark promised at the previous publish, so a
//                      caller cannot certify the same ground twice
//
// Two things could still displace a frame we hold: one we have not read, bounded
// by containerWatermark, and one we HAVE read but not yet handed over, which for
// a reordering codec can carry an earlier presentation time than a frame before
// it in decode order. The promise made at each cut point is the smaller of
// those, and the run grows while its own running maximum stays strictly below
// that promise.
function longestCertifiedRun(
  timeAt, frameCount, from, containerWatermark, certifiedWatermark
) {
  if (from >= frameCount) return null;
  if (!(containerWatermark > certifiedWatermark)) return null;

  // The earliest presentation time still in hand, from each possible cut point
  // backwards: suffixMinimum[i - from] is the smallest time over frames [i..).
  const suffixMinimum = new Float64Array(frameCount - from + 1);
  suffixMinimum[frameCount - from] = Infinity;
  for (let i = frameCount - 1; i >= from; i--) {
    suffixMinimum[i - from] = Math.min(timeAt(i), suffixMinimum[i - from + 1]);
  }

  let end = from;
  let runMaximum = -Infinity;
  let watermark = certifiedWatermark;
  while (end < frameCount) {
    const candidateMaximum = Math.max(runMaximum, timeAt(end));
    const promise = Math.min(containerWatermark, suffixMinimum[end + 1 - from]);
    if (!(candidateMaximum < promise)) break;
    runMaximum = candidateMaximum;
    watermark = promise;
    end++;
  }
  if (end === from) return null;
  return { end, watermark };
}

// The watermark a declared reorder depth proves, maintained as frames arrive.
//
// A stream that declares it reorders by at most N frames (see
// src/frame-reorder-bound.js) is saying that no frame may be preceded in decode
// order by more than N frames that follow it in presentation order. Read that
// backwards: once a frame has N + 1 frames at or after its own presentation time
// already in hand, a frame still to be read landing before it would have to
// displace all N + 1 of them, one more than the stream is allowed. So the
// (N + 1)-th largest presentation time read so far is a watermark — and, being
// counted in frames rather than in time, it is usually a far tighter one than
// anything a container proves on its own.
//
// The list never grows past N + 1 entries (16 or so at the very worst), so the
// insertion sort below is cheaper than any structure with a better asymptotic
// story would be.
class DeclaredReorderWatermark {
  // depth: the declared reorder depth, or null for a stream that declares none —
  // in which case this is inert and its watermark is always -Infinity.
  constructor(depth) {
    this.capacity = (depth === null || depth === undefined) ? 0 : depth + 1;
    this.largestTimes = [];
  }

  observe(time) {
    if (!this.capacity) return;
    const largest = this.largestTimes;
    if (largest.length === this.capacity && time <= largest[0]) return;
    let position = largest.length;
    while (position > 0 && largest[position - 1] > time) position--;
    largest.splice(position, 0, time);
    if (largest.length > this.capacity) largest.shift();
  }

  // -Infinity until N + 1 frames have been seen: with fewer in hand there is
  // nothing the declaration rules out.
  get watermark() {
    return (this.capacity && this.largestTimes.length === this.capacity)
      ? this.largestTimes[0] : -Infinity;
  }
}
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
  duration: 0x4489,
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

// A block's timestamp is its cluster's plus a SIGNED 16-BIT offset, so the
// earliest presentation time a block of the cluster starting at T can carry is
// T - 32768 ticks. Nothing in the format ties that offset to the cluster's own
// span, so this — not any observation about how muxers actually lay clusters out
// — is what bounds how far back a frame we have not read yet could present.
const MATROSKA_MAXIMUM_BLOCK_TIMESTAMP_OFFSET = 32768;

// Codecs with no presentation reordering: their frames are stored in the order
// they are shown, so a block's timestamp can never fall below one already read.
// VP8 has no B-frames at all, and VP9's altref frames are hidden inside
// superframes rather than reordered for display. That is a property of the
// codecs, not a habit of muxers, which is why it is safe to certify a frame the
// moment the next one is read instead of waiting out the 32768-tick window
// above. Everything else (H.264, HEVC, AV1 in Matroska) can reorder.
function matroskaCodecHasNoPresentationReordering(codecId) {
  return codecId === 'V_VP8' || codecId === 'V_VP9';
}

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

// An IEEE float element (Matroska writes Duration as one, 4 or 8 bytes wide).
// Anything else is not a float this format defines, so it reads as absent.
async function readEbmlFloat(cursor, byteCount) {
  if (byteCount !== 4 && byteCount !== 8) {
    cursor.advance(byteCount);
    return 0;
  }
  const bytes = await readEbmlBytes(cursor, byteCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset, byteCount);
  return byteCount === 4 ? view.getFloat32(0) : view.getFloat64(0);
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
function formatProgress(progress) {
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
// options.onFramesCertified    called during the pass with each next contiguous
//                              run of decode-order frames whose place on the
//                              display timeline is settled, as
//                              (frames, watermarkTicks, decoderConfig). The
//                              promise it carries: NO frame still to come, read
//                              or unread, presents before watermarkTicks. A
//                              throw from it DOES abort the pass — this one is
//                              load-bearing, not an indicator.
// options.maximumFrameReorderSeconds
//                              how far a codec that reorders may be assumed to
//                              reorder, tightening the provable 32768-tick bound
//                              for onFramesCertified. An ASSERTION about the
//                              file, not a fact read from it; leave it out to
//                              certify only what the container proves.
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
    // Info/Duration, in timestamp-scale units, or 0 when the file states none.
    // A claim about the clip's length, never a source of frame numbers.
    declaredDurationTicks: 0,
    videoTrackNumber: null,
    defaultFrameDuration: 0,
    videoWidth: 0,
    videoHeight: 0,
    codecId: '',
    codecPrivate: null,
    clusterTimestamp: 0,
    // A Cluster's Timestamp is mandatory and has to arrive before the blocks it
    // times. Without this flag a cluster missing one would silently time its
    // frames from zero — a whole cluster landing on top of the opening seconds
    // of the clip, which sorts into a plausible-looking and completely wrong
    // table. Reset per cluster; readMatroskaBlock refuses if it is still false.
    clusterTimestampSeen: false,
    // Decode order, one entry per video frame: its timestamp in timescale ticks
    // (integer, exactly as the container writes it) and the byte range of its
    // encoded data, which the WebCodecs engine later fetches on demand.
    frames: [],
    // How many of those frames have been handed to onFramesCertified, and the
    // presentation time (ticks) that was promised when the last of them went out:
    // no frame still to come — read or unread — presents before it.
    certifiedFrameCount: 0,
    certifiedWatermarkTicks: -Infinity,
    // Cleared the first time a block's timestamp falls below its predecessor's,
    // which for a codec that does not reorder means the file is not what it says
    // it is. The certified watermark then drops back to the conservative
    // cluster-based bound rather than trusting the codec's promise.
    blocksAreInPresentationOrder: true,
    lastBlockTicks: -Infinity,
    // The watermark this bitstream's own declared reorder depth proves, kept up
    // to date as blocks are read. Replaced when Tracks is read (before any block
    // can arrive) with one that knows the track's depth; inert until then, and
    // inert for good on a codec that declares nothing.
    declaredReorderWatermark: new DeclaredReorderWatermark(null),
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

  // Publishing a certified prefix means committing to a decoder configuration
  // before the whole file has been read, and it must be the SAME configuration
  // the finished pass would have produced — the tier is chosen from it, and a
  // configuration that changed afterwards would mean the tier was chosen on
  // incomplete information. Everything it needs is known from Tracks except for
  // VP9, which keeps its profile and bit depth in the first keyframe (one small
  // read, below) and takes its level from the frame rate. So a VP9 track that
  // declares no DefaultDuration cannot be pinned early: its level would be read
  // off however much of the clip had gone past, which is not necessarily the
  // level of the whole clip. Such a track indexes in one shot, as before.
  const onFramesCertified = (typeof options.onFramesCertified === 'function')
    ? options.onFramesCertified : null;
  let pinnedDecoderConfig = null;
  let decoderConfigCanBePinned = true;
  const pinDecoderConfig = async () => {
    if (pinnedDecoderConfig || !decoderConfigCanBePinned) return pinnedDecoderConfig;
    if (state.videoTrackNumber === null || !state.frames.length) return null;
    if (state.codecId === 'V_VP9' && !(state.defaultFrameDuration > 0)) {
      decoderConfigCanBePinned = false;
      return null;
    }
    let firstKeyframeBytes = null;
    if (needsFirstKeyframeBytes(state.codecId)) {
      const keyframe = state.frames.find((frame) => frame.isSync);
      if (!keyframe) return null;   // no keyframe read yet; try again next chunk
      firstKeyframeBytes = await readFirstKeyframeBytes(reader, keyframe);
    }
    pinnedDecoderConfig = buildMatroskaDecoderConfig({
      codecId: state.codecId,
      codecPrivate: state.codecPrivate,
      videoWidth: state.videoWidth,
      videoHeight: state.videoHeight,
      firstKeyframeBytes,
      frameRate: estimateFrameRate([], state.defaultFrameDuration),
    });
    // A codec we cannot configure has no WebCodecs tier to publish a prefix
    // into; the clip still indexes in one shot for the <video> element.
    if (!pinnedDecoderConfig) decoderConfigCanBePinned = false;
    return pinnedDecoderConfig;
  };

  // How far a reordering codec is allowed to reorder. Absent an assertion from
  // the caller, the only honest answer is the widest offset a block can carry.
  const reorderGuardTicks = (options.maximumFrameReorderSeconds > 0)
    ? Math.ceil(options.maximumFrameReorderSeconds / state.timestampScaleSeconds)
    : MATROSKA_MAXIMUM_BLOCK_TIMESTAMP_OFFSET;

  const certifyFrames = async () => {
    if (!onFramesCertified || !decoderConfigCanBePinned) return;
    if (!await pinDecoderConfig()) return;
    const certified = nextCertifiedRun(state, reorderGuardTicks);
    if (!certified) return;
    state.certifiedFrameCount = certified.end;
    state.certifiedWatermarkTicks = certified.watermarkTicks;
    onFramesCertified(certified.frames, certified.watermarkTicks, {
      decoderConfig: pinnedDecoderConfig,
      timescale: 1 / state.timestampScaleSeconds,
      defaultFrameDuration: state.defaultFrameDuration,
      declaredDuration: state.declaredDurationTicks * state.timestampScaleSeconds,
      videoWidth: state.videoWidth,
      videoHeight: state.videoHeight,
      codecId: state.codecId,
    });
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
      // Everything read since the last chunk whose display position is now
      // settled goes out here, so a host can start naming and showing frames
      // while the rest of the file is still going past.
      await certifyFrames();
      // Yield to a read the host is actually waiting on (a decode of a frame
      // near the playhead) before taking the next megabyte for ourselves: this
      // pass is bulk throughput, that one is latency.
      await awaitPriorityReadsQuiet();
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

  // A configuration pinned early is the one this clip has been indexed under and
  // the one the decoder is already running, so it stands. Otherwise build it now,
  // the way this pass always has.
  let decoderConfig = pinnedDecoderConfig;
  if (!decoderConfig) {
    // VP9 writes no CodecPrivate in practice, and its profile and bit depth are
    // needed for the codec string — they live in the first keyframe's own
    // uncompressed header, so fetch just its opening bytes. One small read, after
    // a pass that has already been over the whole file.
    let firstKeyframeBytes = null;
    if (needsFirstKeyframeBytes(state.codecId)) {
      const keyframe = state.frames.find((frame) => frame.isSync) || state.frames[0];
      firstKeyframeBytes = await readFirstKeyframeBytes(reader, keyframe);
    }
    decoderConfig = buildMatroskaDecoderConfig({
      codecId: state.codecId,
      codecPrivate: state.codecPrivate,
      videoWidth: state.videoWidth,
      videoHeight: state.videoHeight,
      firstKeyframeBytes,
      frameRate: estimateFrameRate(presentationTimes, state.defaultFrameDuration),
    });
  }

  return {
    presentationTimes,
    frames: state.frames,
    timescale: 1 / state.timestampScaleSeconds,
    defaultFrameDuration: state.defaultFrameDuration,
    // What the file SAYS it runs to (Info/Duration), 0 when it says nothing.
    declaredDuration: state.declaredDurationTicks * state.timestampScaleSeconds,
    videoWidth: state.videoWidth,
    videoHeight: state.videoHeight,
    codecId: state.codecId,
    decoderConfig,
    // How many frames went out through onFramesCertified. The rest are in
    // `frames` as always; a caller that took the certified ones as they came
    // knows to pick up from here.
    certifiedFrameCount: state.certifiedFrameCount,
  };
}

// The opening bytes of a frame — enough of a VP9 keyframe's uncompressed header
// to read its profile and bit depth out of.
async function readFirstKeyframeBytes(reader, keyframe) {
  const wanted = Math.min(keyframe.size, VP9_HEADER_PROBE_BYTES);
  if (wanted <= 0) return null;
  return new Uint8Array(
    await reader.read(keyframe.offset, keyframe.offset + wanted - 1));
}

// The next contiguous run of decode-order frames whose place on the display
// timeline is settled, or null when nothing new can be settled yet. The run
// itself is found by longestCertifiedRun; what this adds is the Matroska-shaped
// proof of how early an unread block could present.
//
// There are up to two such proofs, and since both are proofs, the better of them
// is taken.
//
// What the CONTAINER proves:
//   * a codec that does not reorder settles a frame as soon as the next one is
//     read, because storage order IS presentation order;
//   * otherwise the earliest time an unread block can carry is the current
//     cluster's timestamp minus the widest offset a block can hold (or minus the
//     caller's asserted reorder bound, where it gave one).
//
// What the BITSTREAM proves, where the stream declares a reorder depth: see
// DeclaredReorderWatermark. It is counted in frames rather than in the
// 32768-tick window, so for H.264 and HEVC it is the difference between a
// handful of frames of lag and half a minute of it.
function nextCertifiedRun(state, reorderGuardTicks) {
  const containerWatermark = Math.max(
    (matroskaCodecHasNoPresentationReordering(state.codecId) && state.blocksAreInPresentationOrder)
      ? state.lastBlockTicks
      : state.clusterTimestamp - reorderGuardTicks,
    state.declaredReorderWatermark.watermark);

  const run = longestCertifiedRun(
    (index) => state.frames[index].ticks,
    state.frames.length, state.certifiedFrameCount,
    containerWatermark, state.certifiedWatermarkTicks);
  if (!run) return null;
  return {
    frames: state.frames.slice(state.certifiedFrameCount, run.end),
    end: run.end,
    watermarkTicks: run.watermark,
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
    } else if (id === EBML_ID.duration) {
      // A float, in timestamp-scale units. Only a CLAIM about how long the clip
      // runs — it names no frame and is never mapped from. It exists so a host
      // watching an index grow can size a scrubber against the whole clip
      // instead of a track that stretches under the cursor.
      state.declaredDurationTicks = await readEbmlFloat(cursor, size);
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
  // Read once, here, because it has to be known before the first block is
  // recorded: from that point on every block updates the running list of latest
  // presentation times the bound is applied to (see DeclaredReorderWatermark).
  state.declaredReorderWatermark =
    new DeclaredReorderWatermark(matroskaReorderDepth(codecId, codecPrivate));
}

// The bitstream's own statement of how far it reorders, in frames, for the two
// Matroska codecs that carry one. Null for everything else — VP8 and VP9 do not
// reorder at all and are certified by a stronger rule, and neither an AV1
// sequence header nor a VFW-wrapped oddity declares anything of the kind.
function matroskaReorderDepth(codecId, codecPrivate) {
  if (codecId === 'V_MPEG4/ISO/AVC') {
    return declaredFrameReorderDepth('avcC', codecPrivate);
  }
  if (codecId === 'V_MPEGH/ISO/HEVC') {
    return declaredFrameReorderDepth('hvcC', codecPrivate);
  }
  return null;
}

async function readMatroskaCluster(cursor, end, state) {
  state.clusterTimestamp = 0;
  state.clusterTimestampSeen = false;
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
      state.clusterTimestampSeen = true;
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
function buildMatroskaDecoderConfig(track) {
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
function hevcCodecString(hvcC) {
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
function av1CodecString(av1C) {
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
function vp9CodecString(firstKeyframeBytes, width, height, frameRate) {
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
  // A Cluster's Timestamp is mandatory and every block in it is written as an
  // offset from it, so a block reaching us before one has been read has no
  // timestamp we can honestly compute. Reading it as an offset from zero would
  // drop the whole cluster on top of the start of the clip — a table that sorts
  // and looks fine and is wrong — so refuse instead.
  if (!state.clusterTimestampSeen) {
    throw new Error('this WebM has a Cluster whose blocks come before its '
      + 'Timestamp (or that carries none at all), so their presentation times '
      + 'cannot be read');
  }
  // Lacing packs several frames into one block under a single timestamp, so
  // their individual times would have to be invented from DefaultDuration — and
  // their byte ranges parsed out of a lacing header. It is an audio feature and
  // essentially never used for video; refuse rather than hand back timestamps we
  // made up.
  if (flags & 0x06) throw new Error('this WebM laces its video blocks');

  const offset = cursor.position;   // the frame's own bytes start here
  const ticks = state.clusterTimestamp + relative;
  // Is storage order still presentation order? For a codec that does not reorder
  // it has to be, and that is what lets a frame be certified the moment the next
  // one is read (see nextCertifiedRun). One inversion and we stop believing it.
  if (ticks < state.lastBlockTicks) state.blocksAreInPresentationOrder = false;
  state.lastBlockTicks = ticks;
  state.declaredReorderWatermark.observe(ticks);
  state.frames.push({
    offset,
    size: blockEnd - offset,
    isSync: (keyframeFlagOverride === null) ? !!(flags & 0x80) : keyframeFlagOverride,
    ticks,
  });
  return state.frames.length - 1;
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
async function readAviFrameTable(reader, options = {}) {
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
function convertAnnexBToAvcc(bytes) {
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
class CertifiedPrefixViolationError extends Error {
  constructor(message) { super(message); this.name = 'CertifiedPrefixViolationError'; }
}

class ContainerIndex extends EventTarget {
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
    // True when the index's samples are an Annex B bitstream (AVI's H.264) that
    // must be converted to length-prefixed AVCC before the decoder — which is
    // configured in AVCC mode — will accept them. False for ISOBMFF, whose
    // samples are already AVCC. Set from the index in _adoptIndex.
    this._annexBSamples = false;
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

    // Set while the playhead sits on the last indexed frame of an index that is
    // still growing. Playback is not over and not paused — it is waiting.
    this._waitingForIndex = false;
    // Listeners on the index, kept so _teardown can drop them: an index outlives
    // the engine that adopted it (createBestEngine may hand the same one to a
    // second engine after a WebCodecs load fails).
    this._indexListeners = null;
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
  // construction — there is no browser presentation to be uncertain about. True
  // in all three index states below: a growing index has fewer frames than the
  // clip, not less exact ones.
  get frameIndexIsExact() { return true; }

  // 'complete'  every frame in the clip is indexed (the ordinary case)
  // 'growing'   the index is still being built and numFrames is still rising;
  //             the frames it names are final, and there will be more of them
  // 'truncated' the index pass stopped early. What is here is final and correct;
  //             the rest of the clip is not coming.
  get frameIndexState() {
    return this._index ? this._index.completionState : 'growing';
  }
  // True while playback is pinned at the last indexed frame waiting for the
  // index to catch up — a stall on the indexer, not on the decoder.
  get waitingForIndex() { return this._waitingForIndex; }

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
        // An Ogg index, or a Matroska one whose codec we could not configure:
        // exact timestamps, but nothing here to decode from. The clip is fine —
        // it belongs on NativeVideoEngine, which the same index makes frame-exact
        // anyway.
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
    this._annexBSamples = !!index.samplesAreAnnexB;
    this._timescale = index.timescale;
    this.rotation = index.rotation;
    this.videoWidth = index.videoWidth;
    this.videoHeight = index.videoHeight;
    this._readIndexTables();
    this._sizeWindows();

    // An index that is still being built hands over more frames as it certifies
    // them. Re-read its tables each time rather than reach through the index on
    // the decode driver's hot path.
    if (this._indexListeners || index.completionState !== 'growing') return;
    const onExtended = () => this._indexExtended();
    const onSettled = () => {
      if (index.completionState !== 'truncated') {
        this.dispatchEvent(new Event('indexcomplete'));
        return;
      }
      this.dispatchEvent(new Event('indextruncated'));
      // Not `failed`: the frames this engine has are exact and it will go on
      // playing them. What ended is the clip's growth, and a host showing a
      // scrubber or a frame count needs to hear that in the channel it already
      // watches for trouble.
      const because = index.completionError && index.completionError.message;
      this.dispatchEvent(new CustomEvent('errormessage', {
        detail: {
          message: `Only the first ${this.numFrames} frames of this clip could be `
            + `indexed${because ? ` (${because})` : ''}. Those frames are exact; the `
            + 'rest of the clip is unavailable.',
          fatal: true,
          incomplete: true,
        },
      }));
    };
    this._indexListeners = { index, onExtended, onSettled };
    index.addEventListener('extended', onExtended);
    index.addEventListener('complete', onSettled);
    index.addEventListener('truncated', onSettled);
  }

  // Alias the index's tables. Safe to redo on a growing index precisely because
  // it grows by APPENDING: every entry already read keeps its meaning, so a
  // re-read can only ever add frames, never move one.
  _readIndexTables() {
    const index = this._index;
    this._samples = index.samples;
    this._keyframeDecodeIndices = index.keyframeDecodeIndices;
    this._displayToDecode = index.displayToDecode;
    this._microsToDisplay = index.microsToDisplay;
    this.numFrames = index.numFrames;
    this.duration = index.duration;
  }

  // The index certified more frames. Synchronous from end to end: the index
  // dispatches this from inside its own publish, so anything awaited here would
  // let the host observe a half-grown table.
  _indexExtended() {
    this._readIndexTables();
    // A frame the driver gave up on may simply not have been indexed yet — the
    // decode run ran off the end of a sample table that was still short. Those
    // verdicts are stale now, so clear them rather than leave a frame
    // permanently undecodable for the rest of the session.
    this._stalledFrame = -1;
    this._restartTarget = -1;
    this._restartCount = 0;
    this._drained = false;
    if (this._waitingForIndex) {
      this._waitingForIndex = false;
      this._lastNow = 0;   // do not charge the wait to the playhead
    }
    if (this.ready) this._request(this.frameAtTime(this.playhead));
    this.dispatchEvent(new Event('indexextended'));
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
          // AVI stores H.264 as Annex B, but the decoder is configured in AVCC
          // mode (a description is present), so convert this frame's start-code
          // NAL units to length-prefixed form first. ISOBMFF samples are already
          // AVCC and pass through untouched.
          const sampleBytes = this._annexBSamples
            ? convertAnnexBToAvcc(this._sliceSample(k)) : this._sliceSample(k);
          this._videoDecoder.decode(new EncodedVideoChunk({
            type: s.isSync ? 'key' : 'delta',
            timestamp: Math.round(s.cts * 1e6 / this._timescale),
            duration: Math.round(s.duration * 1e6 / this._timescale),
            data: sampleBytes,
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
    // Somebody is waiting on this one. Say so, so that an index pass still
    // streaming the rest of the container out of the same source stands aside
    // rather than racing us for the pipe (see read-priority-gate).
    beginPriorityRead();
    try {
      this._byteBuffer = new Uint8Array(await this._reader.read(offset, end));
    } finally {
      endPriorityRead();
    }
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
          if (this.frameIndexState === 'growing') {
            // Not the end of the clip — the end of what has been indexed so far.
            // Hold on the last frame we can name and keep playing: the index
            // publishing its next run releases us (see _indexExtended). Looping
            // here would restart a clip the viewer is still in the middle of.
            this.playhead = Math.max(0, this.duration - 1e-6);
            this._waitingForIndex = true;
          } else if (this.loop) {
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
    this._waitingForIndex = false;
    // Stop listening to the index before letting go of it: the same index can be
    // handed on to another engine (createBestEngine falls back to the <video>
    // element after a WebCodecs load failure), and a torn-down engine must not
    // still be reacting to it.
    if (this._indexListeners) {
      const { index, onExtended, onSettled } = this._indexListeners;
      index.removeEventListener('extended', onExtended);
      index.removeEventListener('complete', onSettled);
      index.removeEventListener('truncated', onSettled);
      this._indexListeners = null;
    }
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
// How long the <video> element may go with no sign of progress — no bytes
// arriving, no frame, no error — before load() gives up on it (see
// _loadElement, which rearms this on every 'progress' event, so a slow download
// is never cut off by it).
const LOAD_STALL_MILLISECONDS = 10000;

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
  // decoder configuration (Ogg's does not, nor a Matroska track whose codec we
  // could not configure).
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
      // A <video> element plays the whole clip whether or not we have finished
      // reading the container, so an index still growing underneath it would be
      // asked, within seconds, which frame is on screen for a part of the clip it
      // has not certified. The WebCodecs engine can hold the playhead at the last
      // indexed frame because it owns the clock; this one cannot. So refuse a
      // partial index here rather than answer for frames it has not read.
      if (this._index.completionState === 'growing') {
        throw new Error('NativeVideoEngine: this index is still being built, and a '
          + '<video> element plays past whatever has been indexed so far — it '
          + 'cannot be held at the last certified frame the way the WebCodecs '
          + 'engine can. Wait for the index to finish before loading it here.');
      }
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

  // Hand the clip to the element and wait for its first frame ('loadeddata'), an
  // error, or a stall.
  //
  // The stall case is not theoretical and is not covered by 'error': a browser
  // that can DEMUX a container but cannot DECODE what is inside it parses the
  // metadata, reports no error at all, and simply never produces a frame. (WebKit
  // does exactly this with AV1 in WebM: readyState stops at HAVE_METADATA,
  // networkState goes idle with every byte already in hand, and nothing further
  // ever happens.) With no deadline that is an unbounded await inside load() —
  // the host's spinner spins forever, with no error to show and no fallback to
  // take. So the wait is bounded, and the bound is on a LACK OF PROGRESS rather
  // than on wall-clock time: a media element fires 'progress' while bytes are
  // arriving, so a genuinely slow download keeps rearming the deadline and is
  // never cut off, while an element that has gone quiet without a frame is
  // refused with an error naming the likely cause.
  _loadElement(source) {
    const url = (typeof source === 'string')
      ? source : (this._objectUrl = URL.createObjectURL(source));
    return new Promise((resolve, reject) => {
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        this.video.removeEventListener('loadeddata', onLoaded);
        this.video.removeEventListener('error', onError);
        this.video.removeEventListener('progress', onProgress);
      };
      const onLoaded = () => {
        cleanup();
        // Reassigning src resets playbackRate/loop to defaults; reapply.
        this.video.playbackRate = this._rate;
        this.video.loop = this._loop;
        resolve();
      };
      const onError = () => { cleanup(); reject(new Error('native <video> load failed')); };
      const onStalled = () => {
        const readyState = this.video.readyState;
        cleanup();
        reject(new Error('NativeVideoEngine: this browser loaded the clip\'s metadata '
          + `but never presented a frame (readyState ${readyState}), and reported no `
          + 'error — the signature of a container it can demux carrying a codec it '
          + 'cannot decode. The clip is refused rather than left loading forever.'));
      };
      const armStallTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(onStalled, LOAD_STALL_MILLISECONDS);
      };
      const onProgress = () => armStallTimer();   // bytes arriving: keep waiting
      this.video.addEventListener('loadeddata', onLoaded);
      this.video.addEventListener('error', onError);
      this.video.addEventListener('progress', onProgress);
      armStallTimer();
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
    // Hand back a playable engine as soon as enough of the clip has been indexed
    // to be worth showing, instead of waiting for the whole container to be read.
    // Only a full-file pass has anything to wait for (WebM today; a classic MP4
    // indexes in a few range reads however long the clip is), and only the
    // WebCodecs tier can use a partial index — the <video> element plays the
    // whole clip whether or not we have named its frames yet, so an index still
    // growing underneath it would have to answer for frames it has not certified.
    //
    // What the host gets is an engine whose numFrames GROWS: every frame number
    // it reports is exact and permanent, and the set of frames it will report
    // widens as the pass goes on. Watch engine.frameIndexState and its
    // 'indexextended' / 'indexcomplete' / 'indextruncated' events. Off by
    // default, because a growing numFrames is not what existing callers expect.
    playWhileIndexing = false,
    // How much of the clip must be indexed before that early engine comes back.
    // An engine that can show one frame is not worth the complexity of handling
    // one; a second or so of video is.
    minimumIndexedFramesBeforePlayback = 30,
  } = options;

  let index = (providedIndex !== undefined) ? providedIndex : null;
  // The build error, kept so the refusal below can name what actually went wrong
  // (an unsupported container, mp4box.js absent, or the WebM pass timing out).
  let indexBuildError = null;
  if (providedIndex === undefined) {
    // Publishing certified prefixes is only worth asking for when there is a
    // WebCodecs tier for them to land on.
    const wantCertifiedPrefixes = playWhileIndexing && prefer !== 'native'
      && !!canvas && typeof VideoDecoder !== 'undefined';
    let earlyIndex = null;
    let onIndexExtended = null;
    const readyToPlay = new Promise((resolve) => {
      onIndexExtended = (growing) => {
        if (earlyIndex || growing.completionState !== 'growing') return;
        if (growing.numFrames < minimumIndexedFramesBeforePlayback) return;
        // The same two gates the ladder below applies, asked early: without a
        // sample table and a decoder configuration there is no WebCodecs tier
        // for a partial index to play on, and a codec this browser accepts and
        // then dies on belongs on the <video> element, which needs the whole
        // index. Either way, wait for the finished build.
        const growingCodec = growing.decoderConfig && growing.decoderConfig.codec;
        if (!growing.supportsWebCodecs
            || webCodecsMayFailMidStream(growingCodec, detectBrowserEngine())) return;
        earlyIndex = growing;
        resolve(growing);
      };
    });

    const buildPromise = ContainerIndex.fromSource(source, {
      timeoutMilliseconds: indexTimeoutMilliseconds,
      maxBytes: indexMaxBytes,
      onProgress,
      publishPartialIndex: wantCertifiedPrefixes,
      onIndexCreated: wantCertifiedPrefixes ? (created) => {
        created.addEventListener('extended', () => onIndexExtended(created));
      } : undefined,
    }).then((built) => { index = built; return built; },
      (err) => { indexBuildError = err; return null; });

    // Whichever comes first: enough of the clip to play, or the whole pass.
    if (wantCertifiedPrefixes) await Promise.race([readyToPlay, buildPromise]);
    else await buildPromise;
    if (!index) index = earlyIndex;
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
      + 'it is not a format we can index (supported: MP4/MOV, WebM/MKV, Ogg, and AVI). '
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
      // The <video> element plays the whole clip regardless of how far the index
      // has got, so it needs a finished one to name frames against — see the
      // refusal in NativeVideoEngine.load. Wait for the pass we left running.
      if (index.completionState === 'growing') {
        await new Promise((resolve) => {
          index.addEventListener('complete', resolve, { once: true });
          index.addEventListener('truncated', resolve, { once: true });
        });
      }
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
