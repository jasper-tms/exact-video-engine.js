// Drives test-frame-index.html through the browser named by TEST_BROWSER
// (chromium, webkit, or firefox) and checks, frame by frame, that asking an
// engine for frame n both PUTS frame n on screen and gets frame n reported back.
// Ground truth comes from the pixels (the clips identify each frame by the
// position of a white bar), not from any clock. Each case carries explicit
// per-browser expectations; see the CASES comment for the platform differences.
//
// What is being proved, per container family:
//
// counter-vfr.mp4: the <video> element cannot map a variable-frame-rate clip
// without the container's real timestamp table — the same table WebCodecs
// decodes from. That is why ContainerIndex is built even when WebCodecs is not
// in play.
//
// counter-vfr.webm: the same claim for a container mp4box cannot parse. Passing
// here means the engine's own Matroska scan really did read the frame
// timestamps out of the clusters — on the <video> element, and (since the scan
// also builds a sample table) through WebCodecs, where the same clip's frames
// must come out right from byte ranges the scan recorded.
//
// counter-vfr.mkv: H.264 in Matroska, which no browser under test can play
// through a <video> element on every engine — WebKit demuxes no Matroska at all.
// It is only playable because the Matroska index feeds WebCodecs, so this case
// failing means that path is gone, not merely slower.
//
// counter-vfr-fragmented.mp4: the same claim for a fragmented MP4, whose sample
// table lives in moof boxes scattered through the file rather than a central
// moov. Passing here means the fragment pass really assembled the per-frame
// table out of the truns.
//
// counter-cfr.ogv: the engine's own Ogg page scan (src/ogg.js). Only walkable
// where the browser still decodes Theora; elsewhere the page reports
// { unplayable: true } and the case is skipped (the parser itself is pinned
// browser-independently by test/ogg-table-test.mjs).
//
// counter-mp4v.mp4: MPEG-4 Part 2, which mp4box registers no sample entry for,
// so the engine reads the track's own bytes to find it at all. Only WebKit
// decodes this codec, so the case proves two different things on two different
// browsers: that the rescued index really is frame-exact where it can play, and
// that it is refused cleanly — not hung, not played with guessed numbers —
// where it cannot.
//
// counter-elst.mp4: the element's timeline does not always start at zero. This
// clip's first frame reports mediaTime 0.133, so an engine that assumed the two
// timelines coincided would report every frame number shifted. Passing here
// means the calibration in NativeVideoEngine is genuinely finding the offset,
// not just getting away with a zero one.
//
// There are no approximate cases anymore: a clip the engine cannot index is
// refused at load ("index or refuse", see plan_always_build_an_index.md), which
// robustness-test.mjs pins.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { launchBrowser, serverBase, browserName } from './harness.mjs';

// firstBar: the bar position of the clip's own frame 0. It is the frame index
// within the SOURCE clip the frames were drawn from, so it is 0 for clips that
// start at the beginning and 10 for counter-elst.mp4, whose head was cut (see
// make-test-clips.sh). Pinning it is what turns "the frames advance one for
// one" into "the frames are the right frames".
// Every case pins THREE things per browser: `exact`, whether all frames land on
// screen and are reported correctly; `indexExact`, whether the engine kept the
// container's real timestamp table (engine.frameIndexIsExact); and `tier`, which
// engine the ladder landed on. The tier is what keeps a case honest about HOW it
// passed — the WebM cases below passed for a year on the <video> fallback, and
// would have gone on passing there after the Matroska sample table was supposed
// to put them on WebCodecs. A case may instead expect `refused`, for a (clip,
// browser) pair with no working tier at all, where the engine must error rather
// than play it wrongly or wait forever.
//
// The `chromium` values are the reference. `webkit` and `firefox` inherit them
// unless they name an override, and every override below is a REAL, empirically
// confirmed platform difference, never a loosened assertion:
//
//   * Firefox's requestVideoFrameCallback echoes a SEEK TARGET rather than the
//     landed frame's true presentation timestamp. The engine's runtime index
//     watcher now ignores post-seek presentations (they are not evidence
//     against the table — see _checkPresentedFrame), so Firefox keeps the index
//     and these cases expect full exactness. If a case fails only on Firefox,
//     that suppression has regressed.
//
//   * WebKit fires no requestVideoFrameCallback for a <video> seek that resolves
//     to the frame already on screen. test-frame-index.html primes the element
//     off frame 0 before its loop, which covers the once-per-clip collision at
//     the start, but cases that collide MID-loop (the edit-list clips'
//     calibrated in-frame seeks) would hang the presented-frame wait, so they
//     are skipped with the reason inline; the behaviour they would show is
//     covered by a sibling case that does run on WebKit.
const CASES = [
  { file: 'counter-cfr.mp4', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true,
    tier: 'webcodecs' },
  { file: 'counter-cfr.mp4', mode: 'native-index', firstBar: 0, exact: true, indexExact: true,
    tier: 'native' },

  { file: 'counter-vfr.mp4', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true,
    tier: 'webcodecs' },
  { file: 'counter-vfr.mp4', mode: 'native-index', firstBar: 0, exact: true, indexExact: true,
    tier: 'native' },

  { file: 'counter-elst.mp4', mode: 'webcodecs', firstBar: 10, exact: true, indexExact: true,
    tier: 'webcodecs' },
  { file: 'counter-elst.mp4', mode: 'native-index', firstBar: 10, exact: true, indexExact: true,
    tier: 'native',
    // Skipped on WebKit: the edit list makes the calibrated first seek land
    // inside the frame the element already presents, and WebKit fires no
    // requestVideoFrameCallback for it, so the wait hangs. The edit-list
    // calibration itself is covered on WebKit via the webcodecs case above
    // (same clip, same firstBar 10).
    webkit: { skip: 'WebKit fires no requestVideoFrameCallback for the edit-list '
      + "clip's calibrated in-frame seek; calibration covered by the webcodecs case" } },

  // A LEADING EMPTY EDIT of real size. counter-elst above carries one too (a
  // 0.133s gap), but its head was also cut, so its frame 0 is source frame 10 and
  // the small gap could pass for rounding. This clip is counter-cfr copied frame
  // for frame behind a deliberate 3-second empty edit (media_time -1), so its
  // frame 0 IS source frame 0 (firstBar 0) and the gap is unmistakable. The
  // element and both engines honor it: display frame 0 is reported not at t = 0
  // but at 3.0s into the composition timeline — the number QuickTime and a <video>
  // element compute — which firstFrameTime pins on the real file, the behaviour a
  // frame-number walk cannot see. (The clip's own audio track picked up a tiny
  // ~23ms encoder-priming empty edit for free; the video track this indexes does
  // not, but the fix would report that honestly too rather than misfire on it.)
  { file: 'counter-leading-gap-elst.mp4', mode: 'webcodecs', firstBar: 0, exact: true,
    indexExact: true, tier: 'webcodecs', firstFrameTime: 3 },
  { file: 'counter-leading-gap-elst.mp4', mode: 'native-index', firstBar: 0, exact: true,
    indexExact: true, tier: 'native', firstFrameTime: 3,
    // Skipped on WebKit for the same reason as counter-elst: the calibrated first
    // seek lands inside the frame the element already presents and WebKit fires no
    // requestVideoFrameCallback for it. The reported-time shift is covered on
    // WebKit by the webcodecs case above (same clip, same firstFrameTime 3).
    webkit: { skip: 'WebKit fires no requestVideoFrameCallback for the edit-list '
      + "clip's calibrated in-frame seek; the gap's reported time is covered by the "
      + 'webcodecs case' } },

  // A TRIMMING edit list. Unlike counter-elst above (a shifting list that still
  // presents every frame in the file), this clip's container holds all 30 source
  // frames but the edit list presents only 20 of them, starting at source frame 5
  // — mid-group-of-pictures, so the four frames before it are decoded (to
  // reconstruct frame 5) but never shown. The index numbers frames over just the
  // presented window, so display frame 0 IS source frame 5 (firstBar 5) and there
  // are 20 frames. Passing on the pixels proves the trim is applied identically on
  // both engines: the same 20 frames, correctly numbered, whichever path plays.
  { file: 'counter-trimming-elst.mp4', mode: 'webcodecs', firstBar: 5, exact: true, indexExact: true,
    tier: 'webcodecs' },
  { file: 'counter-trimming-elst.mp4', mode: 'native-index', firstBar: 5, exact: true, indexExact: true,
    tier: 'native',
    // Gecko presents a trimmed clip UNTRIMMED (source frame k where the
    // container's presentation window says k + trim) while reporting the trimmed
    // duration — a whole-frame shift no runtime check can see, empirically
    // confirmed by this very case (all 20 frames landed exactly 5 early). The
    // native engine now refuses that combination up front
    // (index.trimmedByEditList + Gecko), so this case cannot walk frames on
    // Firefox; the webcodecs case above proves the trim frame-exact there.
    firefox: { skip: 'Gecko presents a trimming edit list untrimmed; the native '
      + 'path refuses it (frame numbers would all be shifted by the trim). The '
      + 'trim is proven frame-exact on Firefox by the webcodecs case.' },
    // WebKit runs a trimmed clip's currentTime on the media timeline yet reports
    // the shorter edited duration, so the calibrated timeline overruns what the
    // element will seek to and the engine REFUSES the clip (index-or-refuse; see
    // _calibratedTimelineReachable). The in-frame-seek hang above also applies,
    // so the case is skipped rather than asserted as a refusal here;
    // the trim is proven frame-exact on WebKit by the webcodecs case.
    webkit: { skip: 'WebKit maps a trimmed clip\'s <video> timeline inconsistently '
      + '(media-timeline currentTime, edited duration); the native path refuses it '
      + 'and the in-frame-seek hang applies. The trim is proven frame-exact on '
      + 'WebKit by the webcodecs case.' } },

  // WebM, which mp4box cannot parse at all: these run on the engine's own
  // Matroska cluster scan. The VFR clip is the one an assumed constant frame
  // rate would mismap; it must be exact from the real cluster timestamps.
  { file: 'counter-cfr.webm', mode: 'native-index', firstBar: 0, exact: true, indexExact: true,
    tier: 'native' },
  { file: 'counter-vfr.webm', mode: 'native-index', firstBar: 0, exact: true, indexExact: true,
    tier: 'native' },

  // The same clips through WebCodecs. The Matroska scan builds a full decode
  // table (byte ranges and keyframe flags, not just timestamps) and a decoder
  // configuration, so a WebM now reaches the engine-owned clock and named-frame
  // pixels that used to be MP4-only. The `tier` assertion is the point of these
  // cases: without it they would pass just as well on the <video> fallback, which
  // is exactly what they used to do.
  { file: 'counter-vfr.webm', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true,
    tier: 'webcodecs' },
  // VP8, whose codec string ('vp8') is the one the parser does not have to derive
  // from anything — and the codec a browser's own MediaRecorder writes.
  { file: 'counter-vp8.webm', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true,
    tier: 'webcodecs' },
  // AV1: the codec string comes out of the av1C record, which also serves as the
  // decoder description. WebKit decodes AV1 in neither WebCodecs nor <video>, so
  // there the whole ladder runs out and the clip is refused — asserted, not
  // skipped, because a refusal that took forever instead of failing fast would be
  // just as broken (the <video> element reaches HAVE_METADATA, reports no error,
  // and simply never presents a frame; NativeVideoEngine's stall guard is what
  // turns that into an error).
  { file: 'counter-av1.webm', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true,
    tier: 'webcodecs',
    webkit: { refused: 'WebKit decodes AV1 in neither WebCodecs nor <video>' } },

  // H.264 in Matroska (.mkv) — the clip that was not merely inexact before this
  // work but UNPLAYABLE on WebKit, which demuxes no Matroska at all: the engine
  // built a perfect index and then had only a <video> element that refused the
  // file. Now the sample table feeds WebCodecs and it plays everywhere. The
  // variable-rate frames make the timestamps falsifiable, and the pixels landing
  // right prove the byte ranges: a sample offset off by a byte does not decode to
  // the correct bar, it decodes to nothing.
  { file: 'counter-vfr.mkv', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true,
    tier: 'webcodecs' },

  // Fragmented MP4 (empty_moov: every sample lives in a moof fragment, not the
  // moov). The engine detects fragmentation and reads the whole file so every
  // moof's samples are in the table. The constant-rate clip pins the plumbing on
  // both engines; the VARIABLE-rate twin is the real proof — its frames mismap
  // under any assumed constant rate, so exactness means the per-frame timestamps
  // really came out of the truns.
  { file: 'counter-fragmented.mp4', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true,
    tier: 'webcodecs' },
  { file: 'counter-fragmented.mp4', mode: 'native-index', firstBar: 0, exact: true, indexExact: true,
    tier: 'native' },
  { file: 'counter-vfr-fragmented.mp4', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true,
    tier: 'webcodecs' },
  { file: 'counter-vfr-fragmented.mp4', mode: 'native-index', firstBar: 0, exact: true, indexExact: true,
    tier: 'native' },

  // AVI, indexed by the engine's own RIFF parser (src/avi.js). AVI has NO native
  // <video> tier — no browser plays it through a <video> element — so the only
  // mode is 'webcodecs', and the engine's own H.264 decode is what puts pixels on
  // screen. counter-idx1.avi carries the legacy idx1 index; counter-opendml.avi
  // the OpenDML indx/ix00 hierarchical index that the real >2 GB captures use.
  // Both are the 30 counter frames (bar at x = 5n), so exact frames prove the
  // engine read the right byte ranges out of the index and decoded the H.264 the
  // AVI carries. The engine converts AVI's Annex B H.264 to AVCC and configures an
  // avcC description (WebKit's WebCodecs claims to support Annex-B-no-description
  // and then fails the decode — see the decode-support matrix), and AVCC decodes
  // on all three engines, so there is no per-browser override: all three play via
  // the webcodecs tier, exactly like the MP4 H.264 webcodecs cases.
  { file: 'counter-idx1.avi', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true,
    tier: 'webcodecs' },
  { file: 'counter-opendml.avi', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true,
    tier: 'webcodecs' },

  // Motion JPEG, whose frames are whole JPEG images rather than a coded video
  // stream. No browser has an MJPEG VideoDecoder, so these do not decode through
  // one: src/image-frame-decoder.js hands each frame's bytes to the browser's own
  // JPEG decoder and wraps the result in a VideoFrame, behind an interface the
  // decode driver cannot tell from a VideoDecoder's. They report the `webcodecs`
  // tier because that is the engine playing them — the tier is which ENGINE owns
  // the clock and the canvas, not which decoder it fed.
  //
  // Two containers, because the path belongs to neither: in AVI the codec is the
  // FourCC `MJPG` read by the engine's own RIFF parser, and in QuickTime it is
  // the `jpeg` sample entry read by mp4box. Exact frames on both prove the byte
  // ranges are right to the byte — a JPEG decoder is unforgiving about being
  // handed a frame that starts eight bytes early.
  { file: 'counter-mjpeg.avi', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true,
    tier: 'webcodecs' },
  { file: 'counter-mjpeg.mov', mode: 'webcodecs', firstBar: 0, exact: true, indexExact: true,
    tier: 'webcodecs' },

  // MPEG-4 Part 2 in an MP4 (`mp4v`) — OpenCV's VideoWriter default, and the
  // one fixture whose expectation is inverted: the reference browsers refuse it
  // and only WebKit plays it. No browser's WebCodecs decodes MPEG-4 Part 2, and
  // no Blink or Gecko build decodes it in a <video> element either (Chromium's
  // demuxer rejects the stream outright), so both modes end in a refusal there.
  // WebKit's element decodes it through AVFoundation, and the container index —
  // which exists at all only because src/container-index.js reads the `mp4v`
  // sample entry mp4box files as metadata — is what makes it frame-exact.
  //
  // The `webcodecs` case is not redundant with the `native-index` one: it pins
  // that WebCodecs REJECTS this codec honestly and the ladder falls back, rather
  // than accepting it and failing later. Its expected tier is `native` for that
  // reason. Refusals are asserted, not skipped, because a refusal that hung
  // instead of failing fast would be just as broken.
  { file: 'counter-mp4v.mp4', mode: 'webcodecs', firstBar: 0,
    refused: 'no Blink or Gecko build decodes MPEG-4 Part 2, in WebCodecs or in a <video> element',
    webkit: { exact: true, indexExact: true, tier: 'native' } },
  { file: 'counter-mp4v.mp4', mode: 'native-index', firstBar: 0,
    refused: 'no Blink or Gecko build decodes MPEG-4 Part 2, in WebCodecs or in a <video> element',
    webkit: { exact: true, indexExact: true, tier: 'native' } },

  // A WebM whose FIRST track entry is audio and whose second is the video (the
  // 30 counter frames). The Matroska cluster scan must skip the audio track and
  // index only the video blocks; an off-by-one that indexed the first track would
  // count audio packets as frames and every mapping here would be wrong. Exact
  // frames prove the scan really keyed on the video track number. firstBar is 0:
  // the video frames are the counter frames, unshifted.
  { file: 'counter-audio-first.webm', mode: 'native-index', firstBar: 0, exact: true, indexExact: true,
    tier: 'native' },

  // Ogg/Theora, indexed by the engine's own page scan (src/ogg.js). Only the
  // native path exists for Ogg (no sample table for WebCodecs), and only where
  // the browser still ships a Theora decoder — the page reports
  // { unplayable: true } elsewhere and the case is counted as a skip. The
  // audio-muxed variant additionally proves Vorbis pages are not counted as
  // video frames. Browser-independent parser correctness is pinned by
  // test/ogg-table-test.mjs; what this adds is timeline agreement with a real
  // element's demuxer where one exists.
  { file: 'counter-cfr.ogv', mode: 'native-index', firstBar: 0, exact: true, indexExact: true,
    tier: 'native',
    skipIfUnplayable: true },
  { file: 'counter-vorbis-audio.ogv', mode: 'native-index', firstBar: 0, exact: true, indexExact: true,
    tier: 'native',
    skipIfUnplayable: true },
];

// Resolve a case's expectation for the browser under test: the base (chromium)
// values, overridden by any browser-specific entry. Returns null to signal skip.
//
// `refused` is an expectation in its own right, not a skip: some (clip, browser)
// pairs have no tier left — no WebCodecs decoder and no <video> decoder — and the
// engine must say so with an error rather than play them wrongly or hang waiting
// for a frame that never comes.
function expectationFor(testCase) {
  const override = testCase[browserName] || {};
  if (override.skip) {
    console.log(`SKIP ${testCase.file} ${testCase.mode} on ${browserName}: ${override.skip}`);
    return null;
  }
  if (override.refused) return { refused: override.refused };
  // A case may be refused in the BASE expectation too. Most clips play on the
  // reference browser and a minority need an override; a clip only ONE engine
  // can decode inverts that, so the base states the refusal and the browser that
  // does play it overrides with a walk.
  if (testCase.refused && override.exact === undefined) {
    return { refused: testCase.refused };
  }
  return {
    exact: override.exact !== undefined ? override.exact : testCase.exact,
    indexExact: override.indexExact !== undefined ? override.indexExact : testCase.indexExact,
    // Which engine the ladder must land on: 'webcodecs' or 'native'. Optional —
    // a case without it asserts only the frames — but it is what keeps a case
    // from passing on the wrong tier, which is how a container silently losing
    // its WebCodecs path would otherwise go unnoticed.
    tier: override.tier !== undefined ? override.tier : testCase.tier,
  };
}

const clipsDirectory = join(dirname(fileURLToPath(import.meta.url)), 'clips');

const browser = await launchBrowser();
let failures = 0;

async function runCase(file, mode) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${serverBase}/test/test-frame-index.html?file=${file}&mode=${mode}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 60000 })
    .catch(() => {});
  const outcome = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();
  return outcome;
}

// A load-time race in NativeVideoEngine (not specific to this test matrix, and
// present before it) can make an edit-list clip's duration read transiently
// wrong right after 'loadeddata' on Chromium. The engine now waits for the
// duration to settle before judging the index (see _indexDescribesElement), but
// a genuinely slow settle can still lose the race, and under index-or-refuse
// that surfaces as a load refusal rather than a fallback. It resolves one way
// or the other per load, so a case that unexpectedly refused gets a fresh roll
// by reloading. We retry ONLY that signature — expected a walk, got a refusal
// or a dropped index — so a real regression still fails every attempt.
const MAX_ATTEMPTS = 4;
async function runCaseExpectingIndex(file, mode, wantIndex) {
  let outcome = await runCase(file, mode);
  let attempts = 1;
  while (wantIndex && attempts < MAX_ATTEMPTS
      && ((outcome.result && outcome.result.frameIndexIsExact === false) || outcome.err)) {
    attempts += 1;
    outcome = await runCase(file, mode);
  }
  return outcome;
}

for (const testCase of CASES) {
  const { file, mode, firstBar } = testCase;
  const expectation = expectationFor(testCase);
  if (!expectation) continue;   // skipped on this browser, with a reason printed

  // A fixture that could not be generated on this machine (no Theora encoder
  // anywhere — see make-test-clips.sh) is a skip, not a failure.
  if (!existsSync(join(clipsDirectory, file))) {
    console.log(`SKIP ${file} ${mode}: fixture not generated on this machine`);
    continue;
  }

  const { result, err } = await runCaseExpectingIndex(file, mode, expectation.indexExact);

  // A case expected to be refused: an error is the pass, and the driver's
  // per-case timeout (which reports no result at all) is the fail, so a hang
  // cannot masquerade as a refusal.
  if (expectation.refused) {
    const refused = !!err;
    if (!refused) failures += 1;
    console.log(`${refused ? 'PASS' : 'FAIL'} ${file} ${mode}: `
      + `${refused ? 'refused' : 'was NOT refused'} — ${expectation.refused}`
      + (refused ? '' : ` [${result ? result.tier : 'no result: timed out'}]`));
    continue;
  }

  if (result && result.unplayable) {
    if (testCase.skipIfUnplayable) {
      console.log(`SKIP ${file} ${mode}: ${browserName} cannot decode ${result.mime}`);
    } else {
      console.log(`FAIL ${file} ${mode}: ${browserName} reports ${result.mime} unplayable`);
      failures += 1;
    }
    continue;
  }

  if (err || !result) {
    console.log(`FAIL ${file} ${mode}: ${err || 'no result (timed out)'}`);
    failures += 1;
    continue;
  }

  const wrongPixels = result.rows.filter((r) => r.visible !== r.asked + firstBar);
  const wrongReports = result.rows.filter((r) => r.reported !== r.asked);
  const exact = wrongPixels.length === 0 && wrongReports.length === 0;
  const exactOk = exact === expectation.exact;
  const indexOk = result.frameIndexIsExact === expectation.indexExact;
  // engine.tier reads 'webcodecs' or 'native (container index, presented clock)',
  // so match on the leading word.
  const tierOk = !expectation.tier || result.tier.startsWith(expectation.tier);
  // Reported presentation time of display frame 0, when a case pins it (edit-list
  // clips whose leading empty edit shifts the origin off zero). A frame is ~33ms,
  // so 5ms is far below one frame yet well above the movie-vs-media rounding.
  const timeOk = testCase.firstFrameTime === undefined
    || Math.abs(result.firstFrameTime - testCase.firstFrameTime) < 5e-3;
  const pass = exactOk && indexOk && tierOk && timeOk;
  if (!pass) failures += 1;

  const count = result.rows.length;
  const detail = exact
    ? `all ${count} frames exact`
    : `${wrongPixels.length}/${count} wrong frame on screen, `
      + `${wrongReports.length}/${count} misreported`;
  const mismatch = (indexOk ? ''
    : ` — frameIndexIsExact=${result.frameIndexIsExact}, expected ${expectation.indexExact}`)
    + (tierOk ? '' : ` — tier '${result.tier}', expected the ${expectation.tier} tier`)
    + (timeOk ? ''
      : ` — frame 0 reported at ${result.firstFrameTime}s, expected ${testCase.firstFrameTime}s`);
  console.log(`${pass ? 'PASS' : 'FAIL'} ${file} ${mode}: ${detail}`
    + ` [${result.tier}, frameIndexIsExact=${result.frameIndexIsExact}]${mismatch}`);

  if (!exactOk) {
    const show = (expectation.exact ? [...wrongPixels, ...wrongReports] : result.rows).slice(0, 6);
    for (const r of show) {
      console.log(`       asked ${r.asked} -> on screen `
        + `${r.visible - firstBar} (bar ${r.visible}), reported ${r.reported}`);
    }
  }
}

await browser.close();
process.exit(failures ? 1 : 0);
