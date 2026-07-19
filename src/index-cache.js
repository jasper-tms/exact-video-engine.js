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
export const INDEX_CACHE_SCHEMA_VERSION = 1;

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
export function deriveIndexCacheKey(source, reader) {
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
export async function loadCachedIndexPayload(cacheKey) {
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
export async function storeCachedIndexPayload(cacheKey, payload) {
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
export function serializeContainerIndex(index) {
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
export function hydrateContainerIndex(index, payload) {
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
