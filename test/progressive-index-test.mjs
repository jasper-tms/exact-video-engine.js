// Unit test for the certified-prefix index (src/container-index.js's growth
// machinery and src/matroska.js's nextCertifiedRun). Runs in plain Node — the
// cluster scan needs no browser — against the generated fixtures.
//
// A full-file pass can publish the frames it has certified while the rest of the
// file is still going past, so a host can name and show the opening frames of a
// long clip without waiting for its last byte. What makes that safe is one
// promise:
//
//   Every frame number reported is exact and PERMANENT. The set of frames the
//   index is willing to report grows; what any one of them means never changes.
//
// That is stronger than "a prefix is available", and it is what this file
// exists to hold the implementation to. A host may already have written an
// annotation against display frame 412; if 412 ever came to mean a different
// picture once more of the file had been read, this library would have committed
// exactly the silent off-by-one it exists to prevent.
//
// So the central assertion below is not "the final table is right" (that is
// matroska-table-test's job) but "every table published along the way was an
// exact element-wise PREFIX of the final one" — and, separately, that the
// progressively built index is identical to the one-shot build of the same file,
// since the two share the code that places frames and differ only in when.
//
// If the fixtures are absent (no ffmpeg on this machine — see make-test-clips.sh)
// the test skips rather than fails.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ContainerIndex } from '../src/container-index.js';
import {
  buildAvcC, buildH264SequenceParameterSet,
} from './bitstream-fixtures.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clip = (name) => join(here, 'clips', name);

if (!existsSync(clip('counter-cfr.webm'))) {
  console.log('SKIP progressive-index: fixtures not generated on this machine '
    + '(run test/make-test-clips.sh)');
  process.exit(0);
}

class MemoryRangeReader {
  constructor(bytes) { this.bytes = bytes; this.size = bytes.length; }
  async init() {}
  async read(start, endInclusive) {
    return this.bytes.slice(start, endInclusive + 1).buffer;
  }
}

let failures = 0;
const check = (label, condition, detail) => {
  if (condition) return;
  failures += 1;
  console.error(`FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`);
};

// A deep copy of everything a host could have read off the index at this moment.
const snapshot = (index) => ({
  numFrames: index.numFrames,
  duration: index.duration,
  indexedThroughSeconds: index.indexedThroughSeconds,
  expectedDuration: index.expectedDuration,
  completionState: index.completionState,
  presentationTimes: Array.from(index.presentationTimes),
  frameDurations: Array.from(index.frameDurations),
  displayToDecode: Array.from(index.displayToDecode),
  samples: index.samples.map((s) => ({ ...s })),
  keyframeDecodeIndices: index.keyframeDecodeIndices.slice(),
  microsToDisplay: new Map(index.microsToDisplay),
});

// Build the same clip twice — once in one shot, once publishing certified
// prefixes with a tiny chunk size so the pass refills (and so certifies) many
// times over a few kilobytes — and collect every intermediate state.
async function buildBothWays(name) {
  const bytes = new Uint8Array(await readFile(clip(name)));
  const oneShot = await ContainerIndex.load(new MemoryRangeReader(bytes), {});

  const published = [];
  const events = [];
  const progressive = new ContainerIndex(new MemoryRangeReader(bytes));
  // ContainerIndex.load builds its own instance, so drive the demux directly to
  // keep a handle on the index while it is still growing.
  progressive.addEventListener('extended', () => published.push(snapshot(progressive)));
  progressive.addEventListener('complete', () => events.push('complete'));
  progressive.addEventListener('truncated', () => events.push('truncated'));
  await progressive._demuxMatroska(new MemoryRangeReader(bytes), {
    chunkBytes: 256,           // small, so a few-KB clip certifies several times
    publishPartialIndex: true,
  });
  return { oneShot, progressive, published, events };
}

// Is `earlier` an exact element-wise prefix of `later`, in every table a host
// can read? This is the whole invariant.
function assertPrefix(label, earlier, later) {
  const n = earlier.numFrames;
  check(`${label}: frame count does not exceed the final one`, n <= later.numFrames,
    `${n} > ${later.numFrames}`);
  for (let d = 0; d < n; d++) {
    check(`${label}: presentationTimes[${d}]`,
      earlier.presentationTimes[d] === later.presentationTimes[d],
      `${earlier.presentationTimes[d]} vs ${later.presentationTimes[d]}`);
    check(`${label}: frameDurations[${d}]`,
      earlier.frameDurations[d] === later.frameDurations[d],
      `${earlier.frameDurations[d]} vs ${later.frameDurations[d]}`);
    check(`${label}: displayToDecode[${d}]`,
      earlier.displayToDecode[d] === later.displayToDecode[d],
      `${earlier.displayToDecode[d]} vs ${later.displayToDecode[d]}`);
  }
  // The decode table grows the same way, and may legitimately run ahead of the
  // display timeline by the frames whose duration is not settled yet.
  for (let k = 0; k < earlier.samples.length; k++) {
    const a = earlier.samples[k], b = later.samples[k];
    check(`${label}: samples[${k}].offset`, a.offset === b.offset);
    check(`${label}: samples[${k}].size`, a.size === b.size);
    check(`${label}: samples[${k}].isSync`, a.isSync === b.isSync);
    check(`${label}: samples[${k}].cts`, a.cts === b.cts);
  }
  for (let i = 0; i < earlier.keyframeDecodeIndices.length; i++) {
    check(`${label}: keyframeDecodeIndices[${i}]`,
      earlier.keyframeDecodeIndices[i] === later.keyframeDecodeIndices[i]);
  }
  // A host that mapped a presented timestamp to a frame number early must get
  // the same frame number for it afterwards.
  for (const [micros, display] of earlier.microsToDisplay) {
    check(`${label}: microsToDisplay[${micros}]`,
      later.microsToDisplay.get(micros) === display,
      `${display} became ${later.microsToDisplay.get(micros)}`);
  }
}

// Whether a clip can name frames before its last byte is read comes down to what
// bounds how far it may reorder, and there are three answers among these
// fixtures — see nextCertifiedRun for the two proofs it combines.
const CLIPS = [
  // VP8 and VP9 do not reorder at all, so storage order IS presentation order
  // and a frame is certified the moment the next one is read.
  { name: 'counter-cfr.webm', publishesEarly: true },   // VP9, constant rate
  { name: 'counter-vfr.webm', publishesEarly: true },   // VP9, variable rate
  { name: 'counter-vp8.webm', publishesEarly: true },   // VP8

  // H.264 reorders, but says how far in its own sequence parameter set, and this
  // clip's says zero — so it certifies as eagerly as VP9 does. Before that
  // declaration was read this fixture published nothing until the final byte.
  { name: 'counter-vfr.mkv', publishesEarly: true },    // H.264, declared depth 0

  // AV1 reorders and declares no bound anywhere we can read, so the only honest
  // watermark is the container's own: the 32768-tick block-offset window, 32.8
  // seconds at the default timestamp scale, which a one-second fixture never
  // clears. Publishing once at the end is the correct conservative answer here,
  // not a shortcoming of the fixture.
  { name: 'counter-av1.webm', publishesEarly: false },

  // HEVC declares a depth of two, and that bound does take hold — but this
  // fixture is a single 30-frame group with a deep enough B-pyramid that only
  // its opening frame certifies before the file runs out, and that one frame is
  // held back as the one whose duration is not settled yet. So nothing usable
  // appears early even though certification is running. A longer clip is what
  // separates those two, and the synthetic ones below are it.
  { name: 'counter-hevc.mkv', publishesEarly: false },
];

for (const { name, publishesEarly } of CLIPS) {
  if (!existsSync(clip(name))) {
    console.log(`SKIP progressive-index ${name}: fixture absent`);
    continue;
  }
  const { oneShot, progressive, published, events } = await buildBothWays(name);
  const final = snapshot(progressive);

  // 1. The progressive build and the one-shot build agree on everything.
  assertPrefix(`${name} one-shot vs progressive`, snapshot(oneShot), final);
  check(`${name}: same frame count both ways`,
    oneShot.numFrames === progressive.numFrames,
    `${oneShot.numFrames} vs ${progressive.numFrames}`);
  check(`${name}: same duration both ways`,
    oneShot.duration === progressive.duration,
    `${oneShot.duration} vs ${progressive.duration}`);
  check(`${name}: same codec string both ways`,
    (oneShot.decoderConfig && oneShot.decoderConfig.codec)
      === (progressive.decoderConfig && progressive.decoderConfig.codec),
    `${oneShot.decoderConfig && oneShot.decoderConfig.codec} vs `
      + `${progressive.decoderConfig && progressive.decoderConfig.codec}`);
  check(`${name}: same WebCodecs support both ways`,
    oneShot.supportsWebCodecs === progressive.supportsWebCodecs);

  // The container's declared duration, which a host sizes a scrubber against
  // while the table is still growing. A claim, not a mapping — but it has to be
  // roughly right or it is worse than nothing, and it has to be known from the
  // FIRST publish or the scrubber grows anyway.
  check(`${name}: declared duration is read`, progressive.expectedDuration > 0,
    `${progressive.expectedDuration}`);
  check(`${name}: declared duration is close to the scanned one`,
    Math.abs(progressive.expectedDuration - final.duration) < 0.5,
    `declared ${progressive.expectedDuration}, scanned ${final.duration}`);

  // 2. THE CENTRAL ASSERTION: every table published along the way was an exact
  //    element-wise prefix of the final one.
  for (let i = 0; i < published.length; i++) {
    assertPrefix(`${name} publish #${i}`, published[i], final);
  }

  // 3. The index only ever grows, and its state machine runs growing -> complete.
  for (let i = 1; i < published.length; i++) {
    check(`${name}: numFrames non-decreasing at publish #${i}`,
      published[i].numFrames >= published[i - 1].numFrames,
      `${published[i - 1].numFrames} -> ${published[i].numFrames}`);
    check(`${name}: duration non-decreasing at publish #${i}`,
      published[i].duration >= published[i - 1].duration);
    check(`${name}: indexedThroughSeconds non-decreasing at publish #${i}`,
      published[i].indexedThroughSeconds >= published[i - 1].indexedThroughSeconds);
    // The scrubber a host sizes against this must not move under the cursor.
    check(`${name}: expectedDuration is fixed from the first publish`,
      published[i].expectedDuration === published[0].expectedDuration,
      `${published[0].expectedDuration} -> ${published[i].expectedDuration}`);
  }
  check(`${name}: ends complete`, progressive.completionState === 'complete',
    progressive.completionState);
  check(`${name}: fired complete once`,
    events.filter((e) => e === 'complete').length === 1, events.join(','));
  check(`${name}: never fired truncated`, !events.includes('truncated'));

  // 4. For a codec that does not reorder, frames really did become available
  //    before the pass finished — otherwise everything above passes vacuously.
  //    For one that does, nothing may be published early on a clip this short:
  //    certifying it would mean asserting a reorder bound the container does not
  //    state.
  const usableEarly = published
    .filter((p) => p.completionState === 'growing' && p.numFrames > 0);
  if (publishesEarly) {
    check(`${name}: published usable frames before the pass finished`,
      usableEarly.length > 0,
      `${published.length} publishes, none of them growing with frames`);
    if (usableEarly.length) {
      check(`${name}: the first usable publish is a real prefix, not the whole clip`,
        usableEarly[0].numFrames < final.numFrames,
        `${usableEarly[0].numFrames} of ${final.numFrames} at the first publish`);
    }
  } else {
    check(`${name}: nothing usable is published before the clip's bound allows it`,
      usableEarly.length === 0,
      `published ${usableEarly.length} growing states with frames`);
  }
}

// ------------------------------------------------------------------
// A pass that dies partway keeps what it certified, and says so.
//
// A source that stops answering mid-scan (the connection drops, the file is
// truncated on a slow link) is the realistic shape of this: the frames already
// published were certified before they went out, so they stay exactly as they
// were, and the host is told that nothing more is coming.
// ------------------------------------------------------------------
{
  const bytes = new Uint8Array(await readFile(clip('counter-cfr.webm')));
  class FailingRangeReader extends MemoryRangeReader {
    constructor(source, failFromOffset) { super(source); this.failFromOffset = failFromOffset; }
    async read(start, endInclusive) {
      if (start >= this.failFromOffset) throw new Error('network read failed');
      return super.read(start, Math.min(endInclusive, this.failFromOffset - 1));
    }
  }
  const published = [];
  const events = [];
  const failing = new FailingRangeReader(bytes, Math.floor(bytes.length * 0.7));
  const index = await ContainerIndex.load(failing, {
    chunkBytes: 128,
    publishPartialIndex: true,
    onIndexCreated: (created) => {
      created.addEventListener('extended', () => published.push(snapshot(created)));
      created.addEventListener('truncated', () => events.push('truncated'));
      created.addEventListener('complete', () => events.push('complete'));
    },
  });

  check('truncated: an index came back rather than a throw', !!index);
  check('truncated: state is truncated', index.completionState === 'truncated',
    index.completionState);
  check('truncated: carries the underlying error', !!index.completionError);
  check('truncated: fired truncated', events.includes('truncated'));
  check('truncated: never claimed complete', !events.includes('complete'));
  check('truncated: kept the frames it certified', index.numFrames > 0,
    `${index.numFrames} frames`);
  check('truncated: kept fewer than the whole clip', index.numFrames < 30,
    `${index.numFrames} frames from a 30-frame clip read only 70% of the way`);
  for (let i = 0; i < published.length; i++) {
    assertPrefix(`truncated publish #${i}`, published[i], snapshot(index));
  }
}

// ------------------------------------------------------------------
// Synthetic clips, written byte by byte here rather than muxed, for the shapes
// no real muxer produces — which are exactly the shapes the certification rules
// have to survive. There is no other way to test a refusal path.
// ------------------------------------------------------------------

// EBML: a variable-length integer, marker bit included.
function variableInt(value) {
  for (let length = 1; length <= 8; length++) {
    const limit = 2 ** (7 * length) - 1;
    if (value < limit) {
      const bytes = new Uint8Array(length);
      let remaining = value;
      for (let i = length - 1; i >= 0; i--) { bytes[i] = remaining & 0xFF; remaining = Math.floor(remaining / 256); }
      bytes[0] |= 0x80 >> (length - 1);
      return bytes;
    }
  }
  throw new Error('variable-length integer too large');
}

// Join byte strings. A piece is a Uint8Array, a plain array of byte VALUES (so
// element ids can be written as [0x1F, 0x43, 0xB6, 0x75]), or an array of pieces
// (so a list of blocks can be handed over whole).
const concat = (...pieces) => {
  const toBytes = (piece) => {
    if (piece instanceof Uint8Array) return piece;
    if (!piece.length) return new Uint8Array(0);
    return typeof piece[0] === 'number' ? new Uint8Array(piece) : concat(...piece);
  };
  const parts = pieces.map(toBytes);
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

// An element: its id bytes exactly as stored, then its size, then its payload.
const element = (idBytes, payload) =>
  concat(idBytes, variableInt(payload.length), payload);

const unsigned = (value, byteCount) => {
  const bytes = new Uint8Array(byteCount);
  let remaining = value;
  for (let i = byteCount - 1; i >= 0; i--) { bytes[i] = remaining & 0xFF; remaining = Math.floor(remaining / 256); }
  return bytes;
};

// A SimpleBlock for track 1: track number, signed 16-bit offset from the
// cluster's timestamp, flags, then the frame's bytes (contents irrelevant — this
// parser never reads them).
const simpleBlock = (relativeTicks, isKeyframe, payloadLength) => element([0xA3], concat(
  variableInt(1),
  unsigned(relativeTicks & 0xFFFF, 2),
  [isKeyframe ? 0x80 : 0x00],
  new Uint8Array(payloadLength).fill(0x42)));

// codecId picks whether the certification rule believes storage order is
// presentation order: 'V_VP8' does not reorder, 'V_MPEG4/ISO/AVC' does.
// clusters is [{timestamp, blocks: [{relative, isKeyframe}]}].
//
// codecPrivate defaults to an avcC head too short to hold a sequence parameter
// set, which is how a track says nothing about how far it reorders. Pass a real
// one to exercise the bitstream bound.
function buildSyntheticMatroska({
  codecId, clusters, framePayloadLength = 64,
  codecPrivate = new Uint8Array([0x01, 0x42, 0xC0, 0x1E, 0xFF]),
}) {
  const trackEntry = element([0xAE], concat(
    element([0xD7], unsigned(1, 1)),                       // TrackNumber
    element([0x83], unsigned(1, 1)),                       // TrackType: video
    element([0x86], new TextEncoder().encode(codecId)),    // CodecID
    element([0x63, 0xA2], codecPrivate),                   // CodecPrivate
    element([0x23, 0xE3, 0x83], unsigned(33333333, 4)),    // DefaultDuration: 30fps
    element([0xE0], concat(                                // Video
      element([0xB0], unsigned(160, 2)),                   //   PixelWidth
      element([0xBA], unsigned(90, 2))))));                //   PixelHeight
  const body = concat(
    element([0x15, 0x49, 0xA9, 0x66],                      // Info
      element([0x2A, 0xD7, 0xB1], unsigned(1000000, 4))),  //   TimestampScale: 1 ms
    element([0x16, 0x54, 0xAE, 0x6B], trackEntry),         // Tracks
    clusters.map(({ timestamp, blocks }) => element([0x1F, 0x43, 0xB6, 0x75], concat(
      element([0xE7], unsigned(timestamp, 4)),             // Cluster/Timestamp
      blocks.map((b) => simpleBlock(b.relative, b.isKeyframe, framePayloadLength))))));
  return concat(
    element([0x1A, 0x45, 0xDF, 0xA3], new Uint8Array(0)),  // EBML header (skipped whole)
    element([0x18, 0x53, 0x80, 0x67], body));              // Segment
}

// Thirty seconds of clusters, one per second, so the 32768-tick reorder window
// is cleared several times over and a reordering codec really does publish early.
const longClusters = [];
for (let second = 0; second < 60; second++) {
  const blocks = [];
  for (let frame = 0; frame < 30; frame++) {
    blocks.push({ relative: Math.round(frame * 1000 / 30), isKeyframe: frame === 0 });
  }
  longClusters.push({ timestamp: second * 1000, blocks });
}

{
  const bytes = buildSyntheticMatroska({ codecId: 'V_MPEG4/ISO/AVC', clusters: longClusters });
  const published = [];
  const index = await ContainerIndex.load(new MemoryRangeReader(bytes), {
    chunkBytes: 4096,
    publishPartialIndex: true,
    onIndexCreated: (created) =>
      created.addEventListener('extended', () => published.push(snapshot(created))),
  });
  const final = snapshot(index);
  check('reordering codec: indexed every frame', index.numFrames === 60 * 30,
    `${index.numFrames}`);
  check('reordering codec: completed', index.completionState === 'complete');
  const usableEarly = published
    .filter((p) => p.completionState === 'growing' && p.numFrames > 0);
  check('reordering codec: published a prefix once the 32768-tick window cleared',
    usableEarly.length > 0, `${published.length} publishes, none usable early`);
  if (usableEarly.length) {
    check('reordering codec: the first usable publish is a real prefix',
      usableEarly[0].numFrames < final.numFrames,
      `${usableEarly[0].numFrames} of ${final.numFrames}`);
    // The conservative watermark must hold back at least the last 32.768 seconds.
    const lastGrowing = usableEarly[usableEarly.length - 1];
    check('reordering codec: held back the whole reorder window',
      final.duration - lastGrowing.duration >= 32.768,
      `only ${(final.duration - lastGrowing.duration).toFixed(3)}s held back`);
  }
  for (let i = 0; i < published.length; i++) {
    assertPrefix(`reordering codec publish #${i}`, published[i], final);
  }
}

// ------------------------------------------------------------------
// The same reordering codec, but with a sequence parameter set that says how far
// it actually reorders. The container's own bound is 32.8 seconds of content
// before a single frame can be named; the bitstream's is a couple of FRAMES. The
// same clip, indexed the same way, should now publish within a frame or two of
// what it has read rather than half a minute behind it.
// ------------------------------------------------------------------
{
  const bytes = buildSyntheticMatroska({
    codecId: 'V_MPEG4/ISO/AVC',
    clusters: longClusters,
    codecPrivate: buildAvcC(buildH264SequenceParameterSet({ declaredReorderFrames: 2 })),
  });
  const published = [];
  const index = await ContainerIndex.load(new MemoryRangeReader(bytes), {
    chunkBytes: 4096,
    publishPartialIndex: true,
    onIndexCreated: (created) =>
      created.addEventListener('extended', () => published.push(snapshot(created))),
  });
  const final = snapshot(index);
  check('declared reorder depth: indexed every frame', index.numFrames === 60 * 30,
    `${index.numFrames}`);
  check('declared reorder depth: completed', index.completionState === 'complete');

  const usableEarly = published
    .filter((p) => p.completionState === 'growing' && p.numFrames > 0);
  check('declared reorder depth: published a prefix', usableEarly.length > 0,
    `${published.length} publishes, none usable early`);
  if (usableEarly.length) {
    // How far behind the end of the file the last growing publish stopped. With
    // the declaration this is a few frames plus whatever the publish granularity
    // (one per chunk refill) rounds it up to; without one it can never be less
    // than the 32.768-second block-offset window. Asserted against that window
    // rather than against a frame count, so a change in chunk size is not a
    // failure — the claim being made is "frames, not half a minute".
    const lastGrowing = usableEarly[usableEarly.length - 1];
    const heldBack = final.duration - lastGrowing.duration;
    check('declared reorder depth: holds back frames, not the whole window',
      heldBack < 32.768 / 4, `${heldBack.toFixed(3)}s held back`);
    // And frames really are named from the opening of the clip, which the
    // conservative bound cannot do until 32.768 seconds have gone past.
    check('declared reorder depth: names frames from the opening seconds',
      usableEarly[0].duration < 32.768,
      `first publish already ${usableEarly[0].duration.toFixed(3)}s in`);
  }
  for (let i = 0; i < published.length; i++) {
    assertPrefix(`declared reorder depth publish #${i}`, published[i], final);
  }
}

// A declared depth is a promise about the whole stream, so a file that breaks it
// must not be papered over. The certified-prefix invariant catches the case
// outright: a frame arriving before one already published is not recoverable,
// because a host may already have written an annotation against that number.
{
  // Ordinary clusters, and then one block that presents 30 seconds before the
  // cluster it sits in — a stream reordering by nine hundred frames while
  // declaring two. (A block's offset is a signed 16-bit field, so 30 seconds is
  // about as far back as a Matroska file can physically reach; the declared
  // bound is violated many times over regardless.)
  const clusters = [];
  for (let second = 0; second < 60; second++) {
    const blocks = [];
    for (let frame = 0; frame < 30; frame++) {
      blocks.push({ relative: Math.round(frame * 1000 / 30), isKeyframe: frame === 0 });
    }
    if (second === 59) blocks.push({ relative: -30000, isKeyframe: false });
    clusters.push({ timestamp: second * 1000, blocks });
  }
  const bytes = buildSyntheticMatroska({
    codecId: 'V_MPEG4/ISO/AVC',
    clusters,
    codecPrivate: buildAvcC(buildH264SequenceParameterSet({ declaredReorderFrames: 2 })),
  });
  const refusal = await ContainerIndex.load(new MemoryRangeReader(bytes), {
    chunkBytes: 4096,
    publishPartialIndex: true,
    onIndexCreated: () => {},
  }).then(() => null, (error) => error);
  check('a stream that breaks its declared depth is refused, not mis-numbered',
    refusal !== null, 'the index built anyway');
  if (refusal) {
    check('the refusal says the prefix was not certified',
      /not certified|unreliable/.test(refusal.message), refusal.message);
  }
}

// A cluster whose blocks arrive before its Timestamp has no honest presentation
// time. Reading them as offsets from zero would drop the whole cluster on top of
// the start of the clip — a table that sorts and looks fine and is wrong.
{
  const clusters = [{ timestamp: 0, blocks: [{ relative: 0, isKeyframe: true }] }];
  const withTimestamp = buildSyntheticMatroska({ codecId: 'V_VP8', clusters });
  const built = await ContainerIndex.load(new MemoryRangeReader(withTimestamp), {})
    .then((i) => i, () => null);
  check('synthetic builder produces a readable clip', built && built.numFrames === 1,
    built ? `${built.numFrames} frames` : 'refused');

  // Blank the Cluster/Timestamp id (0xE7) to Void (0xEC), which the parser skips.
  const withoutTimestamp = withTimestamp.slice();
  const clusterAt = withoutTimestamp.findIndex((_, i) =>
    withoutTimestamp[i] === 0x1F && withoutTimestamp[i + 1] === 0x43
    && withoutTimestamp[i + 2] === 0xB6 && withoutTimestamp[i + 3] === 0x75);
  const timestampAt = withoutTimestamp.indexOf(0xE7, clusterAt);
  withoutTimestamp[timestampAt] = 0xEC;
  const refusal = await ContainerIndex.load(new MemoryRangeReader(withoutTimestamp), {})
    .then(() => null, (e) => e);
  check('cluster with no Timestamp is refused', refusal !== null, 'the index built anyway');
  if (refusal) {
    check('cluster refusal names the problem', /Timestamp/.test(refusal.message),
      refusal.message);
  }
}

// A frame that presents before one already published is the failure this whole
// design exists to prevent, and it must be loud rather than quietly repaired.
// Built by claiming a non-reordering codec and then reordering anyway, which is
// the one way to slip past the container's own bound.
{
  const clusters = [
    { timestamp: 0, blocks: [] },       // 30 frames spanning 0..957 ticks
    { timestamp: 2000, blocks: [{ relative: 0, isKeyframe: true }] },
    // ...and then, once those have gone out, a frame that belongs back among
    // them. A signed 16-bit offset cannot reach back from far away, so the
    // cluster that carries it sits close enough to reach.
    { timestamp: 3000, blocks: [{ relative: -2500, isKeyframe: false }] },
  ];
  for (let frame = 0; frame < 30; frame++) {
    clusters[0].blocks.push({ relative: frame * 33, isKeyframe: frame === 0 });
  }
  const bytes = buildSyntheticMatroska({ codecId: 'V_VP8', clusters });
  const outcome = await ContainerIndex.load(new MemoryRangeReader(bytes), {
    chunkBytes: 128,   // small enough that the first cluster publishes on its own
    publishPartialIndex: true,
  }).then((i) => ({ index: i }), (e) => ({ error: e }));

  // Either the run was refused outright, or it was published and then truncated
  // — both are loud. What is not acceptable is a complete index whose frame
  // numbers silently moved under a host that had already read them.
  const state = outcome.index ? outcome.index.completionState : 'threw';
  check('out-of-order frame does not yield a quietly complete index',
    state !== 'complete', `completionState was ${state}`);
  const message = outcome.error ? outcome.error.message
    : (outcome.index.completionError || {}).message || '';
  check('out-of-order frame is reported as an uncertified prefix',
    /certified/.test(message), message);
  if (outcome.index) {
    check('out-of-order frame leaves the frames already published untouched',
      outcome.index.numFrames > 0 && outcome.index.presentationTimes[0] === 0,
      `${outcome.index.numFrames} frames`);
  }
}

if (failures) {
  console.error(`progressive-index: ${failures} check(s) failed`);
  process.exit(1);
}
console.log('progressive-index: OK');
