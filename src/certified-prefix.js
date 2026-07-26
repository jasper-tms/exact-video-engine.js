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
export function longestCertifiedRun(
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
export class DeclaredReorderWatermark {
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
