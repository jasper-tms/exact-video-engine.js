// ==================================================================
// unplayable-clip — why a clip could not be played, in a form a host can act on.
//
// Every runtime failure in this library already reports itself twice: an
// 'errormessage' event carries detail.message for a human AND structured fields
// (fatal, errorName, codec, frame) for the program deciding what to do about it.
// Load-time failures did not. They threw plain Errors, so a host had the message
// string and nothing else — and the string was sometimes 'native <video> load
// failed', which tells nobody anything.
//
// That asymmetry mattered most in the case it served worst. When a clip's codec
// is one this browser cannot decode, `createBestEngine` knows precisely that:
// which codec, that the container indexed perfectly, how many frames it holds,
// that WebCodecs rejected it, and that the <video> element then failed too. All
// of it was thrown away and replaced with five words.
//
// So load failures now throw an UnplayableClipError: the same message a host
// could always show, plus the fields it would otherwise have to parse back out
// of English. The message is composed from what the ENGINE reasoned — the codec
// off the index, which tiers were tried — never from the browser's own error
// text, which is not comparable across engines and is sometimes empty. On the
// same undecodable file Chromium says 'DEMUXER_ERROR_NO_SUPPORTED_STREAMS',
// Firefox says nothing usable, and WebKit does not fail at all. What the browser
// did say is attached as a diagnostic field, to be logged and not parsed.
//
// UnplayableClipError extends Error, so `catch (e) { show(e.message) }` keeps
// working unchanged. The fields are additions, not a migration.
// ==================================================================

// Why a clip was refused. A closed set, because a host switching on it should be
// able to know it has covered every case.
//
//   'container-not-indexable'   the bytes are not a container we can read a
//                               per-frame timestamp table out of (or the file is
//                               damaged, or an indexing budget ran out). No
//                               engine can be returned; the codec is unknown.
//   'codec-not-decodable'       the container is fine and the index is complete,
//                               but no tier in this browser can decode what is
//                               inside it. This is the one worth telling a user
//                               about by name: re-encoding fixes it, and nothing
//                               else will.
//   'no-fallback-element'       the WebCodecs tier was unavailable or refused,
//                               and no <video> element was supplied to fall back
//                               to. A host bug rather than a bad clip.
//   'no-presented-frame-clock'  the clip must play on the <video> element and
//                               this browser has no requestVideoFrameCallback,
//                               so which frame is on screen is unknowable.
//   'timeline-unmappable'       the element's timeline cannot be mapped to the
//                               index frame-for-frame on this browser (a trimming
//                               edit list on Gecko or WebKit), so frame numbers
//                               would be silently shifted.
//   'decode-failed'             the container indexed, the codec is one this
//                               browser can decode, and decoding failed anyway —
//                               damaged or truncated frame data, most often.
//                               Deliberately separate from 'codec-not-decodable':
//                               the two want opposite advice, and guessing wrong
//                               sends someone to re-encode a file whose codec was
//                               never the problem.
export const UNPLAYABLE_REASONS = [
  'container-not-indexable',
  'codec-not-decodable',
  'decode-failed',
  'no-fallback-element',
  'no-presented-frame-clock',
  'timeline-unmappable',
];

export class UnplayableClipError extends Error {
  // `detail` carries whichever of these are known: reason, codec, codecName,
  // containerFormat, numFrames, triedWebCodecs, webCodecsMessage,
  // nativeErrorCode, nativeErrorMessage, suggestion. Unknown fields are left
  // absent rather than set to null, so `'codec' in error` means what it says.
  constructor(message, detail = {}) {
    super(message);
    this.name = 'UnplayableClipError';
    Object.assign(this, detail);
  }
}

// A codec string as a person would name it. Falls back to the string itself,
// which is better than nothing and never wrong — a codec we have no friendly
// name for is one whose registered string is the only name it has.
//
// Keyed on the four-character code, so `avc1.640028` and `avc1.42E01E` both come
// back as H.264 without the table having to know every profile.
const CODEC_NAMES = {
  avc1: 'H.264', avc3: 'H.264', avc2: 'H.264', avc4: 'H.264',
  hvc1: 'HEVC (H.265)', hev1: 'HEVC (H.265)',
  dvh1: 'Dolby Vision', dvhe: 'Dolby Vision', dav1: 'Dolby Vision',
  vvc1: 'VVC (H.266)', vvi1: 'VVC (H.266)',
  vp08: 'VP8', vp8: 'VP8', vp09: 'VP9', vp9: 'VP9',
  av01: 'AV1',
  mp4v: 'MPEG-4 Part 2',
  mjpeg: 'Motion JPEG',
  theora: 'Theora',
};

export function describeCodec(codecString) {
  if (!codecString) return null;
  const fourCharacterCode = String(codecString).split('.')[0].toLowerCase();
  return CODEC_NAMES[fourCharacterCode] || String(codecString);
}

// Both names in one phrase, for a message a person reads: "MPEG-4 Part 2
// (mp4v.20.1)". Collapses to one when there is no friendly name to add.
export function namePlusCodecString(codecString) {
  const name = describeCodec(codecString);
  if (!name) return 'an unknown codec';
  return (name === codecString) ? codecString : `${name} (${codecString})`;
}

// What a host should tell someone holding a clip this browser cannot decode.
// Re-encoding is the only fix — a browser will not grow a decoder — so the
// message says so plainly and gives the command rather than gesturing at it.
export function reEncodeSuggestion() {
  return 'Re-encoding to H.264 will play everywhere: '
    + 'ffmpeg -i in.mp4 -c:v libx264 -crf 18 out.mp4';
}
