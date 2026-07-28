// Unit test for the load-refusal error surface (src/unplayable-clip.js).
//
// The messages themselves are pinned in the browser by robustness-test.mjs,
// which drives real refusals through createBestEngine. What is checked here is
// the part that has to hold for a HOST rather than for a person: that the error
// is still an Error (so `catch (e) { show(e.message) }` keeps working), that
// every reason a caller might switch on is in the documented set, and that codec
// naming survives the profile suffixes real files carry.
import { UnplayableClipError, UNPLAYABLE_REASONS, describeCodec, namePlusCodecString } from '../src/unplayable-clip.js';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} unplayable-clip ${name}: ${detail}`);
}

// ---- the error stays an Error -------------------------------------------
// The whole point of extending Error rather than inventing a result type is
// that existing hosts keep working untouched. If any of these break, the change
// is no longer additive.
const error = new UnplayableClipError('the clip is unplayable', {
  reason: 'codec-not-decodable', codec: 'mp4v.20.1', numFrames: 2990,
});
check('is an Error', error instanceof Error, `instanceof Error: ${error instanceof Error}`);
check('is an UnplayableClipError',
  error instanceof UnplayableClipError, 'instanceof UnplayableClipError');
check('message survives', error.message === 'the clip is unplayable', error.message);
check('name is set for a host that switches on it',
  error.name === 'UnplayableClipError', error.name);
check('detail fields are attached',
  error.reason === 'codec-not-decodable' && error.codec === 'mp4v.20.1'
  && error.numFrames === 2990,
  `${error.reason} / ${error.codec} / ${error.numFrames}`);
check('a thrown one is catchable as an Error',
  (() => { try { throw error; } catch (caught) { return caught.message; } })()
    === 'the clip is unplayable', 'caught with its message');
check('detail without fields leaves them absent, not null',
  !('codec' in new UnplayableClipError('x')),
  `'codec' in error: ${'codec' in new UnplayableClipError('x')}`);

// ---- reasons -------------------------------------------------------------
check('the documented reasons are unique',
  new Set(UNPLAYABLE_REASONS).size === UNPLAYABLE_REASONS.length,
  UNPLAYABLE_REASONS.join(', '));
// Every reason the source can actually throw must be in the exported list, or a
// host that switched on all of them would still be surprised at runtime. This
// greps the sources rather than trusting the list to have been kept up.
const { readFileSync, readdirSync } = await import('node:fs');
const { join, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const thrownReasons = new Set();
for (const file of readdirSync(sourceDirectory)) {
  if (!file.endsWith('.js') || file === 'unplayable-clip.js') continue;
  const text = readFileSync(join(sourceDirectory, file), 'utf8');
  for (const match of text.matchAll(/reason:\s*'([a-z-]+)'/g)) thrownReasons.add(match[1]);
}
const undocumented = [...thrownReasons].filter((r) => !UNPLAYABLE_REASONS.includes(r));
check('every reason thrown in src/ is in UNPLAYABLE_REASONS',
  undocumented.length === 0,
  undocumented.length ? `undocumented: ${undocumented.join(', ')}`
    : `all ${thrownReasons.size} accounted for`);

// ---- codec naming --------------------------------------------------------
for (const [codecString, expected] of [
  ['mp4v.20.1', 'MPEG-4 Part 2'],
  ['avc1.640028', 'H.264'],
  ['avc1.42E01E', 'H.264'],       // upper-case hex in the profile suffix
  ['avc3.64001f', 'H.264'],
  ['hvc1.2.4.L123.b0', 'HEVC (H.265)'],
  ['hev1.1.6.L93.B0', 'HEVC (H.265)'],
  ['vp09.00.10.08', 'VP9'],
  ['vp08', 'VP8'],
  ['av01.0.00M.08', 'AV1'],
  ['mjpeg', 'Motion JPEG'],
  ['theora', 'Theora'],
]) {
  check(`describeCodec(${codecString})`,
    describeCodec(codecString) === expected, describeCodec(codecString));
}
check('an unknown codec falls back to its own string, never to nothing',
  describeCodec('xyzw.1.2') === 'xyzw.1.2', describeCodec('xyzw.1.2'));
check('no codec at all is null, not the string "null"',
  describeCodec(null) === null && describeCodec('') === null,
  `${describeCodec(null)} / ${describeCodec('')}`);

check('namePlusCodecString reads as a person would say it',
  namePlusCodecString('mp4v.20.1') === 'MPEG-4 Part 2 (mp4v.20.1)',
  namePlusCodecString('mp4v.20.1'));
check('namePlusCodecString does not repeat itself when there is no friendly name',
  namePlusCodecString('xyzw.1') === 'xyzw.1', namePlusCodecString('xyzw.1'));
check('namePlusCodecString says something when the codec is unknown',
  namePlusCodecString(null) === 'an unknown codec', namePlusCodecString(null));

process.exit(failures ? 1 : 0);
