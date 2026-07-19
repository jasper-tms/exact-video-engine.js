// Unit test for trimming-edit-list handling in ContainerIndex (src/container-index.js).
// The ISOBMFF demux itself needs mp4box + a browser, but the two pieces the
// edit-list feature adds are pure and testable in plain Node against synthetic
// sample tables that mirror the real fixtures:
//
//   _editListWindow(track)   turns an elst into a presented composition-time
//                            window, in media units (movie-vs-media timescale
//                            conversion included).
//   _buildTables(samples, window)  numbers the display frames over only the
//                            presented samples while keeping the full decode set.
//
// The browser-side frame-index test then proves the whole path pixel-exact on
// counter-trimming-elst.mp4; this pins the arithmetic cheaply and exhaustively.
import { ContainerIndex } from '../src/container-index.js';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} edit-list ${name}: ${detail}`);
}

const MEDIA_TS = 15360;   // counter-cfr's media timescale
const MOVIE_TS = 1000;    // its movie timescale
const FRAME = 512;        // 30 fps in media units (15360 / 30)
const N = 30;

// A constant-frame-rate decode table like counter-cfr's: 30 frames, a keyframe
// every 10 (the fixture's -g 10), cts = k * FRAME.
function makeSamples() {
  return Array.from({ length: N }, (_, k) => ({
    offset: k * 100, size: 100, is_sync: k % 10 === 0,
    cts: k * FRAME, duration: FRAME, timescale: MEDIA_TS,
  }));
}
const index = new ContainerIndex({ size: 0 });

// --- _editListWindow -----------------------------------------------------------
const track = (edits) => ({ edits, timescale: MEDIA_TS, movie_timescale: MOVIE_TS });

check('no edit list -> null (present everything)',
  index._editListWindow(track(undefined)) === null, 'undefined edits');

// counter-cfr: one identity edit covering the whole movie.
const identity = index._editListWindow(track([{ segment_duration: 1000, media_time: 0, media_rate_integer: 1 }]));
check('identity edit -> window covers all frames',
  identity && identity.start === 0 && Math.abs(identity.end - MEDIA_TS) < 1,
  JSON.stringify(identity));

// counter-elst: a leading EMPTY edit (a 0.133s gap, media_time -1) then a normal
// edit. The empty one is a presentation offset, not a trim, so the window still
// starts at 0 and covers every frame in the file.
const withEmptyLead = index._editListWindow(track([
  { segment_duration: 133, media_time: -1, media_rate_integer: 1 },
  { segment_duration: 667, media_time: 0, media_rate_integer: 1 },
]));
check('empty-lead + normal edit -> window from 0 (calibration handles the gap)',
  withEmptyLead && withEmptyLead.start === 0
    && Math.abs(withEmptyLead.end - 667 * MEDIA_TS / MOVIE_TS) < 1,
  JSON.stringify(withEmptyLead));

// counter-trimming-elst: start 5 frames in (media_time 2560), present 20 frames
// (segment_duration 660 movie units). This is the real trim.
const trim = index._editListWindow(track([{ segment_duration: 660, media_time: 2560, media_rate_integer: 1 }]));
check('trimming edit -> window starts mid-clip, spans the presented duration',
  trim && trim.start === 2560 && Math.abs(trim.end - (2560 + 660 * MEDIA_TS / MOVIE_TS)) < 1,
  JSON.stringify(trim));

// Anything more elaborate than one normal-rate edit is left to present everything
// (null), so the WebCodecs path shows all frames and the native duration check
// still guards it.
check('two presented edits -> null (out of scope, present everything)',
  index._editListWindow(track([
    { segment_duration: 300, media_time: 0, media_rate_integer: 1 },
    { segment_duration: 300, media_time: 5120, media_rate_integer: 1 },
  ])) === null, 'two non-empty edits');
check('a rate-changed edit -> null',
  index._editListWindow(track([{ segment_duration: 660, media_time: 2560, media_rate_integer: 2 }])) === null,
  'media_rate_integer 2');

// --- _buildTables with no window: the untrimmed construction, unchanged --------
index._buildTables(makeSamples(), null);
check('no window: every frame is presented', index.numFrames === N, `numFrames=${index.numFrames}`);
check('no window: decode set is the full table', index.samples.length === N, `samples=${index.samples.length}`);
check('no window: display 0 at t=0, display 0 -> decode 0',
  index.presentationTimes[0] === 0 && index.displayToDecode[0] === 0,
  `pt0=${index.presentationTimes[0]}, d2d0=${index.displayToDecode[0]}`);
check('no window: keyframes at 0,10,20',
  JSON.stringify(index.keyframeDecodeIndices) === JSON.stringify([0, 10, 20]),
  JSON.stringify(index.keyframeDecodeIndices));

// --- _buildTables with the trimming window: 20 presented of 30 decoded ---------
index._buildTables(makeSamples(), trim);
check('trim: presents exactly 20 frames', index.numFrames === 20, `numFrames=${index.numFrames}`);
check('trim: full 30-sample decode set is kept (the decoder needs 0..4 for 5)',
  index.samples.length === N, `samples=${index.samples.length}`);
check('trim: display 0 is source frame 5 (the first presented frame)',
  index.displayToDecode[0] === 5, `display 0 -> decode ${index.displayToDecode[0]}`);
check('trim: display 19 is source frame 24 (the last presented frame)',
  index.displayToDecode[19] === 24, `display 19 -> decode ${index.displayToDecode[19]}`);
check('trim: display 0 sits at t=0 (numbered from the first presented frame)',
  index.presentationTimes[0] === 0, `pt0=${index.presentationTimes[0]}`);
// The trimmed-out frames must NOT appear in the decoded-frame lookup, so when the
// decoder emits them (it must, to reconstruct frame 5) VideoEngine drops them.
const microsOf = (k) => Math.round(k * FRAME * 1e6 / MEDIA_TS);
check('trim: trimmed-out source frame 4 is not a presented frame',
  index.microsToDisplay.get(microsOf(4)) === undefined, 'frame 4 absent from microsToDisplay');
check('trim: source frame 5 maps to display 0',
  index.microsToDisplay.get(microsOf(5)) === 0, `frame 5 -> ${index.microsToDisplay.get(microsOf(5))}`);
check('trim: source frame 25 (past the window) is not presented',
  index.microsToDisplay.get(microsOf(25)) === undefined, 'frame 25 absent');
check('trim: duration is the 20 presented frames, not the 30 decoded',
  Math.abs(index.duration - 20 * FRAME / MEDIA_TS) < 1e-9, `duration=${index.duration}`);

process.exit(failures ? 1 : 0);
