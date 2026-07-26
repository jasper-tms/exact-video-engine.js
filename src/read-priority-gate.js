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
export function beginPriorityRead() {
  priorityReadsInFlight += 1;
}

export function endPriorityRead() {
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
export function awaitPriorityReadsQuiet() {
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
