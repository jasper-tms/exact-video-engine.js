// How far a codec is allowed to reorder frames, read out of the bitstream's own
// sequence parameter set.
//
// WHY THIS EXISTS. A container that stores frames in decode order cannot publish
// a frame's display number until it knows that no frame still unread can present
// before it. Matroska proves almost nothing about that on its own: a block's
// timestamp is its cluster's plus a SIGNED 16-BIT offset, so the only bound the
// container itself gives is that window — 32768 ticks, 32.8 seconds at the
// default 1 ms timestamp scale. Waiting out 32.8 seconds of content before
// naming a single frame is correct and nearly useless.
//
// The bitstream is far less coy. H.264's `max_num_reorder_frames` and HEVC's
// `sps_max_num_reorder_pics` state exactly this quantity, in frames:
//
//   the greatest number of frames that may precede a frame in decode order and
//   follow it in presentation order
//
// Typical real-world values are 0 (no B-frames at all), 1, or 2 — so a bound of
// a handful of frames replaces a bound of half a minute.
//
// WHY IT IS A FACT AND NOT A GUESS. This is not an observation about how muxers
// usually behave, which is the kind of thing this library refuses to lean on. It
// is a field the encoder wrote into the stream describing the stream, in the
// same setup record whose profile and level we already trust to build the codec
// string a decoder is configured from. A stream that violates it is malformed,
// and the certified-prefix invariant in container-index.js catches that case
// outright rather than silently mis-numbering frames.
//
// Where H.264 omits the field — it lives in the optional VUI, and plenty of
// encoders write no VUI at all — the specification says to infer it, and the
// inference is itself a hard limit rather than a habit: a conforming stream can
// never reorder by more than its level's decoded-picture-buffer capacity. So
// there is an answer for every readable H.264 stream, and `null` is reserved for
// a record we genuinely cannot parse.

// Ceiling on decoded-picture-buffer size, in macroblocks, per H.264 level
// (ITU-T H.264 Table A-1). A level bounds the DPB in macroblocks rather than in
// frames, so the frame count depends on the picture size as well.
const H264_MAX_DECODED_PICTURE_BUFFER_MACROBLOCKS = new Map([
  [10, 396], [11, 900], [12, 2376], [13, 2376],
  [20, 2376], [21, 4752], [22, 8100],
  [30, 8100], [31, 18000], [32, 20480],
  [40, 32768], [41, 32768], [42, 34816],
  [50, 110400], [51, 184320], [52, 184320],
  [60, 696320], [61, 696320], [62, 696320],
]);

// The profiles for which constraint_set3_flag means "this stream does not
// reorder at all" (H.264 §E.2.1, the max_num_reorder_frames inference).
const H264_CONSTRAINED_PROFILES = new Set([44, 86, 100, 110, 122, 244]);

// The profiles whose sequence parameter set carries the chroma format, bit
// depths and scaling matrices that Baseline and Main do not (H.264 §7.3.2.1.1).
const H264_PROFILES_WITH_CHROMA_FORMAT = new Set([
  100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
]);

// The NAL unit type of an HEVC sequence parameter set (ITU-T H.265 Table 7-1).
const HEVC_SEQUENCE_PARAMETER_SET_NAL_TYPE = 33;

// The greatest number of frames that may precede a frame in decode order and
// follow it in presentation order, read from a codec setup record, or null when
// the record cannot be read.
//
// setupRecordKind is 'avcC' or 'hvcC'; setupRecordBytes is that record's body —
// the bytes Matroska stores in CodecPrivate and an MP4 stores in the box of the
// same name. Any other codec returns null: there is no such declaration in a VP8
// or VP9 stream (neither reorders, which callers establish another way) and none
// in an AV1 sequence header either.
export function declaredFrameReorderDepth(setupRecordKind, setupRecordBytes) {
  if (!setupRecordBytes || !setupRecordBytes.length) return null;
  try {
    if (setupRecordKind === 'avcC') return h264ReorderDepth(setupRecordBytes);
    if (setupRecordKind === 'hvcC') return hevcReorderDepth(setupRecordBytes);
  } catch (parseError) {
    // A record we cannot walk tells us nothing, and guessing at a reorder bound
    // is precisely the thing that would corrupt frame numbers. The caller falls
    // back to whatever its container proves on its own.
    return null;
  }
  return null;
}

// ==================================================================
// H.264
// ==================================================================

// avcC (ISO 14496-15 §5.3.3.1): a fixed 6-byte head, then a count of sequence
// parameter sets and each one's length and bytes.
function h264ReorderDepth(avcC) {
  if (avcC.length < 8) return null;
  const sequenceParameterSetCount = avcC[5] & 0x1F;
  if (!sequenceParameterSetCount) return null;
  const length = (avcC[6] << 8) | avcC[7];
  if (avcC.length < 8 + length || length < 2) return null;
  // Skip the one-byte NAL header; what follows is the sequence parameter set.
  const rawByteSequence =
    removeEmulationPrevention(avcC.subarray(9, 8 + length));
  return h264ReorderDepthFromSequenceParameterSet(rawByteSequence);
}

// Walk an H.264 sequence parameter set (ITU-T H.264 §7.3.2.1.1) as far as the
// VUI's max_num_reorder_frames, or to the end if the stream carries no VUI —
// in which case the specification's own inference applies (§E.2.1).
//
// Every field before the one we want has to be read rather than skipped: they
// are variable-length, so there is no seeking past them.
function h264ReorderDepthFromSequenceParameterSet(rawByteSequence) {
  const bits = new BitstreamReader(rawByteSequence);
  const profileIdc = bits.readBits(8);
  const constraintFlags = bits.readBits(8);
  const constraintSet3Flag = (constraintFlags >> 4) & 1;
  const levelIdc = bits.readBits(8);
  bits.readUnsignedExpGolomb();                       // seq_parameter_set_id

  let chromaFormatIdc = 1;
  if (H264_PROFILES_WITH_CHROMA_FORMAT.has(profileIdc)) {
    chromaFormatIdc = bits.readUnsignedExpGolomb();
    if (chromaFormatIdc === 3) bits.readBits(1);      // separate_colour_plane_flag
    bits.readUnsignedExpGolomb();                     // bit_depth_luma_minus8
    bits.readUnsignedExpGolomb();                     // bit_depth_chroma_minus8
    bits.readBits(1);                        // qpprime_y_zero_transform_bypass
    if (bits.readBits(1)) {                  // seq_scaling_matrix_present_flag
      const listCount = (chromaFormatIdc !== 3) ? 8 : 12;
      for (let i = 0; i < listCount; i++) {
        if (bits.readBits(1)) skipScalingList(bits, i < 6 ? 16 : 64);
      }
    }
  }

  bits.readUnsignedExpGolomb();                       // log2_max_frame_num_minus4
  const pictureOrderCountType = bits.readUnsignedExpGolomb();
  if (pictureOrderCountType === 0) {
    bits.readUnsignedExpGolomb();               // log2_max_pic_order_cnt_lsb_minus4
  } else if (pictureOrderCountType === 1) {
    bits.readBits(1);                           // delta_pic_order_always_zero_flag
    bits.readSignedExpGolomb();                 // offset_for_non_ref_pic
    bits.readSignedExpGolomb();                 // offset_for_top_to_bottom_field
    const cycleLength = bits.readUnsignedExpGolomb();
    for (let i = 0; i < cycleLength; i++) bits.readSignedExpGolomb();
  }

  bits.readUnsignedExpGolomb();                       // max_num_ref_frames
  bits.readBits(1);                        // gaps_in_frame_num_value_allowed_flag
  const pictureWidthInMacroblocks = bits.readUnsignedExpGolomb() + 1;
  const pictureHeightInMapUnits = bits.readUnsignedExpGolomb() + 1;
  const frameMacroblocksOnlyFlag = bits.readBits(1);
  if (!frameMacroblocksOnlyFlag) bits.readBits(1);   // mb_adaptive_frame_field_flag
  bits.readBits(1);                                  // direct_8x8_inference_flag
  if (bits.readBits(1)) {                            // frame_cropping_flag
    for (let i = 0; i < 4; i++) bits.readUnsignedExpGolomb();
  }

  // A frame is two field-heights tall unless the stream is frames-only.
  const frameHeightInMacroblocks =
    (2 - frameMacroblocksOnlyFlag) * pictureHeightInMapUnits;

  // Everything this field counts is measured in FRAMES. A field-coded stream
  // can put two fields where a caller counts one picture, so the bound would no
  // longer line up with what the caller is counting. Rather than reason about
  // which of those two a container's frames are, decline: an unknown bound
  // costs a caller its tighter watermark, and a wrong one costs it correctness.
  if (!frameMacroblocksOnlyFlag) return null;

  if (bits.readBits(1)) {                     // vui_parameters_present_flag
    const declared = h264ReorderDepthFromVideoUsability(bits);
    if (declared !== null) return declared;
  }

  // No VUI, or a VUI that stops before the bitstream restrictions: fall back to
  // the inference the specification itself defines.
  if (H264_CONSTRAINED_PROFILES.has(profileIdc) && constraintSet3Flag) return 0;
  return h264MaximumDecodedPictureBufferFrames(
    profileIdc, constraintSet3Flag, levelIdc,
    pictureWidthInMacroblocks, frameHeightInMacroblocks);
}

// The VUI (H.264 Annex E), read only as far as bitstream_restriction_flag.
// Returns the declared value, or null when the stream declares no restrictions.
function h264ReorderDepthFromVideoUsability(bits) {
  if (bits.readBits(1)) {                     // aspect_ratio_info_present_flag
    const aspectRatioIdc = bits.readBits(8);
    if (aspectRatioIdc === 255) bits.readBits(32);      // sar_width, sar_height
  }
  if (bits.readBits(1)) bits.readBits(1);     // overscan_info / overscan_appropriate
  if (bits.readBits(1)) {                     // video_signal_type_present_flag
    bits.readBits(4);                         // video_format, video_full_range_flag
    if (bits.readBits(1)) bits.readBits(24);  // the three colour description bytes
  }
  if (bits.readBits(1)) {                     // chroma_loc_info_present_flag
    bits.readUnsignedExpGolomb();
    bits.readUnsignedExpGolomb();
  }
  if (bits.readBits(1)) {                     // timing_info_present_flag
    bits.readBits(32);                        // num_units_in_tick
    bits.readBits(32);                        // time_scale
    bits.readBits(1);                         // fixed_frame_rate_flag
  }
  const nalHypotheticalReferenceDecoder = bits.readBits(1);
  if (nalHypotheticalReferenceDecoder) skipHypotheticalReferenceDecoder(bits);
  const videoCodingHypotheticalReferenceDecoder = bits.readBits(1);
  if (videoCodingHypotheticalReferenceDecoder) skipHypotheticalReferenceDecoder(bits);
  if (nalHypotheticalReferenceDecoder || videoCodingHypotheticalReferenceDecoder) {
    bits.readBits(1);                         // low_delay_hrd_flag
  }
  bits.readBits(1);                           // pic_struct_present_flag
  if (!bits.readBits(1)) return null;         // bitstream_restriction_flag

  bits.readBits(1);              // motion_vectors_over_pic_boundaries_flag
  bits.readUnsignedExpGolomb();  // max_bytes_per_pic_denom
  bits.readUnsignedExpGolomb();  // max_bits_per_mb_denom
  bits.readUnsignedExpGolomb();  // log2_max_mv_length_horizontal
  bits.readUnsignedExpGolomb();  // log2_max_mv_length_vertical
  return bits.readUnsignedExpGolomb();               // max_num_reorder_frames
}

function skipHypotheticalReferenceDecoder(bits) {
  const codedPictureBufferCount = bits.readUnsignedExpGolomb() + 1;
  bits.readBits(8);                           // bit_rate_scale, cpb_size_scale
  for (let i = 0; i < codedPictureBufferCount; i++) {
    bits.readUnsignedExpGolomb();             // bit_rate_value_minus1
    bits.readUnsignedExpGolomb();             // cpb_size_value_minus1
    bits.readBits(1);                         // cbr_flag
  }
  bits.readBits(20);      // the four delay-length fields, five bits each
}

function skipScalingList(bits, entryCount) {
  let lastScale = 8;
  let nextScale = 8;
  for (let i = 0; i < entryCount; i++) {
    if (nextScale !== 0) {
      const deltaScale = bits.readSignedExpGolomb();
      nextScale = (lastScale + deltaScale + 256) % 256;
    }
    if (nextScale !== 0) lastScale = nextScale;
  }
}

// How many frames this stream's level lets the decoded picture buffer hold
// (H.264 §A.3.1). A stream can never reorder by more than this, so it is a
// legitimate — if loose — bound where the encoder declared none.
function h264MaximumDecodedPictureBufferFrames(
  profileIdc, constraintSet3Flag, levelIdc,
  pictureWidthInMacroblocks, frameHeightInMacroblocks
) {
  // Level 1b is written as level_idc 11 with constraint_set3_flag set, on the
  // profiles where that flag is not the "no reordering" signal handled above.
  const isLevel1b = levelIdc === 11 && constraintSet3Flag
    && (profileIdc === 66 || profileIdc === 77 || profileIdc === 88);
  const macroblocks = isLevel1b
    ? 396 : H264_MAX_DECODED_PICTURE_BUFFER_MACROBLOCKS.get(levelIdc);
  if (!macroblocks) return null;
  const macroblocksPerFrame = pictureWidthInMacroblocks * frameHeightInMacroblocks;
  if (!macroblocksPerFrame) return null;
  return Math.min(Math.floor(macroblocks / macroblocksPerFrame), 16);
}

// ==================================================================
// HEVC
// ==================================================================

// hvcC (ISO 14496-15 §8.3.3.1): a 22-byte head, then arrays of parameter-set
// NAL units grouped by type. The sequence parameter set is type 33.
function hevcReorderDepth(hvcC) {
  if (hvcC.length < 23) return null;
  let at = 22;
  const arrayCount = hvcC[at++];
  for (let array = 0; array < arrayCount; array++) {
    if (at + 3 > hvcC.length) return null;
    const nalUnitType = hvcC[at] & 0x3F;
    const nalUnitCount = (hvcC[at + 1] << 8) | hvcC[at + 2];
    at += 3;
    for (let unit = 0; unit < nalUnitCount; unit++) {
      if (at + 2 > hvcC.length) return null;
      const length = (hvcC[at] << 8) | hvcC[at + 1];
      at += 2;
      if (at + length > hvcC.length) return null;
      if (nalUnitType === HEVC_SEQUENCE_PARAMETER_SET_NAL_TYPE && length > 2) {
        // Skip the two-byte NAL header.
        return hevcReorderDepthFromSequenceParameterSet(
          removeEmulationPrevention(hvcC.subarray(at + 2, at + length)));
      }
      at += length;
    }
  }
  return null;
}

// Walk an HEVC sequence parameter set (ITU-T H.265 §7.3.2.2.1) to
// sps_max_num_reorder_pics. Unlike H.264 this field is mandatory and sits early,
// so the only real work is stepping over profile_tier_level.
function hevcReorderDepthFromSequenceParameterSet(rawByteSequence) {
  const bits = new BitstreamReader(rawByteSequence);
  bits.readBits(4);                                   // sps_video_parameter_set_id
  const maximumSubLayersMinusOne = bits.readBits(3);
  bits.readBits(1);                                // sps_temporal_id_nesting_flag
  skipProfileTierLevel(bits, maximumSubLayersMinusOne);
  bits.readUnsignedExpGolomb();                       // sps_seq_parameter_set_id
  const chromaFormatIdc = bits.readUnsignedExpGolomb();
  if (chromaFormatIdc === 3) bits.readBits(1);     // separate_colour_plane_flag
  bits.readUnsignedExpGolomb();                       // pic_width_in_luma_samples
  bits.readUnsignedExpGolomb();                      // pic_height_in_luma_samples
  if (bits.readBits(1)) {                             // conformance_window_flag
    for (let i = 0; i < 4; i++) bits.readUnsignedExpGolomb();
  }
  bits.readUnsignedExpGolomb();                       // bit_depth_luma_minus8
  bits.readUnsignedExpGolomb();                       // bit_depth_chroma_minus8
  bits.readUnsignedExpGolomb();               // log2_max_pic_order_cnt_lsb_minus4
  const perSubLayer = bits.readBits(1);
  // The bound that matters is the one for the highest temporal sub-layer, which
  // is the last entry written — every frame the file presents is in it.
  let reorderDepth = null;
  for (let i = perSubLayer ? 0 : maximumSubLayersMinusOne;
       i <= maximumSubLayersMinusOne; i++) {
    bits.readUnsignedExpGolomb();            // sps_max_dec_pic_buffering_minus1
    reorderDepth = bits.readUnsignedExpGolomb();      // sps_max_num_reorder_pics
    bits.readUnsignedExpGolomb();            // sps_max_latency_increase_plus1
  }
  return reorderDepth;
}

// profile_tier_level (H.265 §7.3.3), with profilePresentFlag always 1 as it is
// when called from a sequence parameter set. Nothing in it is needed here; the
// point is to land on the bit after it.
function skipProfileTierLevel(bits, maximumSubLayersMinusOne) {
  bits.skipBits(88);                     // the general profile and constraint block
  bits.readBits(8);                      // general_level_idc
  const profilePresent = [];
  const levelPresent = [];
  for (let i = 0; i < maximumSubLayersMinusOne; i++) {
    profilePresent.push(bits.readBits(1));
    levelPresent.push(bits.readBits(1));
  }
  if (maximumSubLayersMinusOne > 0) {
    bits.skipBits(2 * (8 - maximumSubLayersMinusOne));   // reserved_zero_2bits
  }
  for (let i = 0; i < maximumSubLayersMinusOne; i++) {
    if (profilePresent[i]) bits.skipBits(88);
    if (levelPresent[i]) bits.readBits(8);
  }
}

// ==================================================================
// Bitstream plumbing
// ==================================================================

// A NAL unit's payload has 0x03 stuffed into it wherever the encoded bytes would
// otherwise have spelled a start code (00 00 00/01/02/03). Undo that to get the
// raw byte sequence the syntax above is written against.
export function removeEmulationPrevention(bytes) {
  // Nothing to undo in the common case; do not allocate for it.
  let stuffed = 0;
  for (let i = 2; i < bytes.length; i++) {
    if (bytes[i] === 0x03 && bytes[i - 1] === 0 && bytes[i - 2] === 0) stuffed++;
  }
  if (!stuffed) return bytes;
  const out = new Uint8Array(bytes.length - stuffed);
  let written = 0;
  let zeroRun = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (zeroRun === 2 && bytes[i] === 0x03) { zeroRun = 0; continue; }
    zeroRun = (bytes[i] === 0) ? zeroRun + 1 : 0;
    out[written++] = bytes[i];
  }
  return out.subarray(0, written);
}

// Most-significant-bit-first reader with the two exponential-Golomb forms the
// H.264 and H.265 syntax are written in. Running off the end throws, which the
// entry point turns into "this record cannot be read" — never into a guess.
class BitstreamReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.position = 0;
    this.bitCount = bytes.length * 8;
  }

  readBits(count) {
    let value = 0;
    for (let i = 0; i < count; i++) {
      if (this.position >= this.bitCount) throw new RangeError('bitstream ended');
      const bit = (this.bytes[this.position >> 3] >> (7 - (this.position & 7))) & 1;
      // Multiplication rather than a shift: 32-bit fields would otherwise turn
      // negative, and every value here is small enough to stay exact.
      value = value * 2 + bit;
      this.position++;
    }
    return value;
  }

  skipBits(count) {
    if (this.position + count > this.bitCount) throw new RangeError('bitstream ended');
    this.position += count;
  }

  // ue(v): a run of N zeros, a 1, then N more bits, worth 2^N - 1 plus those.
  readUnsignedExpGolomb() {
    let leadingZeros = 0;
    while (this.readBits(1) === 0) {
      leadingZeros++;
      // A valid field is at most 32 bits wide; a longer run means we have lost
      // our place in the syntax and everything after it would be invented.
      if (leadingZeros > 32) throw new RangeError('malformed exp-Golomb code');
    }
    if (leadingZeros === 0) return 0;
    return (2 ** leadingZeros - 1) + this.readBits(leadingZeros);
  }

  // se(v): the unsigned form folded into an alternating sequence 0, 1, -1, 2, ...
  readSignedExpGolomb() {
    const unsigned = this.readUnsignedExpGolomb();
    const magnitude = Math.ceil(unsigned / 2);
    return (unsigned % 2 === 0) ? -magnitude : magnitude;
  }
}
