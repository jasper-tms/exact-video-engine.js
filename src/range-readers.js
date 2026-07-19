// Random-access byte readers used to feed mp4box (the moov index) and to fetch
// encoded samples per GOP on demand — only the bytes actually needed are read.
// URLs go over HTTP Range (the server must answer 206); local Files use
// File.slice.
export class UrlRangeReader {
  // Opening a clip is a chain of dependent reads -- learn the size, sniff the
  // container, find the moov, read the frame -- and each one costs a full round
  // trip. Against a bucket 400 ms away (Firebase Storage, measured), eight round
  // trips is four seconds of an empty pane, however few bytes they carry: the
  // first two reads of the old chain asked for ONE byte and FOUR bytes.
  //
  // So the first read is speculative and generous. It answers the size (every
  // 206 names it in Content-Range), the magic number, and, for a faststart clip,
  // the whole moov -- from one round trip instead of three. And a clip small
  // enough to be worth having outright is then fetched outright, rather than
  // groped through a range at a time: a scrub through it would read most of it
  // anyway, and each range is another 400 ms.
  static HEAD_BYTES = 1 << 18;       // 256 KB: enough for a faststart moov
  static WHOLE_FILE_MAX = 8 << 20;   // 8 MB: below this, just take the file

  constructor(url) {
    this.url = url;
    this.size = 0;
    this._cache = null;    // bytes [0, _cache.length) of the file, or null
  }

  async init() {
    const head = await this._fetchRange(0, UrlRangeReader.HEAD_BYTES - 1);
    this._cache = new Uint8Array(head.body);

    if (head.totalSize) this.size = head.totalSize;
    else this.size = this._cache.length;   // a 200: the whole file is in hand

    if (this.size <= this._cache.length) return;
    if (this.size > UrlRangeReader.WHOLE_FILE_MAX) return;

    const rest = await this._fetchRange(this._cache.length, this.size - 1);
    const whole = new Uint8Array(this.size);
    whole.set(this._cache, 0);
    whole.set(new Uint8Array(rest.body), this._cache.length);
    this._cache = whole;
  }

  async read(start, endInclusive) {
    if (this._cache && endInclusive < this._cache.length) {
      // slice() copies, which is what callers want: mp4box takes ownership of
      // the buffers it is appended, and would otherwise be handed a view onto
      // the cache it could detach.
      return this._cache.slice(start, endInclusive + 1).buffer;
    }
    return (await this._fetchRange(start, endInclusive)).body;
  }

  async _fetchRange(start, endInclusive) {
    const response = await fetch(this.url,
      { headers: { Range: `bytes=${start}-${endInclusive}` } });
    if (response.status !== 206 && response.status !== 200) {
      throw new Error(`range read ${response.status}`);
    }
    // A 206 names the file's total size in Content-Range ("bytes 0-99/12345");
    // a 200 means the server ignored Range and sent everything, so what arrived
    // IS the file. Either way we now know how big it is, with no probe request.
    const contentRange = response.headers.get('Content-Range');
    const totalSize = contentRange
      ? parseInt(contentRange.split('/')[1], 10) : 0;
    return { body: await response.arrayBuffer(), totalSize };
  }
}

export class FileRangeReader {
  constructor(file) { this.file = file; this.size = file.size; }
  async init() {}
  async read(start, endInclusive) {
    return await this.file.slice(start, endInclusive + 1).arrayBuffer();
  }
}

// A source is a URL string (server must answer HTTP Range with 206) or a
// File/Blob (browsed local clip).
export function createRangeReader(source) {
  return (typeof source === 'string')
    ? new UrlRangeReader(source) : new FileRangeReader(source);
}

