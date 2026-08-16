// Drives test-loop-region.html through the browser named by TEST_BROWSER and
// checks the loop region — `loopStartFrame`/`loopEndFrame`, the inclusive span
// that looping playback repeats in place of the whole clip.
//
// Five properties, each of which something plausible gets wrong:
//
//   1. Playing forward off the region's end wraps to its start, and REGION_END
//      is genuinely the last frame played: an off-by-one that wraps a frame
//      early or a frame late still loops, still looks like looping, and shows
//      the wrong frames.
//   2. The region bounds looping, not seeking. Clamping seeks into it is the
//      obvious way to implement "only play these frames", and it would take a
//      scrubber away from the host.
//   3. A playhead seeked PAST the region is not yanked back the instant it
//      lands — it plays on to the clip's end and wraps into the region from
//      there. This is the whole reason the implementation tests for a forward
//      CROSSING rather than for "playhead is past the end", and a version that
//      tested only the latter passes every other case here.
//   4. With `loop` false the region is inert. A region enforced unconditionally
//      would turn every non-looping host into a five-frame player.
//   5. With no region set, looping is bit for bit what it was before the
//      feature existed.
//
// The two tiers are asserted at different exactness, because they keep time
// differently — not because the contract differs (see the harness page).
//
// VideoEngine owns its playhead and is stepped here by a synthetic host clock,
// so its frame sequence is exact: REGION_END + 1 must never appear at all, and
// every wrap must land on REGION_START to the frame.
//
// The native tier cannot be that exact, and the slack is the ELEMENT's, not the
// engine's. The engine does the only two things available to it — fire the wrap
// off the presented-frame clock, seek to REGION_START — and the element still
// costs a frame at each edge:
//
//   * At the region's end, the wrap can only fire off a frame already on
//     screen, so REGION_END + 1 gets one frame of screen time. Firefox's
//     requestVideoFrameCallback also coalesces (its reported sequence skips
//     frames outright), which can push the frame the wrap first sees to
//     REGION_END + 2.
//   * At the region's start, Chromium resumes playback from a mid-seek on the
//     frame AFTER the seek target, so REGION_START is never reported presented
//     and the lap runs REGION_START + 1 onward. Probed and unfixable from here:
//     pausing across the seek, and aiming at the frame's start rather than its
//     midpoint, both still land a frame late there (the latter does fix
//     Firefox). WebKit lands exactly, on both counts.
//
// So the native cases assert the shape — wraps happen, repeatedly, from the
// region's end, back to its start, and playback never escapes the region — with
// one frame of tolerance at each edge, and leave the frame-exact claims to the
// WebCodecs tier, which is the default everywhere anyway.
//
// Expects the repo root served at http://localhost:8798 (run-tests.sh handles
// that) and Playwright (npm install).
import { launchBrowser, serverBase } from './harness.mjs';

const CLIP = 'counter-cfr.mp4';   // 30 frames at a constant 30 fps

// Describe a frame sequence compactly enough to read in a failure message.
const show = (frames) => `[${frames.join(' ')}]`;

// Every step is +1, except from REGION_END, which must step to REGION_START.
function checkStaysInRegion(frames, start, end, problems, label) {
  for (let i = 0; i < frames.length; i++) {
    if (frames[i] < start || frames[i] > end) {
      problems.push(`${label} left the region at index ${i}: frame ${frames[i]} `
        + `is outside [${start}, ${end}] — ${show(frames)}`);
      return;
    }
  }
  for (let i = 1; i < frames.length; i++) {
    const expected = frames[i - 1] === end ? start : frames[i - 1] + 1;
    if (frames[i] !== expected) {
      problems.push(`${label} played ${frames[i - 1]} then ${frames[i]}, expected `
        + `${expected} — ${show(frames)}`);
      return;
    }
  }
}

function countWraps(frames, start, end) {
  let wraps = 0;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i - 1] === end && frames[i] === start) wraps += 1;
  }
  return wraps;
}

// presentedFrame reads -1 until a first frame has gone on screen; that is a
// sampling artifact of the first tick, not a frame that was played.
const realFrames = (frames) => frames.filter((frame) => frame !== -1);

// Where each wrap landed, and the frame it wrapped away from. A wrap is the one
// thing in a forward-playing sequence that goes backwards, so it survives a
// sampler that misses frames — which matters because Firefox's
// requestVideoFrameCallback coalesces, and asking the native cases for a
// particular frame to appear would fail there on the sampling rather than on
// the engine.
// The native tier's tolerances, and only the native tier's: one frame of
// overrun past the region's end (two where Firefox's sampler coalesces), and a
// wrap that may land on the region's start or the frame after it. See the
// header for why each frame of slack is the element's and not the engine's.
const inNativeRegion = (frame, start, end) => frame >= start && frame <= end + 2;
const landsOnRegionStart = (frame, start) => frame === start || frame === start + 1;

function wrapsIn(frames) {
  const wraps = [];
  for (let i = 1; i < frames.length; i++) {
    if (frames[i] < frames[i - 1]) wraps.push({ index: i, from: frames[i - 1], to: frames[i] });
  }
  return wraps;
}

const CASES = [
  {
    name: 'wrap',
    mode: 'webcodecs',
    expectedTier: 'webcodecs',
    // Started one frame inside the region, so a wrap that fired on entry rather
    // than on the crossing would show up as an immediate jump to REGION_START.
    check(result, problems) {
      const { currentFrames, presentedFrames, regionStart, regionEnd } = result;
      if (currentFrames[0] !== regionStart + 1) {
        problems.push(`walk began on frame ${currentFrames[0]}, expected ${regionStart + 1}`);
      }
      checkStaysInRegion(currentFrames, regionStart, regionEnd, problems, 'currentFrame');
      const wraps = countWraps(currentFrames, regionStart, regionEnd);
      if (wraps < 2) {
        problems.push(`only ${wraps} wrap(s) in ${currentFrames.length} frames of `
          + `playback, expected the region to repeat — ${show(currentFrames)}`);
      }
      // The pixels, not just the playhead: the frame after the region must
      // never reach the screen on this tier.
      const presented = realFrames(presentedFrames);
      if (!presented.length) {
        problems.push('no frame ever presented during the walk');
      } else if (presented.some((frame) => frame < regionStart || frame > regionEnd)) {
        problems.push(`presentedFrame left the region: ${show(presented)}`);
      }
    },
  },
  {
    name: 'seek-outside',
    mode: 'webcodecs',
    expectedTier: 'webcodecs',
    check(result, problems) {
      for (const { target, currentFrame } of result.seeks) {
        if (currentFrame !== target) {
          problems.push(`seekToFrame(${target}) with a loop region set reported `
            + `frame ${currentFrame} — the region must not clamp seeking`);
        }
      }
    },
  },
  {
    name: 'seek-past-end',
    mode: 'webcodecs',
    expectedTier: 'webcodecs',
    check(result, problems) {
      const { currentFrames, regionStart, regionEnd, numFrames } = result;
      const lastFrame = numFrames - 1;
      if (currentFrames[0] !== regionEnd + 6) {
        problems.push(`walk began on frame ${currentFrames[0]}, expected ${regionEnd + 6}`);
      }
      // Not yanked back: the very next frame after the out-of-region start must
      // be the next frame of the clip, not the region's start.
      if (currentFrames[1] !== regionEnd + 7) {
        problems.push(`after starting past the region on frame ${currentFrames[0]}, `
          + `playback went to ${currentFrames[1]} rather than carrying on to `
          + `${regionEnd + 7} — ${show(currentFrames)}`);
      }
      const endIndex = currentFrames.indexOf(lastFrame);
      if (endIndex < 0) {
        problems.push(`playback never reached the clip's last frame ${lastFrame} — `
          + show(currentFrames));
        return;
      }
      for (let i = 0; i <= endIndex; i++) {
        if (currentFrames[i] !== currentFrames[0] + i) {
          problems.push(`playback past the region skipped: expected `
            + `${currentFrames[0] + i} at index ${i}, got ${currentFrames[i]} — `
            + show(currentFrames));
          break;
        }
      }
      if (currentFrames[endIndex + 1] !== regionStart) {
        problems.push(`the wrap from the clip's end landed on `
          + `${currentFrames[endIndex + 1]}, expected the region's start `
          + `${regionStart} — ${show(currentFrames)}`);
        return;
      }
      // And from there on it is an ordinary region loop.
      checkStaysInRegion(currentFrames.slice(endIndex + 1), regionStart, regionEnd,
        problems, 'currentFrame after the wrap back into the region');
    },
  },
  {
    name: 'no-loop',
    mode: 'webcodecs',
    expectedTier: 'webcodecs',
    check(result, problems) {
      const { currentFrames, regionEnd, numFrames, pausedAtEnd } = result;
      if (!currentFrames.includes(regionEnd + 1)) {
        problems.push(`with loop=false, playback did not reach frame ${regionEnd + 1} `
          + `past the region's end — ${show(currentFrames)}`);
      }
      for (let i = 1; i < currentFrames.length; i++) {
        if (currentFrames[i] !== currentFrames[i - 1] + 1) {
          problems.push(`with loop=false, playback jumped from ${currentFrames[i - 1]} `
            + `to ${currentFrames[i]} — nothing should wrap — ${show(currentFrames)}`);
          break;
        }
      }
      const finalFrame = currentFrames[currentFrames.length - 1];
      if (finalFrame !== numFrames - 1) {
        problems.push(`playback stopped on frame ${finalFrame}, expected the clip's `
          + `last frame ${numFrames - 1}`);
      }
      if (!pausedAtEnd) problems.push('the engine was still playing at the clip\'s end');
    },
  },
  {
    name: 'no-region',
    mode: 'webcodecs',
    expectedTier: 'webcodecs',
    check(result, problems) {
      const { currentFrames, numFrames, readBack } = result;
      if (readBack.loopStartFrame !== null || readBack.loopEndFrame !== null) {
        problems.push(`setting the region to null read back as `
          + `${readBack.loopStartFrame}/${readBack.loopEndFrame}`);
      }
      const endIndex = currentFrames.indexOf(numFrames - 1);
      if (endIndex < 0) {
        problems.push(`playback never reached the clip's last frame `
          + `${numFrames - 1} — ${show(currentFrames)}`);
        return;
      }
      const expected = [];
      for (let i = 0; i < currentFrames.length; i++) {
        expected.push((currentFrames[0] + i) % numFrames);
      }
      if (currentFrames.join() !== expected.join()) {
        problems.push(`with no region set, whole-clip looping played `
          + `${show(currentFrames)}, expected ${show(expected)}`);
      }
    },
  },
  {
    name: 'native-wrap',
    mode: 'native',
    expectedTier: 'native (container index, presented clock)',
    check(result, problems) {
      const { regionStart, regionEnd } = result;
      const frames = realFrames(result.frames);
      if (frames.length < 5) {
        problems.push(`only ${frames.length} frame(s) presented in 1.5s — the element `
          + `did not play`);
        return;
      }
      const outside = frames.find((frame) => !inNativeRegion(frame, regionStart, regionEnd));
      if (outside !== undefined) {
        problems.push(`presented frame ${outside} outside the region plus the tier's `
          + `one frame of slack — ${show(frames)}`);
      }
      const wraps = wrapsIn(frames);
      if (wraps.length < 2) {
        problems.push(`${wraps.length} wrap(s) in 1.5s of playback, expected the region `
          + `to repeat — ${show(frames)}`);
      }
      const wrongLanding = wraps.find(
        (wrap) => !landsOnRegionStart(wrap.to, regionStart));
      if (wrongLanding) {
        problems.push(`a wrap landed on frame ${wrongLanding.to}, expected the region's `
          + `start ${regionStart} — ${show(frames)}`);
      }
    },
  },
  {
    name: 'native-seek-outside',
    mode: 'native',
    expectedTier: 'native (container index, presented clock)',
    check(result, problems) {
      for (const { target, currentFrame } of result.seeks) {
        if (currentFrame !== target) {
          problems.push(`seekToFrame(${target}) with a loop region set reported `
            + `frame ${currentFrame} — the region must not clamp seeking`);
        }
      }
    },
  },
  {
    name: 'native-seek-past-end',
    mode: 'native',
    expectedTier: 'native (container index, presented clock)',
    check(result, problems) {
      const { regionStart, regionEnd, numFrames } = result;
      const frames = realFrames(result.frames);
      const lastFrame = numFrames - 1;
      const wraps = wrapsIn(frames);
      if (!wraps.length) {
        problems.push(`playback started past the region and never wrapped at all in `
          + `2s — ${show(frames)}`);
        return;
      }
      // Nothing before the first wrap may be inside the region: a playhead the
      // host put past the region plays on to the clip's end, and is not yanked
      // back the instant it lands.
      const beforeFirstWrap = frames.slice(0, wraps[0].index);
      if (Math.min(...beforeFirstWrap) < regionEnd + 6) {
        problems.push(`playback started past the region on frame ${regionEnd + 6} and `
          + `was pulled back to ${Math.min(...beforeFirstWrap)} before reaching the `
          + `clip's end — ${show(frames)}`);
      }
      if (wraps[0].from !== lastFrame) {
        problems.push(`the first wrap left frame ${wraps[0].from}, expected the clip's `
          + `last frame ${lastFrame} — ${show(frames)}`);
      }
      if (!landsOnRegionStart(wraps[0].to, regionStart)) {
        problems.push(`the wrap from the clip's end landed on frame ${wraps[0].to}, `
          + `expected the region's start ${regionStart} — ${show(frames)}`);
      }
      // And from there on it is an ordinary region loop.
      const outside = frames.slice(wraps[0].index)
        .find((frame) => !inNativeRegion(frame, regionStart, regionEnd));
      if (outside !== undefined) {
        problems.push(`after wrapping into the region, presented frame ${outside} is `
          + `outside it — ${show(frames)}`);
      }
    },
  },
  {
    name: 'native-no-loop',
    mode: 'native',
    expectedTier: 'native (container index, presented clock)',
    check(result, problems) {
      const { regionEnd, numFrames } = result;
      const frames = realFrames(result.frames);
      if (!frames.some((frame) => frame > regionEnd)) {
        problems.push(`with loop=false, playback never got past the region's end `
          + `${regionEnd} — ${show(frames)}`);
      }
      const finalFrame = frames[frames.length - 1];
      if (finalFrame !== numFrames - 1) {
        problems.push(`playback stopped on frame ${finalFrame}, expected the clip's `
          + `last frame ${numFrames - 1} — ${show(frames)}`);
      }
      const wraps = wrapsIn(frames);
      if (wraps.length) {
        problems.push(`with loop=false, playback went backwards from ${wraps[0].from} `
          + `to ${wraps[0].to} — the region must be inert — ${show(frames)}`);
      }
    },
  },
];

const browser = await launchBrowser();
let failures = 0;

for (const testCase of CASES) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  await page.goto(`${serverBase}/test/test-loop-region.html`
    + `?file=${CLIP}&mode=${testCase.mode}&case=${testCase.name}`);
  await page.waitForFunction(() => window.__result || window.__err, { timeout: 60000 })
    .catch(() => {});
  const { result, err } = await page.evaluate(
    () => ({ result: window.__result, err: window.__err }));
  await page.close();

  if (err || !result) {
    console.log(`FAIL loop-region ${testCase.name}: ${err || 'no result (timed out)'}`);
    failures += 1;
    continue;
  }

  const problems = [];
  // Pin the tier: every assertion below would pass just as happily on the other
  // one, where it would be testing the other engine's implementation.
  if (result.tier !== testCase.expectedTier) {
    problems.push(`ran on tier '${result.tier}', expected '${testCase.expectedTier}'`);
  } else {
    testCase.check(result, problems);
  }

  if (problems.length) {
    failures += 1;
    console.log(`FAIL loop-region ${testCase.name} [${result.tier}]: ${problems.join('; ')}`);
  } else {
    console.log(`PASS loop-region ${testCase.name} [${result.tier}]`);
  }
}

await browser.close();
process.exit(failures ? 1 : 0);
