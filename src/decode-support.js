// ==================================================================
// decode-support — which (browser engine, codec) pairs WebCodecs lies about.
//
// WebCodecs decode support tracks the BROWSER ENGINE, not the device, and its
// feature detection is not always honest. The dangerous class is the "dishonest
// yes": WebKit (desktop Safari and every iOS browser — they are all WebKit
// underneath) answers VideoDecoder.isConfigSupported() = true for 10-bit HEVC
// (the iPhone's own HDR camera format), decodes the first keyframe, and then the
// decoder dies once sustained decoding starts. That death lands AFTER load()
// resolved — past createBestEngine's load-time fallback — so the user sees the
// clip play for a second or two and then stop.
//
// The reactive net for this (v1.7.0) is engine.failed + a fatal errormessage a
// host can rebuild from. This module is the PROACTIVE half: recognize the
// combination up front and route straight to the <video> element, which decodes
// the same clip fine (it uses the platform's own AVFoundation path, not
// WebCodecs). No crash, no flash, and the container index still makes the native
// path frame-exact.
//
// The matrix here is empirical (real-device testing; see the decode-support-matrix
// agent skill). It is deliberately TIGHT — a false positive needlessly gives up
// the WebCodecs owned-clock path — so it names only combinations confirmed to
// crash, and the reactive net still backs up anything it misses.
// ==================================================================

// The browser's underlying engine, inferred from navigator. WebCodecs bugs live
// in the engine, so this — not the device or the browser brand — is what decides
// whether a decode config can be trusted.
//
//   'webkit'  desktop Safari AND all iOS browsers (Chrome/Firefox/Edge on iOS
//             are WebKit-backed by platform mandate). navigator.vendor is
//             'Apple Computer, Inc.' for every one of them.
//   'blink'   Chrome/Edge/Brave/Opera off iOS. navigator.vendor is 'Google Inc.'
//   'gecko'   Firefox off iOS. navigator.vendor is '' (fall back to the UA).
//   'unknown' anything we cannot place; treated as trustworthy (no routing).
export function detectBrowserEngine(nav) {
  const navigatorObject = nav
    || (typeof navigator !== 'undefined' ? navigator : null);
  if (!navigatorObject) return 'unknown';
  const vendor = navigatorObject.vendor || '';
  if (vendor === 'Apple Computer, Inc.') return 'webkit';
  if (vendor === 'Google Inc.') return 'blink';
  const userAgent = navigatorObject.userAgent || '';
  if (/firefox|gecko\//i.test(userAgent)) return 'gecko';
  return 'unknown';
}

// Is this codec string 10-bit HEVC — the format WebKit's WebCodecs accepts and
// then fails on? Covers HEVC Main 10 (general_profile_idc 2, the iPhone HDR
// default) declared as hvc1/hev1, and Dolby Vision (dvh1/dvhe), which is
// HEVC-based and always at least 10-bit. Range-Extensions profiles that reach
// 10-bit through a different profile idc are exotic and not matched from the
// codec string alone; the reactive fatal-fallback still covers those.
export function isTenBitHevc(codecString) {
  if (!codecString) return false;
  const parts = String(codecString).split('.');
  const fourCharCode = parts[0].toLowerCase();
  // Dolby Vision (HEVC-based) is always >= 10-bit.
  if (fourCharCode === 'dvhe' || fourCharCode === 'dvh1') return true;
  if (fourCharCode === 'hvc1' || fourCharCode === 'hev1') {
    // hvc1.<profile>.<compat>.<tier><level>.<constraints...>; the profile field
    // may carry a one-letter profile-space prefix (A/B/C) before the number.
    const profileField = (parts[1] || '').replace(/^[ABC]/i, '');
    return parseInt(profileField, 10) === 2;   // 2 == HEVC Main 10
  }
  return false;
}

// Should createBestEngine skip the WebCodecs engine for this (codec, engine)
// pair because WebCodecs would accept it and then die mid-stream? True only for
// the confirmed dishonest-yes combinations; everything else goes down the normal
// ladder (try WebCodecs, fall back on an honest rejection).
export function webCodecsMayFailMidStream(codecString, browserEngine) {
  return browserEngine === 'webkit' && isTenBitHevc(codecString);
}
