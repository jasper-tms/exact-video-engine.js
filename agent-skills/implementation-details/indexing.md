# Container indexing

Everything rests on one insight: a `<video>` element's
`requestVideoFrameCallback` reports `mediaTime`, the presented frame's *exact*
presentation timestamp — not an estimate. What the element withholds is the
*table* of every frame's timestamp, without which a timestamp cannot be turned
into a frame *index* — so the usual fallback multiplies by an assumed constant
frame rate and quietly mismaps every variable-frame-rate clip. That table can
be read straight out of the container with nothing decoded. `ContainerIndex`
(`src/container-index.js`) builds it, sniffing the format from the first
bytes, and the same table serves whichever engine ends up playing.

Some indexes are richer than others. Timestamps alone make the native tier
frame-exact; adding each frame's byte range, keyframe flag, and a decoder
configuration makes the index rich enough to drive WebCodecs
(`supportsWebCodecs` on the index). Per container:

## MP4 / MOV (classic)

mp4box.js reads the sample table out of the `moov` — a few range requests, no
full-file read, however long the clip. Full decode table.

Two sample entries mp4box does not recognize as video are rescued by the
engine rather than accepted as "no video track in file": `jpeg`
(QuickTime/MP4 Motion JPEG) and `mp4v` (MPEG-4 Part 2, OpenCV
`VideoWriter`'s default output). mp4box files both under *metadata* with no
dimensions; the engine reads the sample entry's own bytes — for `mp4v`, the
`esds` descriptor tree, yielding a codec string like `mp4v.20.1` (object type
indication in hexadecimal, then profile and level from the stream's own
sequence header) and the coded dimensions.

## Fragmented MP4 (fMP4/CMAF)

An `mvex` box in the `moov` announces that the samples live in `moof`
fragments scattered through the file, so there is no central sample table.
The engine detects that and feeds the whole file through mp4box so every
fragment's samples land in the table — still nothing decoded, but a full-file
read, so it takes the same budget, progress reporting, cache treatment, and
`playWhileIndexing` treatment as the Matroska scan. The resulting index is as
complete as a classic one, so fragmented clips play through WebCodecs
wherever classic ones do.

## WebM / MKV

mp4box only speaks ISOBMFF, so `src/matroska.js` reads Matroska itself.
Matroska stores every frame's presentation timestamp in plain sight (a
cluster's timestamp plus each block's signed 16-bit offset from it), but keeps
no central sample table — `Cues` indexes only keyframes — so building the
table requires a sequential pass over the whole file, skipping every block's
payload. The pass yields to the event loop as it goes.

A block *header* is also where the frame's byte range and keyframe flag are,
so the scan records those too, and reads the track's `CodecID` and
`CodecPrivate` for a decoder configuration — making a Matroska index as rich
as an MP4's, so WebM/MKV plays through WebCodecs. For an `.mkv` on Safari or
iOS this is the difference between playing and not: WebKit demuxes no
Matroska at all. Matroska stores H.264/HEVC length-prefixed with the parameter
sets in `CodecPrivate`, so there is no Annex B conversion on this path
(contrast AVI below).

Five codecs get a configuration — H.264, HEVC, VP8, VP9 and AV1 — and the hard
part is the codec *string*, which must state the profile, level and bit depth
exactly. Each codec keeps them somewhere different (the `avcC`/`hvcC`/`av1C`
in `CodecPrivate`; for VP9, its own first keyframe's uncompressed header, plus
a level computed from the picture size and frame rate), so every field is read
rather than assumed — an over-claimed profile is the same dishonest yes this
library exists to avoid. Any other `CodecID` (MPEG-4 ASP, a VFW-wrapped
oddity) yields no configuration and keeps the frame-exact `<video>` tier that
Matroska always has.

## Ogg

Ogg (Theora video) is indexed by `src/ogg.js`, the same shape as the Matroska
scan: a sequential full-file pass reading page headers and counting frame
packets, no decoding, budget and progress and cache included. Unlike the
Matroska scan it stops at the timestamps: an Ogg index carries no sample
table, so Ogg plays only through the `<video>` element, in browsers that still
ship a Theora decoder. Nothing is lost by that, since no browser's WebCodecs
decodes Theora either.

## AVI

AVI (`RIFF`/`AVI `) is indexed by `src/avi.js`, and is the one container that
is **WebCodecs-only, with no native fallback**: Chromium and Firefox refuse
AVI through a `<video>` element outright, and WebKit's occasional support is
not something to rely on. So an AVI whose codec WebCodecs cannot decode is
refused — there is nothing to fall back to.

Indexing an AVI does **not** read the whole file: its index (the legacy `idx1`
table, or the OpenDML `indx`/`ix##` hierarchical index that files over ~2 GB
use) enumerates every frame's byte range without touching payloads, so the
parser reads only the header, the index, and the first keyframe (for the
H.264 SPS). It still honors the same deadline, byte ceiling, progress
reporting, and cache treatment as the full-file scans, and refuses rather
than hangs on a malformed file.

Codecs: H.264 and Motion JPEG; uncompressed (`rawvideo`/BI_RGB) is
intentionally out of scope and refused cleanly. AVI stores H.264 as an Annex B
bitstream, but the engine does not feed WebCodecs that directly: WebKit's
decoder answers `isConfigSupported()` = true for an Annex-B (no-`description`)
config and then fails the actual decode. So the engine configures the decoder
in length-prefixed **AVCC** mode instead (an `avcC` description built from the
first keyframe's SPS/PPS) and converts each frame from Annex B to AVCC before
decoding — the form every browser engine decodes.

## Motion JPEG

A Motion JPEG clip is a run of complete JPEG images, one per frame — what
webcams, machine-vision and microscope cameras, and older camcorders write.
No browser ships an MJPEG `VideoDecoder`, and none is needed: every browser
has a JPEG decoder, the container index already gives each frame an exact
byte range and presentation time, and `createImageBitmap` turns one frame's
bytes into something a `VideoFrame` can be built from. So
`src/image-frame-decoder.js` is a `VideoDecoder` in shape — same constructor,
same `configure`/`decode`/`flush`/`reset`/`close`, same `decodeQueueSize` and
`output` callback — and the engine's decode driver uses it without knowing
the difference.

Because every frame is independent: `bitmapForFrame()` on frame 40000 costs
one frame's work (no keyframe to walk forward from), and nothing reorders, so
`playWhileIndexing` certifies a frame as soon as it is read.

Covered in both containers that carry MJPEG: the `MJPG` FourCC in AVI, and
the `jpeg` sample entry in QuickTime/MP4. QuickTime's Motion JPEG A and B
(`mjpa`, `mjpb`) are deliberately **not** included: those wrap their fields in
extra framing rather than storing one plain JPEG per sample, so a JPEG
decoder handed one would fail or decode half a picture.
`engine.codecString` reports `mjpeg` for these clips — this library's own
marker (WebCodecs registers none), meaning exactly "each frame is a whole
JPEG image".

## The index cache

A full-file indexing pass (Matroska, fragmented MP4, Ogg) is paid once per
clip per machine: an index that took longer than ~500 ms to build is kept in
IndexedDB (`src/index-cache.js`) and reused when the *same* clip is opened
again. Identity is proven, never assumed — a stale cached index would be a
wrong index — so an entry is reused only when the source's identity fully
matches:

- a local `File`: its `(name, size, lastModified)` triple;
- a URL: the address, the byte size, and the server's content validator (a
  strong `ETag`, else `Last-Modified`). No validator — including one hidden by
  CORS (`Access-Control-Expose-Headers`) — means the clip is simply rebuilt
  and never cached. Weak ETags (`W/…`) are ignored for the same reason: they
  promise semantic equivalence, and a byte-offset table needs byte identity.

Anything doubtful is a miss and a rebuild; a cache failure of any kind
(IndexedDB disabled, private browsing, quota) degrades to rebuilding, never
to guessing. A hit is instant and marks the returned index `fromCache =
true`. Cheap indexes (a classic MP4's few range reads) are never stored, and
nothing is cached in the `truncated` state — a network hiccup should not
become a permanently short table for that clip.
