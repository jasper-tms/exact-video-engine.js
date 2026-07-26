// Bitstreams written by hand, so a test can state the value it wants read back.
//
// Shared by frame-reorder-bound-test.mjs (which checks the value is read
// correctly) and progressive-index-test.mjs (which checks a Matroska pass
// certifies frames early once it knows one). Neither could use a generated
// fixture for this: what they need is a stream declaring a chosen reorder
// depth, and ffmpeg writes whatever its encoder chose.

// The mirror image of src/frame-reorder-bound.js's reader: most-significant-bit
// first, with both exponential-Golomb forms.
export class BitWriter {
  constructor() { this.bits = []; }

  writeBits(count, value) {
    for (let i = count - 1; i >= 0; i--) {
      this.bits.push(Math.floor(value / 2 ** i) & 1);
    }
    return this;
  }

  writeFlag(value) { this.bits.push(value ? 1 : 0); return this; }

  // ue(v): v + 1 written in binary, preceded by one zero per bit after the first.
  writeUnsignedExpGolomb(value) {
    const code = value + 1;
    const bitLength = Math.floor(Math.log2(code)) + 1;
    this.writeBits(bitLength - 1, 0);
    return this.writeBits(bitLength, code);
  }

  writeSignedExpGolomb(value) {
    return this.writeUnsignedExpGolomb(value > 0 ? 2 * value - 1 : -2 * value);
  }

  // The raw byte sequence: a stop bit, then zeros to the byte boundary.
  toBytes() {
    const bits = this.bits.concat([1]);
    while (bits.length % 8) bits.push(0);
    const bytes = new Uint8Array(bits.length / 8);
    for (let i = 0; i < bits.length; i++) {
      bytes[i >> 3] |= bits[i] << (7 - (i & 7));
    }
    return bytes;
  }
}

// Put back the 0x03 bytes a NAL payload carries wherever it would otherwise have
// spelled a start code. The reader strips these; a record that never had them
// would not prove it does.
export function addEmulationPrevention(bytes) {
  const out = [];
  let zeroRun = 0;
  for (const byte of bytes) {
    if (zeroRun === 2 && byte <= 0x03) { out.push(0x03); zeroRun = 0; }
    out.push(byte);
    zeroRun = (byte === 0) ? zeroRun + 1 : 0;
  }
  return new Uint8Array(out);
}

// An H.264 sequence parameter set (ITU-T H.264 §7.3.2.1.1), carrying whatever
// the case at hand needs and the smallest legal thing everywhere else.
export function buildH264SequenceParameterSet({
  profileIdc = 66, constraintFlags = 0, levelIdc = 30,
  widthInMacroblocks = 80, heightInMapUnits = 45,
  frameMacroblocksOnly = true,
  declaredReorderFrames = null,   // null: write no bitstream restrictions
  writeVideoUsability = true,
} = {}) {
  const profilesWithChromaFormat = new Set([100, 110, 122, 244, 44, 83, 86, 118]);
  const bits = new BitWriter();
  bits.writeBits(8, profileIdc);
  bits.writeBits(8, constraintFlags);
  bits.writeBits(8, levelIdc);
  bits.writeUnsignedExpGolomb(0);                  // seq_parameter_set_id
  if (profilesWithChromaFormat.has(profileIdc)) {
    bits.writeUnsignedExpGolomb(1);                // chroma_format_idc: 4:2:0
    bits.writeUnsignedExpGolomb(0);                // bit_depth_luma_minus8
    bits.writeUnsignedExpGolomb(0);                // bit_depth_chroma_minus8
    bits.writeFlag(0);                             // qpprime_y_zero_transform_bypass
    bits.writeFlag(0);                             // seq_scaling_matrix_present_flag
  }
  bits.writeUnsignedExpGolomb(0);                  // log2_max_frame_num_minus4
  bits.writeUnsignedExpGolomb(0);                  // pic_order_cnt_type
  bits.writeUnsignedExpGolomb(0);            // log2_max_pic_order_cnt_lsb_minus4
  bits.writeUnsignedExpGolomb(1);                  // max_num_ref_frames
  bits.writeFlag(0);                     // gaps_in_frame_num_value_allowed_flag
  bits.writeUnsignedExpGolomb(widthInMacroblocks - 1);
  bits.writeUnsignedExpGolomb(heightInMapUnits - 1);
  bits.writeFlag(frameMacroblocksOnly);
  if (!frameMacroblocksOnly) bits.writeFlag(0);    // mb_adaptive_frame_field_flag
  bits.writeFlag(1);                               // direct_8x8_inference_flag
  bits.writeFlag(0);                               // frame_cropping_flag
  bits.writeFlag(writeVideoUsability);
  if (writeVideoUsability) {
    bits.writeFlag(0);                   // aspect_ratio_info_present_flag
    bits.writeFlag(0);                   // overscan_info_present_flag
    bits.writeFlag(0);                   // video_signal_type_present_flag
    bits.writeFlag(0);                   // chroma_loc_info_present_flag
    bits.writeFlag(0);                   // timing_info_present_flag
    bits.writeFlag(0);                   // nal_hrd_parameters_present_flag
    bits.writeFlag(0);                   // vcl_hrd_parameters_present_flag
    bits.writeFlag(0);                   // pic_struct_present_flag
    bits.writeFlag(declaredReorderFrames !== null);   // bitstream_restriction_flag
    if (declaredReorderFrames !== null) {
      bits.writeFlag(1);                 // motion_vectors_over_pic_boundaries_flag
      bits.writeUnsignedExpGolomb(0);    // max_bytes_per_pic_denom
      bits.writeUnsignedExpGolomb(0);    // max_bits_per_mb_denom
      bits.writeUnsignedExpGolomb(10);   // log2_max_mv_length_horizontal
      bits.writeUnsignedExpGolomb(10);   // log2_max_mv_length_vertical
      bits.writeUnsignedExpGolomb(declaredReorderFrames);   // max_num_reorder_frames
      bits.writeUnsignedExpGolomb(declaredReorderFrames);   // max_dec_frame_buffering
    }
  }
  return { rawByteSequence: bits.toBytes(), profileIdc, constraintFlags, levelIdc };
}

// The avcC record (ISO 14496-15 §5.3.3.1) around that sequence parameter set.
export function buildAvcC(sequenceParameterSet) {
  const { rawByteSequence, profileIdc, constraintFlags, levelIdc } = sequenceParameterSet;
  const nal = addEmulationPrevention(
    new Uint8Array([0x67, ...rawByteSequence]));   // NAL header: SPS, reference
  return new Uint8Array([
    0x01, profileIdc, constraintFlags, levelIdc,
    0xFF,                                  // lengthSizeMinusOne, with its 1 bits
    0xE1,                                  // one sequence parameter set
    (nal.length >> 8) & 0xFF, nal.length & 0xFF, ...nal,
    0x01, 0x00, 0x04, 0x68, 0xCE, 0x3C, 0x80,     // one picture parameter set
  ]);
}

// An HEVC sequence parameter set (ITU-T H.265 §7.3.2.2.1) and its hvcC record.
export function buildHevcRecord({ declaredReorderPictures = 1, subLayers = 1 } = {}) {
  const maximumSubLayersMinusOne = subLayers - 1;
  const bits = new BitWriter();
  bits.writeBits(4, 0);                          // sps_video_parameter_set_id
  bits.writeBits(3, maximumSubLayersMinusOne);
  bits.writeFlag(1);                             // sps_temporal_id_nesting_flag
  // profile_tier_level: the general block is a fixed 88 bits before the level.
  bits.writeBits(2, 0);                          // general_profile_space
  bits.writeFlag(0);                             // general_tier_flag
  bits.writeBits(5, 1);                          // general_profile_idc: Main
  bits.writeBits(32, 0x60000000);            // general_profile_compatibility_flags
  bits.writeBits(16, 0);                     // the first 16 constraint/source bits
  bits.writeBits(16, 0);
  bits.writeBits(16, 0);
  bits.writeBits(8, 93);                         // general_level_idc
  for (let i = 0; i < maximumSubLayersMinusOne; i++) {
    bits.writeFlag(0);                           // sub_layer_profile_present_flag
    bits.writeFlag(0);                           // sub_layer_level_present_flag
  }
  if (maximumSubLayersMinusOne > 0) {
    for (let i = maximumSubLayersMinusOne; i < 8; i++) bits.writeBits(2, 0);
  }
  bits.writeUnsignedExpGolomb(0);                // sps_seq_parameter_set_id
  bits.writeUnsignedExpGolomb(1);                // chroma_format_idc: 4:2:0
  bits.writeUnsignedExpGolomb(1920);             // pic_width_in_luma_samples
  bits.writeUnsignedExpGolomb(1080);             // pic_height_in_luma_samples
  bits.writeFlag(0);                             // conformance_window_flag
  bits.writeUnsignedExpGolomb(0);                // bit_depth_luma_minus8
  bits.writeUnsignedExpGolomb(0);                // bit_depth_chroma_minus8
  bits.writeUnsignedExpGolomb(4);          // log2_max_pic_order_cnt_lsb_minus4
  bits.writeFlag(1);             // sps_sub_layer_ordering_info_present_flag
  for (let i = 0; i <= maximumSubLayersMinusOne; i++) {
    bits.writeUnsignedExpGolomb(4);       // sps_max_dec_pic_buffering_minus1
    // Lower sub-layers reorder less; the highest one is the bound that counts,
    // and writing a different value below it is how this proves which is read.
    bits.writeUnsignedExpGolomb(
      i === maximumSubLayersMinusOne ? declaredReorderPictures : 0);
    bits.writeUnsignedExpGolomb(0);       // sps_max_latency_increase_plus1
  }
  const nal = addEmulationPrevention(
    new Uint8Array([0x42, 0x01, ...bits.toBytes()]));   // NAL header: SPS, tid 0
  const head = new Uint8Array(22);
  head[0] = 0x01;
  head[1] = 0x01;                                 // Main profile, main tier
  head[2] = 0x60;                                 // compatibility flags
  head[12] = 93;                                  // general_level_idc
  head[13] = 0xF0;                                // min_spatial_segmentation_idc
  head[15] = 0xFC;                                // parallelismType
  head[16] = 0xFD;                                // chromaFormat: 4:2:0
  head[17] = 0xF8;                                // bitDepthLumaMinus8
  head[18] = 0xF8;                                // bitDepthChromaMinus8
  head[21] = 0x0F;                                // numTemporalLayers, lengthSize
  return new Uint8Array([
    ...head,
    1,                                            // one array
    0x80 | 33, 0x00, 0x01,                  // complete, SPS, one NAL unit in it
    (nal.length >> 8) & 0xFF, nal.length & 0xFF, ...nal,
  ]);
}
