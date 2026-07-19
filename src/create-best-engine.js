import { ContainerIndex } from './container-index.js';
import { VideoEngine } from './video-engine.js';
import { NativeVideoEngine } from './native-video-engine.js';
import { detectBrowserEngine, webCodecsMayFailMidStream } from './decode-support.js';

// ==================================================================
// createBestEngine — walk the ladder and return a loaded engine.
//
// The container index is built once, up front, and handed to whichever engine
// ends up playing: it is what WebCodecs decodes from, and it is also what lifts
// the <video> path from an assumed frame rate to exact per-frame timestamps. So
// it is worth building even when WebCodecs is nowhere in sight, and it is never
// built twice.
//
//   createBestEngine(source, {canvas, video})  ->  VideoEngine | NativeVideoEngine
//
// The returned engine is loaded and ready. `engine.displayElement` is the one of
// the two elements the host should show; `engine.tier` says what it got, and
// `engine.frameIndexIsExact` whether frame numbers can be trusted absolutely.
// ==================================================================
export async function createBestEngine(source, options = {}) {
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
    declaredFrameRate = 0,
    declaredNumFrames = 0,
    // Guarantee-or-bail for frame accuracy. A clip we cannot index (not MP4/MOV,
    // not WebM/MKV) has no per-frame timestamp table, so the native engine can
    // only map frames from a declared rate — exact only if the clip really is
    // constant-frame-rate at that rate. By default such a clip must come with a
    // declaredFrameRate (which is then VERIFIED against the real frame timestamps
    // and rejected if inconsistent, rather than trusted); a clip with neither an
    // index nor a rate throws rather than play with silently guessed frame
    // numbers. Set allowApproximate: true to opt out of both — play the clip
    // best-effort with whatever mapping is available and no frame-accuracy
    // guarantee — for a host that genuinely does not need exact frame numbers.
    allowApproximate = false,
    // How long the WebM index is allowed to take. Building it means reading the
    // whole file (Matroska keeps no central sample table), which is quick from
    // disk and as slow as the network from a URL — so it gets a deadline, and a
    // clip that blows through it falls back to the declared frame rate rather
    // than making the host wait. Infinity to let it run as long as it needs;
    // indexMaxBytes refuses outsized files before reading a byte of them.
    // Neither touches the MP4 path, which is a few range reads either way.
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
  } = options;

  let index = (providedIndex !== undefined) ? providedIndex : null;
  if (providedIndex === undefined) {
    try {
      index = await ContainerIndex.fromSource(source, {
        timeoutMilliseconds: indexTimeoutMilliseconds,
        maxBytes: indexMaxBytes,
        onProgress,
      });
    } catch (err) {
      console.warn('exact-video-engine: could not index this container (not '
        + 'ISOBMFF or WebM, mp4box.js not loaded, or the WebM pass ran out of '
        + 'time). The <video> element may still play it, but only from a declared '
        + 'frame rate — a clip with neither an index nor a declaredFrameRate bails '
        + 'below rather than guess frame numbers.', err);
    }
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
    }
  }

  if (!video) {
    throw new Error('createBestEngine: no <video> element supplied to fall back to');
  }

  // Guarantee-or-bail: a clip with no container index and no declared frame rate
  // could only be played with frame numbers guessed from an assumed rate. Rather
  // than hand back an engine that silently reports guesses, refuse — unless the
  // host has explicitly accepted best-effort playback with allowApproximate.
  if (!index && !allowApproximate && !(declaredFrameRate > 0)) {
    throw new Error('createBestEngine: this container could not be indexed for '
      + 'frame-exact playback (it is not MP4/MOV or WebM/MKV), and no '
      + 'declaredFrameRate was supplied to fall back to, so frame numbers would be '
      + 'guesses. Pass declaredFrameRate to accept declared-rate mapping (it is '
      + 'verified against the real frame timestamps and rejected if inconsistent), '
      + 'or allowApproximate: true to play it best-effort without frame accuracy.');
  }

  const engine = new NativeVideoEngine(video);
  await engine.load(source, {
    index,
    frameRate: declaredFrameRate,
    numFrames: declaredNumFrames,
    // With no index and a declared rate, verify that rate against the clip's real
    // frame timestamps and throw if it is wrong (unless the host opted out).
    verifyDeclaredRate: !allowApproximate,
  });
  return engine;
}
