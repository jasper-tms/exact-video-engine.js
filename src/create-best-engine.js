import { ContainerIndex } from './container-index.js';
import { VideoEngine } from './video-engine.js';
import { NativeVideoEngine } from './native-video-engine.js';
import { detectBrowserEngine, webCodecsMayFailMidStream } from './decode-support.js';

// ==================================================================
// createBestEngine — walk the ladder and return a loaded engine.
//
// The container index is built once, up front, and handed to whichever engine
// ends up playing: it is what WebCodecs decodes from, and it is also what gives
// the <video> path exact per-frame timestamps. So it is worth building even when
// WebCodecs is nowhere in sight, and it is never built twice. An index is
// mandatory: a container we cannot index is refused, since this engine reports
// only true frame indices, never inferred ones.
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
    // How long the WebM index is allowed to take. Building it means reading the
    // whole file (Matroska keeps no central sample table), which is quick from
    // disk and as slow as the network from a URL — so it gets a deadline. A clip
    // that blows through it is now REFUSED (the throw below) rather than played
    // with guessed frame numbers; the index cache (added separately) is what
    // softens the repeat-visit cost of a full-file parse. Infinity to let it run
    // as long as it needs; indexMaxBytes refuses outsized files before reading a
    // byte of them. Neither touches the MP4 path, which is a few range reads
    // either way.
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
  // The build error, kept so the refusal below can name what actually went wrong
  // (an unsupported container, mp4box.js absent, or the WebM pass timing out).
  let indexBuildError = null;
  if (providedIndex === undefined) {
    try {
      index = await ContainerIndex.fromSource(source, {
        timeoutMilliseconds: indexTimeoutMilliseconds,
        maxBytes: indexMaxBytes,
        onProgress,
      });
    } catch (err) {
      indexBuildError = err;
    }
  }

  // Index or refuse. Every engine this function returns reports true per-frame
  // indices read from the container, never numbers inferred from an assumed
  // frame rate — so a container we could not index has no engine we are willing
  // to hand back. This fires when the build failed above or when the caller
  // explicitly passed index: null. A WebM whose indexing pass exceeded
  // indexTimeoutMilliseconds lands here too: it now refuses rather than falling
  // back to a declared rate, and the index cache (added separately) is what
  // softens the cost the next time the same clip is opened.
  if (!index) {
    let message = 'createBestEngine: no index could be built for this container; '
      + 'it is not a format we can index (supported: MP4/MOV, WebM/MKV, and Ogg). '
      + 'Without a per-frame timestamp table there is no way to report exact frame '
      + 'numbers, so this clip is refused rather than played with guesses.';
    if (indexBuildError && indexBuildError.message) {
      message += ` (underlying error: ${indexBuildError.message})`;
    }
    throw new Error(message);
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

  // The native <video> path reads which frame is on screen out of
  // requestVideoFrameCallback's presented-frame clock, whose mediaTime is the
  // exact presentation timestamp of the displayed frame. Without that clock there
  // is no way to know which indexed frame the element is actually showing (raw
  // currentTime keeps advancing through decoder stalls while the picture is
  // frozen, and refreshes at coarse uneven intervals on older WebKit), so a
  // perfect index is not enough — refuse rather than report inexact frame
  // numbers. This gate is only on the native fallback: the WebCodecs path above
  // owns its own clock and needs no requestVideoFrameCallback, so it is never
  // gated on it.
  if (!('requestVideoFrameCallback' in video)) {
    throw new Error('createBestEngine: this browser lacks requestVideoFrameCallback, '
      + 'which the exact native <video> path requires to know which frame is on '
      + 'screen. Please use a current browser (Safari 15.4+, Firefox 132+, or any '
      + 'recent Chromium).');
  }

  const engine = new NativeVideoEngine(video);
  await engine.load(source, { index });
  return engine;
}
