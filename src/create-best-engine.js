import { ContainerIndex } from './container-index.js';
import { VideoEngine } from './video-engine.js';
import { NativeVideoEngine } from './native-video-engine.js';
import { detectBrowserEngine, webCodecsMayFailMidStream } from './decode-support.js';
import { isImageFrameCodec, canDecodeImageFrames } from './image-frame-decoder.js';
import { UnplayableClipError, describeCodec, namePlusCodecString, reEncodeSuggestion } from './unplayable-clip.js';

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
    // Passed through to VideoEngine; the <video> element has no comparable
    // control (the browser resamples its own decoded frames, not us), so this
    // is a no-op on that tier. See the VideoEngine constructor.
    imageSmoothingEnabled,
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
    // Hand back a playable engine as soon as enough of the clip has been indexed
    // to be worth showing, instead of waiting for the whole container to be read.
    // Only a full-file pass has anything to wait for (WebM/MKV and fragmented
    // MP4; a classic MP4 indexes in a few range reads however long the clip is,
    // and an AVI reads its own index rather than the file), and only the
    // WebCodecs tier can use a partial index — the <video> element plays the
    // whole clip whether or not we have named its frames yet, so an index still
    // growing underneath it would have to answer for frames it has not certified.
    //
    // What the host gets is an engine whose numFrames GROWS: every frame number
    // it reports is exact and permanent, and the set of frames it will report
    // widens as the pass goes on. Watch engine.frameIndexState and its
    // 'indexextended' / 'indexcomplete' / 'indextruncated' events. Off by
    // default, because a growing numFrames is not what existing callers expect.
    playWhileIndexing = false,
    // How much of the clip must be indexed before that early engine comes back.
    // An engine that can show one frame is not worth the complexity of handling
    // one; a second or so of video is.
    minimumIndexedFramesBeforePlayback = 30,
  } = options;

  let index = (providedIndex !== undefined) ? providedIndex : null;
  // The build error, kept so the refusal below can name what actually went wrong
  // (an unsupported container, mp4box.js absent, or the WebM pass timing out).
  let indexBuildError = null;
  if (providedIndex === undefined) {
    // Publishing certified prefixes is only worth asking for when there is a
    // WebCodecs tier for them to land on.
    const wantCertifiedPrefixes = playWhileIndexing && prefer !== 'native'
      && !!canvas
      && (typeof VideoDecoder !== 'undefined' || canDecodeImageFrames());
    let earlyIndex = null;
    let onIndexExtended = null;
    const readyToPlay = new Promise((resolve) => {
      onIndexExtended = (growing) => {
        if (earlyIndex || growing.completionState !== 'growing') return;
        if (growing.numFrames < minimumIndexedFramesBeforePlayback) return;
        // The same two gates the ladder below applies, asked early: without a
        // sample table and a decoder configuration there is no WebCodecs tier
        // for a partial index to play on, and a codec this browser accepts and
        // then dies on belongs on the <video> element, which needs the whole
        // index. Either way, wait for the finished build.
        const growingCodec = growing.decoderConfig && growing.decoderConfig.codec;
        if (!growing.supportsWebCodecs
            || webCodecsMayFailMidStream(growingCodec, detectBrowserEngine())) return;
        earlyIndex = growing;
        resolve(growing);
      };
    });

    const buildPromise = ContainerIndex.fromSource(source, {
      timeoutMilliseconds: indexTimeoutMilliseconds,
      maxBytes: indexMaxBytes,
      onProgress,
      publishPartialIndex: wantCertifiedPrefixes,
      onIndexCreated: wantCertifiedPrefixes ? (created) => {
        created.addEventListener('extended', () => onIndexExtended(created));
      } : undefined,
    }).then((built) => { index = built; return built; },
      (err) => { indexBuildError = err; return null; });

    // Whichever comes first: enough of the clip to play, or the whole pass.
    if (wantCertifiedPrefixes) await Promise.race([readyToPlay, buildPromise]);
    else await buildPromise;
    if (!index) index = earlyIndex;
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
      + 'it is not a format we can index (supported: MP4/MOV, WebM/MKV, Ogg, and AVI). '
      + 'Without a per-frame timestamp table there is no way to report exact frame '
      + 'numbers, so this clip is refused rather than played with guesses.';
    if (indexBuildError && indexBuildError.message) {
      message += ` (underlying error: ${indexBuildError.message})`;
    }
    throw new UnplayableClipError(message, {
      reason: 'container-not-indexable',
      indexBuildMessage: indexBuildError ? indexBuildError.message : undefined,
    });
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

  // A Motion JPEG clip decodes through the browser's JPEG decoder rather than a
  // VideoDecoder (see src/image-frame-decoder.js), so it is the wrong thing to
  // feature-detect for one — and the right thing is available in browsers where
  // WebCodecs decoding is not.
  const decoderIsAvailable = isImageFrameCodec(codec)
    ? canDecodeImageFrames() : typeof VideoDecoder !== 'undefined';

  // Why the WebCodecs tier did not take the clip, kept for the refusal below.
  // If the <video> element then fails too, this is half the story of why the
  // clip is unplayable, and it used to go only to the console — leaving the
  // thrown error to report the element's failure as if WebCodecs had never been
  // asked. A host cannot tell "this browser lacks a decoder for this codec" from
  // "this file is broken" without both halves.
  let webCodecsMessage;
  let webCodecsWasTried = false;
  // Whether that failure was the decoder's own support check saying no, as
  // opposed to a decode that started and went wrong. Only the former is evidence
  // about the CODEC; see describeExhaustedLadder.
  let codecRefusedBySupportCheck = false;

  if (prefer !== 'native' && !webCodecsUnreliable
      && canvas && index && index.supportsWebCodecs && decoderIsAvailable) {
    webCodecsWasTried = true;
    const engine = new VideoEngine(canvas, { windowAhead, imageSmoothingEnabled });
    try {
      await engine.load(source, { index });
      return engine;
    } catch (err) {
      // Container parsed but the codec will not decode here (an unsupported
      // profile, or a browser with a partial WebCodecs). The element may well
      // play it natively, and we keep the exact index either way.
      engine.destroy();
      webCodecsMessage = err && err.message;
      codecRefusedBySupportCheck = !!(err && err.codecRefusedBySupportCheck);
      console.warn('exact-video-engine: WebCodecs could not play this clip; '
        + 'falling back to the native <video> element.', err);
      // The <video> element plays the whole clip regardless of how far the index
      // has got, so it needs a finished one to name frames against — see the
      // refusal in NativeVideoEngine.load. Wait for the pass we left running.
      if (index.completionState === 'growing') {
        await new Promise((resolve) => {
          index.addEventListener('complete', resolve, { once: true });
          index.addEventListener('truncated', resolve, { once: true });
        });
      }
    }
  }

  if (!video) {
    throw new UnplayableClipError(
      'createBestEngine: no <video> element supplied to fall back to', {
        reason: 'no-fallback-element',
        codec: codec || undefined,
        codecName: describeCodec(codec) || undefined,
        containerFormat: index.containerFormat,
        numFrames: index.numFrames,
        triedWebCodecs: webCodecsWasTried,
        webCodecsMessage,
      });
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
    throw new UnplayableClipError(
      'createBestEngine: this browser lacks requestVideoFrameCallback, '
      + 'which the exact native <video> path requires to know which frame is on '
      + 'screen. Please use a current browser (Safari 15.4+, Firefox 132+, or any '
      + 'recent Chromium).', {
        reason: 'no-presented-frame-clock',
        codec: codec || undefined,
        codecName: describeCodec(codec) || undefined,
        containerFormat: index.containerFormat,
        numFrames: index.numFrames,
      });
  }

  const engine = new NativeVideoEngine(video);
  try {
    await engine.load(source, { index });
  } catch (nativeError) {
    throw await describeExhaustedLadder(nativeError, {
      index, codec, webCodecsWasTried, webCodecsMessage, codecRefusedBySupportCheck,
    });
  }
  return engine;
}

// Is this codec one WebCodecs will not decode here? Asked only on the failure
// path, and only when the ladder has not already found out — the WebCodecs tier
// answers this on its way past, but `prefer: 'native'` and a host with no canvas
// both skip it, and a refusal should not be less informative for those callers.
// A browser with no VideoDecoder at all cannot answer, which is honestly
// "unknown" rather than "supported".
async function webCodecsRejectsCodec(decoderConfig) {
  if (!decoderConfig || typeof VideoDecoder === 'undefined') return false;
  try {
    const support = await VideoDecoder.isConfigSupported(decoderConfig);
    return support.supported !== true;
  } catch {
    return false;   // a config it could not even evaluate proves nothing
  }
}

// The last tier has failed, so the clip will not play here at all. This is the
// only point that knows the WHOLE ladder — what the codec is, that the container
// indexed cleanly, whether WebCodecs was asked and what it said, and what the
// element then did — and it is the message a host shows, so it is worth
// composing properly rather than passing the last failure through.
//
// The message is built from what we reasoned, not from the browser's error
// text: that text is not comparable across engines and is often empty. What the
// browser said travels as a field instead.
async function describeExhaustedLadder(nativeError, context) {
  const { index, codec, webCodecsWasTried, webCodecsMessage } = context;
  const detail = {
    reason: (nativeError && nativeError.reason) || 'decode-failed',
    codec: codec || undefined,
    codecName: describeCodec(codec) || undefined,
    containerFormat: index.containerFormat,
    numFrames: index.numFrames,
    triedWebCodecs: webCodecsWasTried,
    webCodecsMessage,
    nativeErrorCode: nativeError ? nativeError.nativeErrorCode : undefined,
    nativeErrorMessage: nativeError ? nativeError.nativeErrorMessage : undefined,
  };

  // A refusal about the TIMELINE keeps its own explanation: the browser decodes
  // the clip perfectly well, and pointing at the codec would send someone
  // somewhere useless.
  if (detail.reason === 'timeline-unmappable'
      || detail.reason === 'no-presented-frame-clock') {
    return new UnplayableClipError(nativeError.message, detail);
  }

  // Is the CODEC the problem, or merely the clip? Both arrive here as "the
  // element failed to load", and the two want opposite advice — re-encode, or
  // go find an intact copy of the file. So blame the codec only on positive
  // evidence: a decoder support check that said no. The WebCodecs tier
  // establishes that on its way past when it ran; ask directly when it did not.
  const codecIsTheProblem = context.codecRefusedBySupportCheck
    || (nativeError && nativeError.reason === 'codec-not-decodable')
    || await webCodecsRejectsCodec(index.decoderConfig);

  if (!codecIsTheProblem) {
    // The honest version of "we do not know why". Everything observed is named,
    // nothing is diagnosed, and no re-encode is suggested for a file whose codec
    // was never in question.
    detail.reason = 'decode-failed';
    let message = 'createBestEngine: this clip indexed cleanly as '
      + `${index.containerFormat} with ${index.numFrames} frames`
      + `${codec ? ` of ${namePlusCodecString(codec)}` : ''}, and then would not `
      + 'play. The codec is one this browser can decode, so the frame data itself '
      + 'is the suspect — a truncated or damaged file most often.';
    if (detail.nativeErrorMessage) {
      message += ` The <video> element reported: ${detail.nativeErrorMessage}`;
    }
    return new UnplayableClipError(message, detail);
  }

  // The codec case, which is the one worth spelling out. Naming the frame count
  // is not decoration: it is the evidence that the container was read fine and
  // the codec alone is the problem.
  detail.reason = 'codec-not-decodable';
  let message = 'createBestEngine: this clip cannot be played in this browser. '
    + `Its codec, ${namePlusCodecString(codec)}, is not one this browser can decode`;
  message += webCodecsWasTried
    ? ' — WebCodecs rejected it and the <video> element could not play it either.'
    : ' — a decoder support check rejects it, and the <video> element could not '
      + 'play it either.';
  message += ` The container itself is fine: it indexed cleanly as ${index.containerFormat}`
    + ` with ${index.numFrames} frames, so nothing is wrong with the file. `
    + reEncodeSuggestion();
  detail.suggestion = reEncodeSuggestion();
  return new UnplayableClipError(message, detail);
}
