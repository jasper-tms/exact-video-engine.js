// Unit test for VideoEngine's decode driver against a decoder that holds frames
// back by more than the old fixed REORDER_DEPTH of 16 samples.
//
// A level 5.1 H.264 stream that declares no max_num_reorder_frames (a macOS
// screen recording at 2606x1172 is exactly this) makes the decoder assume its
// level's whole decoded-picture buffer, 15 frames, and Chrome's hardware decoder
// was measured emitting each frame only after 13 to 18 further samples had been
// fed. The driver used to stop feeding 16 samples past its target and conclude
// the frame had been evicted, so every frame needing 17 or 18 tripped the
// restart circuit-breaker ("cannot decode frame N; holding") and playback
// updated once per keyframe. The driver now bounds the wait by the stream's
// declared depth plus pipeline slack.
//
// A browser test cannot pin this: how far a decoder lags is the decoder's
// choice, and a software decoder in a test browser may not lag at all. So this
// drives the real driver against a stub decoder whose lag is set by hand, and
// pins both halves:
//   - with the per-clip bound, every frame of the clip surfaces, walking forward
//     and jumping around, with no circuit-breaker verdict;
//   - forced back to the old bound of 16, the same stub strands a frame — the
//     proof that the stub reproduces the bug and the pass above is the fix.
//
// Runs in plain Node: the stub replaces the decoder and the byte reader.
import { VideoEngine } from '../src/video-engine.js';
import { buildAvcC, buildH264SequenceParameterSet } from './bitstream-fixtures.mjs';

const FRAME_COUNT = 120;
const KEYFRAME_INTERVAL = 57;
const DECODER_LAG_SAMPLES = 18;
const MICROSECONDS_PER_FRAME = 16667;

globalThis.EncodedVideoChunk = class { constructor(init) { Object.assign(this, init); } };
globalThis.createImageBitmap = async () => ({ close() {} });

// Emits each frame only once DECODER_LAG_SAMPLES later samples have been fed,
// or on flush — the way a decoder assuming a deep reorder buffer behaves.
class LaggingDecoder {
  constructor(output) { this._output = output; this._held = []; this.decodeQueueSize = 0; this.state = 'configured'; }
  configure() { this.state = 'configured'; }
  reset() { this._held = []; }
  close() { this.state = 'closed'; }
  decode(chunk) {
    this._held.push(chunk);
    while (this._held.length > DECODER_LAG_SAMPLES) this._emit(this._held.shift());
  }
  async flush() { while (this._held.length) this._emit(this._held.shift()); }
  _emit(chunk) {
    this._output({ timestamp: chunk.timestamp, displayWidth: 2606, displayHeight: 1172, close() {} });
  }
}

function makeEngine() {
  const canvas = { getContext: () => ({ clearRect() {}, drawImage() {} }), width: 0, height: 0 };
  const engine = new VideoEngine(canvas);
  const samples = [], keyframeDecodeIndices = [], microsToDisplay = new Map();
  for (let i = 0; i < FRAME_COUNT; i++) {
    const cts = i * MICROSECONDS_PER_FRAME;
    samples.push({ offset: i * 1000, size: 1000, isSync: i % KEYFRAME_INTERVAL === 0, cts, duration: MICROSECONDS_PER_FRAME });
    if (i % KEYFRAME_INTERVAL === 0) keyframeDecodeIndices.push(i);
    microsToDisplay.set(cts, i);
  }
  const avcC = buildAvcC(buildH264SequenceParameterSet({
    levelIdc: 51, widthInMacroblocks: 163, heightInMapUnits: 74, declaredReorderFrames: null,
  }));
  const presentationTimes = Float64Array.from({ length: FRAME_COUNT }, (_, i) => i * MICROSECONDS_PER_FRAME / 1e6);
  engine._adoptIndex({
    presentationTimes,
    frameAtTime: (t) => Math.min(FRAME_COUNT - 1, Math.max(0, Math.floor(t * 1e6 / MICROSECONDS_PER_FRAME + 1e-9))),
    reader: null, timescale: 1e6, rotation: 0, videoWidth: 2606, videoHeight: 1172,
    decoderConfig: { codec: 'avc1.4d0033', codedWidth: 2606, codedHeight: 1172, description: avcC },
    samples, keyframeDecodeIndices, microsToDisplay,
    displayToDecode: Int32Array.from({ length: FRAME_COUNT }, (_, i) => i),
    numFrames: FRAME_COUNT, duration: FRAME_COUNT * MICROSECONDS_PER_FRAME / 1e6,
    completionState: 'complete',
  });
  engine._videoDecoder = new LaggingDecoder((frame) => engine._absorb(frame));
  engine._ensureBytes = async () => {};
  engine._sliceSample = () => new Uint8Array(1);
  return engine;
}

// Steer to `frame` and wait until it is decoded or the driver gives up on it.
async function reach(engine, frame) {
  engine._request(frame);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2000) {
    if (engine._cache.has(frame)) return 'decoded';
    if (engine._stalledFrame === frame) return 'stranded';
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return 'timed out';
}

let failures = 0;
function check(name, condition, detail) {
  if (!condition) { failures += 1; console.error(`FAIL decoder-lag: ${name}${detail ? `: ${detail}` : ''}`); }
}

const warnings = [];
const originalWarn = console.warn;
console.warn = (...parts) => warnings.push(parts.join(' '));

// The per-clip bound: every frame surfaces.
{
  const engine = makeEngine();
  check('the bound reaches past the decoder\'s lag',
    engine._reorderDepth > DECODER_LAG_SAMPLES, `bound ${engine._reorderDepth}`);
  const walk = [...Array(FRAME_COUNT).keys()];
  const jumps = [100, 3, 60, 59, 20, 119, 0, 58];
  const outcomes = [];
  for (const frame of [...walk, ...jumps]) {
    const outcome = await reach(engine, frame);
    if (outcome !== 'decoded') outcomes.push(`${frame}: ${outcome}`);
  }
  check('every frame surfaces through a lagging decoder', outcomes.length === 0, outcomes.join(', '));
  check('the circuit-breaker never fires', !warnings.some((w) => /cannot decode frame/.test(w)),
    warnings.join(' | '));
}

// Control: the old engine (fixed bound of 16, read-ahead fed no further than its
// own window) strands a frame against the same decoder.
{
  warnings.length = 0;
  const engine = makeEngine();
  engine._reorderDepth = 16;
  engine._declaredReorderDepth = 0;
  const outcome = await reach(engine, 10);
  check('the old bound of 16 strands a frame (the stub reproduces the bug)',
    outcome === 'stranded', outcome);
}

console.warn = originalWarn;
if (failures) process.exit(1);
console.log('PASS decoder-lag: all cases');
