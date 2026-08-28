// Unit test for VideoEngine's rebuffering decision (_rebufferHold): when playing
// hits an undecoded frame, does the clock HOLD (buffer) or RUN (drop frames)?
//
// rebuffer-test.mjs drives the real engine over a throttled link, but that link
// is byte-bound, so it only exercises the network-stall hold. The other half —
// the decode-bound fallback, where a decoder that cannot keep up makes the hold
// give up and drop frames rather than lurch in slow motion — needs a decoder too
// slow to keep up, which no fixture reliably is. So this drives the state machine
// directly against a stubbed index and cache, where "which frames are decoded"
// and "which bytes are resident" are set by hand, and pins:
//   - a network stall (bytes absent) holds, and resumes only once rebufferSeconds
//     of content is downloaded ahead AND the frame is decoded (hysteresis);
//   - "downloaded ahead" counts decoded-OR-bytes-resident frames, so an already
//     played frame whose bytes are freed does not read as a gap;
//   - a decode-bound stall (bytes present, frame undecoded) recurring without
//     recovery flips to dropping frames, which a recovery interval retires;
//   - a network stall still holds even inside the drop-frames fallback;
//   - rebufferSeconds:0 never holds; a void or circuit-breaker frame never holds.
//
// Runs in plain Node: the decision reads only the index tables and cache maps,
// no browser and no decoder.
import { VideoEngine } from '../src/video-engine.js';

const FPS = 30;
const N = 200;

function makeEngine(options = {}) {
  const canvas = { getContext: () => ({ clearRect() {}, drawImage() {} }), width: 0, height: 0 };
  const engine = new VideoEngine(canvas, options);
  const times = new Float64Array(N);
  for (let i = 0; i < N; i++) times[i] = i / FPS;
  engine._index = {
    presentationTimes: times,
    frameAtTime: (t) => Math.min(N - 1, Math.max(0, Math.floor(t * FPS + 1e-9))),
  };
  engine.numFrames = N;
  engine.duration = N / FPS;
  engine.ready = true;
  engine.playing = true;
  engine._displayToDecode = Array.from({ length: N }, (_, i) => i);
  engine._samples = Array.from({ length: N }, (_, i) => ({ offset: i * 1000, size: 1000 }));
  engine._cache = new Map();
  engine._pending = new Set();
  engine._residentBytes = new Set();
  engine._bufferHolding = (offset) => engine._residentBytes.has(Math.floor(offset / 1000));
  engine.frameAtTime = (t) => engine._index.frameAtTime(t);
  return engine;
}
const decode = (e, ...frames) => frames.forEach((f) => e._cache.set(f, {}));
const bytes = (e, a, b) => { for (let i = a; i <= b; i++) e._residentBytes.add(i); };

let failures = 0;
function check(name, cond) {
  if (!cond) { failures += 1; console.error(`FAIL rebuffer-logic: ${name}`); }
}

// A decoded current frame with a full download ahead is not a stall.
{
  const e = makeEngine();
  e.playhead = 0; decode(e, 0, 1, 2); bytes(e, 0, 30);
  check('a ready frame advances', e._rebufferHold(1000) === false && e.rebuffering === false);
}

// Network stall (no bytes, undecoded) holds; hysteresis keeps holding until the
// download is rebufferSeconds ahead AND the frame is decoded.
{
  const e = makeEngine();
  e.playhead = 10 / FPS;
  check('network stall holds', e._rebufferHold(1000) === true && e.rebuffering === true);
  decode(e, 10); bytes(e, 10, 12);   // frame decoded but only ~0.07 s downloaded ahead
  check('short cushion keeps holding', e._rebufferHold(1016) === true);
  bytes(e, 10, 25);                  // now ~0.5 s downloaded ahead
  check('resumes on cushion + decoded', e._rebufferHold(1032) === false && e.rebuffering === false);
}

// A downloaded cushion whose current frame is not decoded yet keeps holding —
// there must be something to show, not just bytes.
{
  const e = makeEngine();
  e.playhead = 10 / FPS; e._rebufferHold(1000);
  bytes(e, 10, 60);   // lots downloaded, frame 10 still not decoded
  check('bytes without a decoded frame keep holding', e._rebufferHold(1016) === true);
  decode(e, 10);
  check('resumes once the frame decodes', e._rebufferHold(1032) === false);
}

// "Downloaded ahead" counts decoded OR bytes-resident: a just-played frame whose
// bytes are freed must not read as a gap that pins the hold for ever.
{
  const e = makeEngine();
  e.playhead = 2 / FPS; e._rebuffering = true;
  decode(e, 2, 3, 4, 5, 6, 7, 8);   // decoded; their bytes long freed
  bytes(e, 9, 120);                 // a resident block ahead
  check('decoded-or-bytes coverage resumes', e._rebufferHold(1000) === false && e.rebuffering === false);
}

// Decode-bound stalls (bytes present, frame undecoded) recurring without a
// recovery flip to dropping frames.
{
  const e = makeEngine();
  const stall = (at, f) => { e.playhead = f / FPS; bytes(e, f, f + 30); return e._rebufferHold(at); };
  const resume = (f) => { for (let i = f; i <= f + 12; i++) decode(e, i); e.playhead = f / FPS; e._rebufferHold(f * 0 + 5); };
  check('decode stall #1 holds', stall(0, 10) === true && e._decodeStallStreak === 1);
  resume(10);
  check('decode stall #2 holds', stall(500, 40) === true && e._decodeStallStreak === 2);
  resume(40);
  const held3 = stall(900, 70);
  check('decode stall #3 flips to dropping (no hold)',
    held3 === false && e._droppingFrames === true && e._decodeStallStreak >= 3);
}

// A network stall still holds even inside the drop-frames fallback.
{
  const e = makeEngine();
  e._droppingFrames = true; e._decodeStallStreak = 3; e._lastDecodeShortfall = 100;
  e.playhead = 50 / FPS;   // no bytes, undecoded
  check('network stall holds in dropping mode', e._rebufferHold(200) === true);
}

// A recovery interval with no decode shortfall retires the fallback.
{
  const e = makeEngine();
  e._droppingFrames = true; e._decodeStallStreak = 4; e._lastDecodeShortfall = 0;
  e.playhead = 5 / FPS; decode(e, 5, 6, 7); bytes(e, 5, 40);
  e._rebufferHold(3100);   // > DECODE_RECOVERY_SECONDS since the last shortfall
  check('recovery retires the fallback', e._droppingFrames === false && e._decodeStallStreak === 0);
}

// rebufferSeconds:0 disables the hold entirely.
{
  const e = makeEngine({ rebufferSeconds: 0 });
  e.playhead = 30 / FPS;   // undecoded, no bytes
  check('rebufferSeconds:0 never holds', e._rebufferHold(1000) === false && e.rebuffering === false);
}

// Reaching the last indexed frame resumes despite a short tail (Infinity ahead),
// so the end of the clip never freezes the clock.
{
  const e = makeEngine();
  e.playhead = 197 / FPS; e._rebuffering = true;
  decode(e, 197, 198, 199); bytes(e, 197, 199);
  check('end-of-index resumes on a short tail', e._rebufferHold(1000) === false);
}

// A void position (leading empty edit) has no frame to wait on: never holds.
{
  const e = makeEngine();
  const times = new Float64Array(N);
  for (let i = 0; i < N; i++) times[i] = (i + 5) / FPS;   // frame 0 presents at t = 5/FPS
  e._index.presentationTimes = times;
  e.playhead = 0;   // before the first presented time
  check('a void never holds', e._rebufferHold(1000) === false);
}

if (failures) {
  console.error(`rebuffer-logic: ${failures} failure(s)`);
  process.exit(1);
}
console.log('PASS rebuffer-logic: all cases');
