// A decoder for containers whose "video codec" is really a run of still images.
//
// Motion JPEG is a sequence of complete JPEG images, one per frame, and it is
// what a great deal of real footage actually is: webcams, machine-vision and
// microscope cameras, older camcorders, and much of what sits in a `.avi` on a
// lab drive.
//
// No browser ships an MJPEG `VideoDecoder`, and none is needed. Every browser
// has a JPEG decoder, the container index already gives each frame an exact byte
// range and an exact presentation time, and `createImageBitmap` turns one
// frame's bytes into something a `VideoFrame` can be built from.
//
// So this class is a `VideoDecoder` in shape — same constructor, same
// `configure` / `decode` / `flush` / `reset` / `close`, same `decodeQueueSize`
// and `output` callback — and the engine's decode driver uses it without knowing
// the difference. Keep it that way: the driver's hard parts (keyframe runs,
// read-ahead windows, the byte-budgeted frame cache) are about WHICH frames to
// decode, so a codec that changes only HOW belongs behind this interface rather
// than in a branch through the driver.
//
// Two things follow from every frame being independent. `bitmapForFrame()` on
// frame 40000 costs one frame's work rather than a group of pictures', because
// there is no keyframe to walk forward from; and nothing reorders, so a
// progressively built index certifies a frame as soon as it is read.
//
// `createImageBitmap` rather than `ImageDecoder`: ImageDecoder would save a copy
// and is the better fit on paper, but it is not in Safari, and a second code
// path that only some browsers take is a second code path to be wrong in. A JPEG
// frame is small and this is one decode per displayed frame either way.

// The codec string this engine uses for Motion JPEG. WebCodecs registers no
// string for it — there is no `VideoDecoder` to name — so this is our own
// marker, carried on decoderConfig.codec and exposed as engine.codecString the
// same as any other. Anything reading that field should treat it as "frames are
// whole JPEG images" and nothing more.
export const MOTION_JPEG_CODEC = 'mjpeg';

// Does this codec string mean "each sample is a complete still image", and so
// belong to ImageFrameDecoder rather than to a VideoDecoder?
export function isImageFrameCodec(codec) {
  return codec === MOTION_JPEG_CODEC;
}

// Can this browser decode image frames at all? The `VideoDecoder` a caller would
// otherwise have feature-detected is not involved, so it is the wrong question
// to ask: what this path needs is a JPEG decoder and the `VideoFrame`
// constructor. Both are present wherever WebCodecs is, and `VideoFrame` can be
// present where `VideoDecoder` is not much use.
export function canDecodeImageFrames() {
  return typeof createImageBitmap === 'function' && typeof VideoFrame !== 'undefined';
}

export class ImageFrameDecoder {
  constructor({ output, error }) {
    this._output = output;
    this._onError = error;
    this.state = 'unconfigured';   // 'unconfigured' | 'configured' | 'closed'
    // How many frames have been handed over and not yet emitted. The decode
    // driver throttles on this exactly as it does for a VideoDecoder.
    this.decodeQueueSize = 0;
    // Decoding is serialized through this chain rather than run concurrently, so
    // frames come out in the order they went in. A VideoDecoder's output order is
    // part of its contract and the driver's bookkeeping leans on it; N concurrent
    // createImageBitmap calls would not keep that promise.
    this._chain = Promise.resolve();
    // Bumped by reset() and close(), so work already queued against a previous
    // configuration is dropped rather than emitted into the new one.
    this._generation = 0;
  }

  // Nothing to set up: a JPEG frame carries its own dimensions and colour
  // information. The configuration is accepted so callers need no special case,
  // and its codec is checked so a wrong one fails here rather than silently
  // decoding something else.
  configure(config) {
    if (this.state === 'closed') throw new Error('ImageFrameDecoder is closed');
    if (!config || !isImageFrameCodec(config.codec)) {
      throw new TypeError(
        `ImageFrameDecoder cannot decode '${config && config.codec}'`);
    }
    this.state = 'configured';
  }

  decode(chunk) {
    if (this.state !== 'configured') {
      throw new Error('ImageFrameDecoder is not configured');
    }
    // Copy the bytes out now: the caller is free to reuse or detach the chunk the
    // moment decode() returns, and this frame may not be touched for a while.
    const bytes = new Uint8Array(chunk.byteLength);
    chunk.copyTo(bytes);
    const { timestamp, duration } = chunk;
    const generation = this._generation;

    this.decodeQueueSize += 1;
    this._chain = this._chain
      .then(() => this._decodeOne(bytes, timestamp, duration, generation))
      .then(() => { this.decodeQueueSize -= 1; },
        () => { this.decodeQueueSize -= 1; });
  }

  async _decodeOne(bytes, timestamp, duration, generation) {
    if (generation !== this._generation || this.state !== 'configured') return;
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      // The engine may have reset or closed us while that was in flight.
      if (generation !== this._generation || this.state !== 'configured') return;
      // VideoFrame copies the image, so the bitmap can go straight after.
      this._output(new VideoFrame(bitmap, { timestamp, duration }));
    } catch (error) {
      // A frame that will not decode is fatal in the same way a VideoDecoder
      // error is: the engine marks itself failed and tells the host, rather than
      // showing the wrong picture or hanging on a frame that is never coming.
      this.state = 'closed';
      this._onError(error);
    } finally {
      if (bitmap) bitmap.close();
    }
  }

  // Every frame handed over so far has been emitted once this resolves.
  async flush() {
    await this._chain;
  }

  // Drop everything queued. There is no decoder state to rebuild — the next
  // decode() stands alone, which is the whole point of this format.
  reset() {
    this._generation += 1;
    this._chain = Promise.resolve();
    this.decodeQueueSize = 0;
    this.state = 'unconfigured';
  }

  close() {
    this._generation += 1;
    this._chain = Promise.resolve();
    this.decodeQueueSize = 0;
    this.state = 'closed';
  }
}
