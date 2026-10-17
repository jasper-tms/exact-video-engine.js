// Unit test for the known-bad-codec routing decision (src/decode-support.js),
// and for the decision of where an H.264 decode run may begin on each browser
// engine (open-GOP streams; see h264RunsMustStartAtIdr).
// Pure functions over a codec string and a navigator, so this runs in plain Node
// with no browser and no fixture — it is the guarantee behind the proactive
// route in createBestEngine, whose wiring the browser-side known-bad-codec-test
// then exercises end to end.
//
// Reads directly from src/ so it checks the same code the build concatenates
// into the shipped file.
import {
  detectBrowserEngine, isTenBitHevc, webCodecsMayFailMidStream,
  isH264, h264RunsMustStartAtIdr, h264AccessUnitIsIdr,
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

// --- where an H.264 decode run may begin --------------------------------------
check('avc1 is H.264', isH264('avc1.640028') === true, 'avc1.640028');
check('avc3 (in-band parameter sets) is H.264', isH264('avc3.42E01E') === true, 'avc3.42E01E');
check('HEVC is not H.264', isH264('hvc1.2.4.L120.b0') === false, 'hvc1.2.4.L120.b0');
check('null codec is not H.264', isH264(null) === false, 'null');
// Only Blink fails to start at a recovery point; WebKit and Gecko decode from one
// correctly once its leading frames are skipped, and an unplaceable browser is
// trusted, as webCodecsMayFailMidStream trusts it.
check('Blink must start H.264 runs at an IDR frame', h264RunsMustStartAtIdr('blink') === true, 'blink');
for (const engine of ['webkit', 'gecko', 'unknown']) {
  check(`${engine} may start H.264 runs at any keyframe`,
    h264RunsMustStartAtIdr(engine) === false, engine);
}

// Length-prefixed access units: [length..., NAL header byte, payload...]. The NAL
// type is the header byte's low five bits; 0x65 is an IDR slice (5), 0x41 a
// non-IDR slice (1), 0x09 an access unit delimiter, 0x06 SEI, 0x67/0x68 SPS/PPS.
function accessUnit(lengthSize, nalUnits) {
  const bytes = [];
  for (const nal of nalUnits) {
    for (let b = lengthSize - 1; b >= 0; b--) bytes.push((nal.length >> (8 * b)) & 0xFF);
    bytes.push(...nal);
  }
  return new Uint8Array(bytes);
}
const delimiter = [0x09, 0xF0];
const sei = [0x06, 0x05, 0x02, 0xAA, 0xBB, 0x80];
const sps = [0x67, 0x64, 0x00, 0x1F];
const pps = [0x68, 0xEE, 0x3C, 0x80];
check('an IDR slice after parameter sets is IDR',
  h264AccessUnitIsIdr(accessUnit(4, [delimiter, sps, pps, [0x65, 0x88, 0x84]]), 4) === true,
  'AUD, SPS, PPS, IDR slice');
check('a non-IDR I frame after a recovery-point SEI is not IDR (x264 --open-gop)',
  h264AccessUnitIsIdr(accessUnit(4, [sei, [0x41, 0x9A, 0x02]]), 4) === false,
  'SEI, non-IDR slice');
check('the first slice decides, whatever follows it',
  h264AccessUnitIsIdr(accessUnit(4, [[0x41, 0x9A], [0x65, 0x88]]), 4) === false,
  'non-IDR slice, then IDR slice');
check('2-byte length prefixes are walked correctly',
  h264AccessUnitIsIdr(accessUnit(2, [sei, [0x41, 0x9A]]), 2) === false, 'lengthSize 2');
check('an access unit with no slice claims nothing (counts as IDR)',
  h264AccessUnitIsIdr(accessUnit(4, [delimiter, sei]), 4) === true, 'AUD, SEI only');

process.exit(failures ? 1 : 0);
