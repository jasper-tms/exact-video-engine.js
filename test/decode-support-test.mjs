// Unit test for the known-bad-codec routing decision (src/decode-support.js).
// Pure functions over a codec string and a navigator, so this runs in plain Node
// with no browser and no fixture — it is the guarantee behind the proactive
// route in createBestEngine, whose wiring the browser-side known-bad-codec-test
// then exercises end to end.
//
// Reads directly from src/ so it checks the same code the build concatenates
// into the shipped file.
import {
  detectBrowserEngine, isTenBitHevc, webCodecsMayFailMidStream,
} from '../src/decode-support.js';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} decode-support ${name}: ${detail}`);
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

// --- detectBrowserEngine: vendor is the primary tell -------------------------
// Every WebKit browser — desktop Safari and ALL iOS browsers — reports this
// vendor, which is exactly why it, not the brand or the device, is the signal.
eq('webkit from Apple vendor (desktop Safari)',
  detectBrowserEngine({ vendor: 'Apple Computer, Inc.' }), 'webkit');
eq('webkit from Apple vendor (iOS Chrome, still WebKit)',
  detectBrowserEngine({ vendor: 'Apple Computer, Inc.', userAgent: 'CriOS/120' }), 'webkit');
eq('blink from Google vendor',
  detectBrowserEngine({ vendor: 'Google Inc.' }), 'blink');
eq('gecko from Firefox UA (empty vendor)',
  detectBrowserEngine({ vendor: '', userAgent: 'Mozilla/5.0 (X11; rv:109.0) Gecko/20100101 Firefox/119.0' }),
  'gecko');
// A Blink UA says "like Gecko" (no slash) but reports the Google vendor, so it
// must never be mistaken for Gecko.
eq('blink UA saying "like Gecko" is still blink',
  detectBrowserEngine({ vendor: 'Google Inc.', userAgent: 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120' }),
  'blink');
eq('unknown when nothing places it', detectBrowserEngine({ vendor: '', userAgent: '' }), 'unknown');
eq('unknown when no navigator at all', detectBrowserEngine(null), 'unknown');

// --- isTenBitHevc: the format WebKit accepts then dies on --------------------
check('HEVC Main 10 (hvc1 profile 2)', isTenBitHevc('hvc1.2.4.L123.b0') === true, 'hvc1.2.4.L123.b0');
check('HEVC Main 10 (hev1 profile 2)', isTenBitHevc('hev1.2.4.L120.90') === true, 'hev1.2.4.L120.90');
check('HEVC Main 10 with A profile-space prefix',
  isTenBitHevc('hvc1.A2.4.L123.b0') === true, 'hvc1.A2...');
check('HEVC Main (profile 1) is 8-bit, not matched',
  isTenBitHevc('hvc1.1.6.L93.90') === false, 'hvc1.1.6.L93.90');
check('Dolby Vision (dvhe) is >= 10-bit', isTenBitHevc('dvhe.08.07') === true, 'dvhe.08.07');
check('Dolby Vision (dvh1) is >= 10-bit', isTenBitHevc('dvh1.05.06') === true, 'dvh1.05.06');
check('H.264 is never matched', isTenBitHevc('avc1.640028') === false, 'avc1.640028');
check('VP9 is never matched', isTenBitHevc('vp09.00.10.08') === false, 'vp09.00.10.08');
check('empty/null codec is not matched',
  isTenBitHevc('') === false && isTenBitHevc(null) === false, 'empty and null');

// --- webCodecsMayFailMidStream: the routing decision itself ------------------
// True only for the confirmed dishonest-yes pair; the reactive fatal-fallback
// backs up everything else, so this table stays tight on purpose.
check('WebKit + 10-bit HEVC -> route away (the whole point)',
  webCodecsMayFailMidStream('hvc1.2.4.L123.b0', 'webkit') === true, 'webkit + Main 10');
check('WebKit + Dolby Vision -> route away',
  webCodecsMayFailMidStream('dvhe.08.07', 'webkit') === true, 'webkit + dvhe');
check('Chromium + 10-bit HEVC -> keep WebCodecs (it decodes it)',
  webCodecsMayFailMidStream('hvc1.2.4.L123.b0', 'blink') === false, 'blink + Main 10');
check('WebKit + 8-bit HEVC -> keep WebCodecs (works there)',
  webCodecsMayFailMidStream('hvc1.1.6.L93.90', 'webkit') === false, 'webkit + Main');
check('WebKit + H.264 -> keep WebCodecs',
  webCodecsMayFailMidStream('avc1.640028', 'webkit') === false, 'webkit + H.264');
check('null codec is never routed away',
  webCodecsMayFailMidStream(null, 'webkit') === false, 'null codec');

process.exit(failures ? 1 : 0);
