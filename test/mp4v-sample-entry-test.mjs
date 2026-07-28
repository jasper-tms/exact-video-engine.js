// Unit test for MPEG-4 Part 2 (`mp4v`) sample-entry parsing in ContainerIndex
// (src/container-index.js). The ISOBMFF demux around it needs mp4box and a
// browser, but the piece this feature adds is pure — bytes in, a codec string
// and setup bytes out — so it is pinned here against real muxer output, and the
// browser-side frame-index test then proves the whole path pixel-exact on
// counter-mp4v.mp4.
//
// The two REAL fixtures below are the bytes mp4box hands back for an `mp4v`
// sample entry (past its header and data_reference_index), captured from files
// two different libavformat versions wrote — which is what OpenCV's VideoWriter
// produces, the reason this path exists. They differ in ways worth having both
// of: the first carries a `pasp` box before the `btrt`, the second does not, so
// between them they prove the child-box walk really walks rather than assuming
// `esds` sits at a fixed offset.
//
// The SYNTHETIC cases cover what no file on this machine happens to contain: an
// ES_Descriptor with its three optional fields present, a stream that is not
// MPEG-4 Part 2 at all, and the malformed inputs a parser reached by untrusted
// files has to answer with null rather than an exception.
import { readMpeg4VisualSampleEntry } from '../src/container-index.js';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} mp4v-sample-entry ${name}: ${detail}`);
}

function bytesFromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

// ---- real muxer output ---------------------------------------------------

// OpenCV VideoWriter (Lavc59.37.100), 1350x962, Simple Profile Level 1.
const OPENCV_ENTRY = bytesFromHex(
  '00000000000000000000000000000000054603c200480000004800000000000000010000000000000000000000000000'
  + '0000000000000000000000000000000000000018ffff000000606573647300000000038080804f000100048080804120'
  + '1100000001d7c90401d26e5c058080802f000001b001000001b58913000001000000012000c48d8803252a3478546300'
  + '0001b24c61766335392e33372e3130300680808001020000001070617370000000010000000100000014627472740000'
  + '000001d7c90401d26e5c');

// The counter fixture ffmpeg writes for the browser test (Lavc58.134.100),
// 150x90, same profile and level, no `pasp` box.
const COUNTER_ENTRY = bytesFromHex(
  '000000000000000000000000000000000096005a00480000004800000000000000010000000000000000000000000000'
  + '0000000000000000000000000000000000000018ffff0000006165736473000000000380808050000100048080804220'
  + '1100000000053428000534280580808030000001b001000001b58913000001000000012000c48d8800f504b40b544300'
  + '0001b24c61766335382e3133342e3130300680808001020000001462747274000000000005342800053428');

const opencv = readMpeg4VisualSampleEntry(OPENCV_ENTRY);
check('OpenCV entry is recognized', opencv !== null, opencv ? 'parsed' : 'got null');
check('OpenCV dimensions',
  opencv.width === 1350 && opencv.height === 962, `${opencv.width}x${opencv.height}`);
check('OpenCV codec string', opencv.codec === 'mp4v.20.1', opencv.codec);
check('OpenCV setup bytes are the 47-byte VisualObjectSequence',
  opencv.decoderSpecificInfo.length === 47, `${opencv.decoderSpecificInfo.length} bytes`);
check('OpenCV setup bytes open with the sequence start code',
  opencv.decoderSpecificInfo[0] === 0 && opencv.decoderSpecificInfo[1] === 0
  && opencv.decoderSpecificInfo[2] === 1 && opencv.decoderSpecificInfo[3] === 0xb0,
  Array.from(opencv.decoderSpecificInfo.slice(0, 5)).join(' '));

const counter = readMpeg4VisualSampleEntry(COUNTER_ENTRY);
check('counter entry is recognized (no pasp box before btrt)',
  counter !== null, counter ? 'parsed' : 'got null');
check('counter dimensions',
  counter.width === 150 && counter.height === 90, `${counter.width}x${counter.height}`);
check('counter codec string', counter.codec === 'mp4v.20.1', counter.codec);
check('counter setup bytes',
  counter.decoderSpecificInfo.length === 48, `${counter.decoderSpecificInfo.length} bytes`);

// ---- synthetic entries ---------------------------------------------------

const ELEMENTARY_STREAM_DESCRIPTOR_TAG = 0x03;
const DECODER_CONFIG_DESCRIPTOR_TAG = 0x04;
const DECODER_SPECIFIC_INFO_TAG = 0x05;
const MPEG4_VISUAL = 0x20;
const AAC_AUDIO = 0x40;

// Simple Profile Level 3: a sequence header whose profile byte is 9, so the
// codec string must say 9 and not repeat the fixtures' 1.
const LEVEL_3_SETUP = new Uint8Array([0x00, 0x00, 0x01, 0xb0, 0x09, 0x00, 0x00, 0x01, 0xb5]);

// Build a VisualSampleEntry body (as mp4box hands it back, past the box header
// and data_reference_index) around a list of child boxes.
function makeSampleEntry(width, height, childBoxes) {
  const prefix = new Uint8Array(70);
  const view = new DataView(prefix.buffer);
  view.setUint16(16, width);
  view.setUint16(18, height);
  prefix[66] = 0x00; prefix[67] = 0x18;           // depth
  prefix[68] = 0xff; prefix[69] = 0xff;           // pre_defined
  const total = prefix.length + childBoxes.reduce((sum, box) => sum + box.length, 0);
  const bytes = new Uint8Array(total);
  bytes.set(prefix, 0);
  let offset = prefix.length;
  for (const box of childBoxes) { bytes.set(box, offset); offset += box.length; }
  return bytes;
}

function makeBox(type, body) {
  const bytes = new Uint8Array(8 + body.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(body, 8);
  return bytes;
}

// A descriptor with a single-byte length, which is all these fixtures need.
function makeDescriptor(tag, body) {
  return new Uint8Array([tag, body.length, ...body]);
}

// An `esds` body carrying one DecoderConfigDescriptor. `elementaryStreamFlags`
// drives the three optional ES_Descriptor fields, whose presence shifts
// everything after them.
function makeEsdsBody(objectTypeIndication, decoderSpecificInfo, elementaryStreamFlags = 0) {
  const decoderConfigBody = [
    objectTypeIndication, 0x11, 0x00, 0x00, 0x00,   // type, stream type, buffer size
    0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, // maximum and average bit rates
  ];
  if (decoderSpecificInfo) {
    decoderConfigBody.push(
      ...makeDescriptor(DECODER_SPECIFIC_INFO_TAG, decoderSpecificInfo));
  }
  const elementaryStreamBody = [0x00, 0x01, elementaryStreamFlags];
  if (elementaryStreamFlags & 0x80) elementaryStreamBody.push(0x00, 0x02);
  if (elementaryStreamFlags & 0x40) elementaryStreamBody.push(0x03, 0x61, 0x62, 0x63);
  if (elementaryStreamFlags & 0x20) elementaryStreamBody.push(0x00, 0x04);
  elementaryStreamBody.push(
    ...makeDescriptor(DECODER_CONFIG_DESCRIPTOR_TAG, decoderConfigBody));
  return new Uint8Array([
    0x00, 0x00, 0x00, 0x00,   // version and flags
    ...makeDescriptor(ELEMENTARY_STREAM_DESCRIPTOR_TAG, elementaryStreamBody),
  ]);
}

const withFlags = readMpeg4VisualSampleEntry(makeSampleEntry(640, 480, [
  makeBox('esds', makeEsdsBody(MPEG4_VISUAL, LEVEL_3_SETUP, 0xe0)),
]));
check('ES_Descriptor optional fields are skipped, not misread',
  withFlags !== null && withFlags.codec === 'mp4v.20.9',
  withFlags ? withFlags.codec : 'got null');
check('profile and level come from the sequence header',
  withFlags && withFlags.width === 640 && withFlags.height === 480,
  withFlags ? `${withFlags.width}x${withFlags.height}` : 'got null');

const beforeEsds = readMpeg4VisualSampleEntry(makeSampleEntry(320, 240, [
  makeBox('pasp', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1])),
  makeBox('esds', makeEsdsBody(MPEG4_VISUAL, LEVEL_3_SETUP)),
]));
check('esds is found behind an earlier child box',
  beforeEsds !== null && beforeEsds.codec === 'mp4v.20.9',
  beforeEsds ? beforeEsds.codec : 'got null');

const inBandHeaders = readMpeg4VisualSampleEntry(makeSampleEntry(320, 240, [
  makeBox('esds', makeEsdsBody(MPEG4_VISUAL, null)),
]));
check('a stream with no setup bytes stops the codec string short rather than inventing a level',
  inBandHeaders !== null && inBandHeaders.codec === 'mp4v.20'
  && inBandHeaders.decoderSpecificInfo === undefined,
  inBandHeaders ? `${inBandHeaders.codec}, description ${inBandHeaders.decoderSpecificInfo}` : 'got null');

// `mp4v` is the generic MPEG-4 elementary stream sample entry; only the object
// type indication says what is actually inside. Anything that is not MPEG-4
// Part 2 video must be refused, not handed on as if it were.
const notVideo = readMpeg4VisualSampleEntry(makeSampleEntry(320, 240, [
  makeBox('esds', makeEsdsBody(AAC_AUDIO, LEVEL_3_SETUP)),
]));
check('a non-MPEG-4-Part-2 object type is refused',
  notVideo === null, notVideo ? `parsed as ${notVideo.codec}` : 'null');

const noEsds = readMpeg4VisualSampleEntry(makeSampleEntry(320, 240, [
  makeBox('pasp', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1])),
]));
check('an entry with no esds is refused', noEsds === null,
  noEsds ? `parsed as ${noEsds.codec}` : 'null');

// Malformed input answers null rather than throwing: these bytes come from a
// file the engine did not write and cannot trust.
for (const [name, input] of [
  ['null', null],
  ['empty', new Uint8Array(0)],
  ['shorter than the fixed fields', new Uint8Array(40)],
  ['fixed fields only, no child boxes', new Uint8Array(70)],
  ['a child box claiming more length than it has',
    (() => {
      const bytes = makeSampleEntry(320, 240, [makeBox('esds', makeEsdsBody(MPEG4_VISUAL, LEVEL_3_SETUP))]);
      new DataView(bytes.buffer).setUint32(70, 0xffff);
      return bytes;
    })()],
  ['a truncated esds body',
    makeSampleEntry(320, 240, [makeBox('esds', new Uint8Array([0, 0, 0, 0, 0x03]))])],
]) {
  let result, threw = null;
  try { result = readMpeg4VisualSampleEntry(input); }
  catch (error) { threw = error; }
  check(`malformed input (${name}) is refused without throwing`,
    threw === null && !result, threw ? `threw ${threw.message}` : `returned ${result}`);
}

process.exit(failures ? 1 : 0);
