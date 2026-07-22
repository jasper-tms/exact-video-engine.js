#!/usr/bin/env python3
"""Rewrite a legacy-index (idx1) AVI into an OpenDML (indx/ix##) AVI.

    python3 make-opendml-avi.py in-idx1.avi out-opendml.avi

Why this exists: ffmpeg only emits an OpenDML hierarchical index for very large
files (over ~2 GB), but the real capture files exact-video-engine's AVI indexer
must handle ARE OpenDML — and a small OpenDML fixture is the only way to exercise
that code path in the test suite without a multi-gigabyte clip. So we synthesize
one: parse the source's legacy `idx1` to recover each video chunk's byte range and
keyframe flag, then re-emit an AVI carrying an `indx` super-index in the stream
header and a single `ix00` standard index inside the movi list, and NO `idx1` at
all. The frame bytes are copied verbatim, so the re-muxed clip decodes to exactly
the same pixels; only the index structure changes.

The output layout:

    RIFF 'AVI '
      LIST 'hdrl'
        'avih'                     (copied from the source)
        LIST 'strl'
          'strh'                   (copied)
          'strf'                   (copied)
          'indx'                   AVISUPERINDEX -> one ix00 entry
      LIST 'movi'
        '00dc' * N                 the frame chunks (copied)
        'ix00'                     AVISTDINDEX over those N chunks
      (no idx1)
"""
import struct
import sys


def fourcc(buf, offset):
    return buf[offset:offset + 4]


def u32(buf, offset):
    return struct.unpack_from('<I', buf, offset)[0]


def parse_source(src):
    """Return (avih, strh, strf, frames) where frames is a decode-order list of
    (data_offset, size, is_keyframe) recovered from the source's idx1."""
    assert fourcc(src, 0) == b'RIFF' and fourcc(src, 8) == b'AVI ', 'not an AVI'
    found = {'avih': None, 'strh': None, 'strf': None, 'movi_fourcc': None}
    frames = []

    def walk(start, end):
        offset = start
        while offset + 8 <= end:
            chunk_id = fourcc(src, offset)
            size = u32(src, offset + 4)
            if chunk_id in (b'LIST', b'RIFF'):
                list_type = fourcc(src, offset + 8)
                if list_type == b'movi':
                    found['movi_fourcc'] = offset + 8
                walk(offset + 12, offset + 12 + size - 4)
            else:
                if chunk_id == b'avih':
                    found['avih'] = src[offset + 8:offset + 8 + size]
                elif chunk_id == b'strh':
                    found['strh'] = src[offset + 8:offset + 8 + size]
                elif chunk_id == b'strf':
                    found['strf'] = src[offset + 8:offset + 8 + size]
                elif chunk_id == b'idx1':
                    for entry in range(size // 16):
                        base = offset + 8 + entry * 16
                        ckid = fourcc(src, base)
                        flags = u32(src, base + 4)
                        chunk_offset = u32(src, base + 8)
                        chunk_size = u32(src, base + 12)
                        if ckid[2:4] in (b'dc', b'db'):
                            # idx1 offsets here are relative to the 'movi' FourCC
                            # and point at the chunk header; data is 8 bytes past.
                            data_offset = found['movi_fourcc'] + chunk_offset + 8
                            frames.append((data_offset, chunk_size, bool(flags & 0x10)))
            offset += 8 + size + (size & 1)

    walk(0, len(src))
    for key in ('avih', 'strh', 'strf'):
        if found[key] is None:
            raise SystemExit(f'source AVI is missing its {key}')
    if not frames:
        raise SystemExit('source AVI has no idx1 video entries to convert')
    return found['avih'], found['strh'], found['strf'], frames


def build_opendml(src, avih, strh, strf, frames):
    out = bytearray()

    # --- super-index placeholder (patched once ix00's position is known) -------
    # AVISUPERINDEX: wLongsPerEntry(2)=4, bIndexSubType(1)=0,
    # bIndexType(1)=0 (AVI_INDEX_OF_INDEXES), nEntriesInUse(4)=1,
    # dwChunkId(4)='00dc', dwReserved[3](12), then one 16-byte entry.
    indx = bytearray()
    indx += struct.pack('<HBB', 4, 0, 0x00)
    indx += struct.pack('<I', 1)
    indx += b'00dc'
    indx += b'\x00' * 12
    super_entry_offset_in_indx = len(indx)
    indx += b'\x00' * 16   # { qwOffset(8), dwSize(4), dwDuration(4) }, patched later

    # --- strl: strh, strf, indx ----------------------------------------------
    strl = bytearray()

    def append_chunk(target, chunk_id, data):
        target.extend(chunk_id)
        target.extend(struct.pack('<I', len(data)))
        target.extend(data)
        if len(data) & 1:
            target.append(0)

    append_chunk(strl, b'strh', strh)
    append_chunk(strl, b'strf', strf)
    append_chunk(strl, b'indx', bytes(indx))

    # --- hdrl: avih + LIST strl ----------------------------------------------
    hdrl = bytearray()
    append_chunk(hdrl, b'avih', avih)
    hdrl.extend(b'LIST')
    hdrl.extend(struct.pack('<I', 4 + len(strl)))
    hdrl.extend(b'strl')
    hdrl.extend(strl)

    # --- RIFF/AVI, hdrl, then movi --------------------------------------------
    out.extend(b'RIFF')
    riff_size_offset = len(out)
    out.extend(b'\x00\x00\x00\x00')   # patched at the end
    out.extend(b'AVI ')

    out.extend(b'LIST')
    out.extend(struct.pack('<I', 4 + len(hdrl)))
    out.extend(b'hdrl')
    hdrl_start = len(out)
    out.extend(hdrl)

    out.extend(b'LIST')
    movi_size_offset = len(out)
    out.extend(b'\x00\x00\x00\x00')   # patched once movi's length is known
    movi_content_start = len(out)
    out.extend(b'movi')

    # Frame chunks, recording each frame's absolute DATA offset for the index.
    index_records = []   # (abs_data_offset, size, is_keyframe)
    for (data_offset, size, is_keyframe) in frames:
        data = src[data_offset:data_offset + size]
        out.extend(b'00dc')
        out.extend(struct.pack('<I', size))
        abs_data_offset = len(out)
        out.extend(data)
        if size & 1:
            out.append(0)
        index_records.append((abs_data_offset, size, is_keyframe))

    # ix00 standard index, inside the movi list.
    # AVISTDINDEX: wLongsPerEntry(2)=2, bIndexSubType(1)=0,
    # bIndexType(1)=1 (AVI_INDEX_OF_CHUNKS), nEntriesInUse(4), dwChunkId(4)='00dc',
    # qwBaseOffset(8), dwReserved(4), then N entries { dwOffset(4), dwSize(4) }.
    # dwOffset is relative to qwBaseOffset and points at the frame DATA; the high
    # bit of dwSize set means "not a keyframe".
    base_offset = index_records[0][0]
    ix = bytearray()
    ix += struct.pack('<HBB', 2, 0, 0x01)
    ix += struct.pack('<I', len(index_records))
    ix += b'00dc'
    ix += struct.pack('<Q', base_offset)
    ix += struct.pack('<I', 0)
    for (abs_data_offset, size, is_keyframe) in index_records:
        relative = abs_data_offset - base_offset
        size_field = size if is_keyframe else (size | 0x80000000)
        ix += struct.pack('<II', relative, size_field)

    out.extend(b'ix00')
    out.extend(struct.pack('<I', len(ix)))
    ix00_header_offset = len(out) - 8
    out.extend(ix)
    if len(ix) & 1:
        out.append(0)

    # Patch the movi LIST size (its content: 'movi' FourCC through ix00).
    struct.pack_into('<I', out, movi_size_offset, len(out) - movi_content_start)

    # Patch the super-index entry now that ix00's position and size are known.
    indx_data_offset = out.find(b'indx', hdrl_start, movi_size_offset) + 8
    entry = indx_data_offset + super_entry_offset_in_indx
    struct.pack_into('<Q', out, entry, ix00_header_offset)      # qwOffset -> ix00 header
    struct.pack_into('<I', out, entry + 8, len(ix))            # dwSize of ix00 body
    struct.pack_into('<I', out, entry + 12, len(index_records))  # dwDuration (frames)

    # Patch the RIFF size.
    struct.pack_into('<I', out, riff_size_offset, len(out) - 8)
    return bytes(out)


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    src = open(sys.argv[1], 'rb').read()
    avih, strh, strf, frames = parse_source(src)
    out = build_opendml(src, avih, strh, strf, frames)
    open(sys.argv[2], 'wb').write(out)
    print(f'wrote {sys.argv[2]}: {len(out)} bytes, {len(frames)} frames (OpenDML index)')


if __name__ == '__main__':
    main()
