#!/usr/bin/env python3
"""Rewrite an MP4's edit list into a TRIMMING one, in place, byte for byte.

Why this exists
---------------
The frame-index tests need a clip whose container sample table describes MORE
frames than the <video> element actually presents, with the trim point landing
in the middle of a group of pictures. That is the one shape the engine's
NativeVideoEngine._indexDescribesElement is built to refuse: the samples before
the trim point stay in the table (the decoder needs them to reconstruct the
first presented frame) but are never shown, so trusting the table would report
every frame number shifted.

You cannot make this clip with `ffmpeg -ss ... -c copy`: output-side seeking with
stream copy snaps the cut to a keyframe and DROPS the skipped samples from the
output entirely, producing a SHIFTING edit list (media_time offset, same frame
count) rather than a TRIMMING one (fewer presented frames, full sample table).
That is exactly what counter-elst.mp4 already is, and it is not what we need
here. Re-encoding with an explicit edit list is possible but fiddly, so instead
we take a plain constant-frame-rate clip and rewrite the bytes of the single
identity edit list ffmpeg already wrote into it.

What it writes
--------------
The base clip (counter-cfr.mp4) carries one identity edit list entry:
segment_duration = whole movie, media_time = 0. We overwrite that one entry,
keeping the box exactly the same size (same entry count, same version) so no
parent box length has to change:

  * media_time  -> the presentation time of frame `trim_front_frames`, so the
                   element starts presenting partway into the first group of
                   pictures. media_time is expressed in the MEDIA timescale.
  * segment_duration -> `presented_frames` frames' worth of time, so the element
                   presents fewer frames than the sample table holds.
                   segment_duration is expressed in the MOVIE timescale.

The result: the container sample table still spans all the source frames, but the
element only presents a shorter window starting mid-group-of-pictures. ffprobe on
the output reports the shortened presentation duration while the video stream's
own media duration stays full length, which is the mismatch the engine detects.
"""
import struct
import sys


def read_box_uint32(data, box_type, field_offset):
    """Read a big-endian uint32 at `field_offset` bytes past a four-character
    box type tag. Used for the handful of fixed-layout header fields we need."""
    tag_offset = data.find(box_type)
    if tag_offset < 0:
        raise SystemExit(f"box {box_type!r} not found in the input file")
    return struct.unpack(">I", data[tag_offset + field_offset:tag_offset + field_offset + 4])[0]


def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: make-trimming-edit-list.py <input.mp4> <output.mp4>")
    input_path, output_path = sys.argv[1], sys.argv[2]

    data = bytearray(open(input_path, "rb").read())

    # Movie timescale and total movie duration live in mvhd (version 0 layout:
    # 4 bytes version+flags, 4 creation, 4 modification, 4 timescale, 4 duration).
    movie_timescale = read_box_uint32(data, b"mvhd", 4 + 12)
    movie_duration = read_box_uint32(data, b"mvhd", 4 + 16)

    # Media timescale lives in mdhd, same version-0 field layout as mvhd.
    media_timescale = read_box_uint32(data, b"mdhd", 4 + 12)

    # stts tells us how many samples there are and how long each lasts (this base
    # clip is constant frame rate, so a single stts entry covers every frame).
    stts_offset = data.find(b"stts")
    stts_entry_count = struct.unpack(">I", data[stts_offset + 8:stts_offset + 12])[0]
    if stts_entry_count != 1:
        raise SystemExit("expected a single constant-rate stts entry in the base clip")
    total_frames = struct.unpack(">I", data[stts_offset + 12:stts_offset + 16])[0]
    media_units_per_frame = struct.unpack(">I", data[stts_offset + 16:stts_offset + 20])[0]

    # The trim: start `trim_front_frames` into the clip so the
    # first presented frame sits in the middle of the opening group of pictures,
    # and present `presented_frames` frames in total (fewer than total_frames, so
    # the sample table genuinely outspans the presentation).
    trim_front_frames = 5
    presented_frames = 20
    if presented_frames + trim_front_frames > total_frames:
        raise SystemExit("trim parameters exceed the clip length")

    # media_time is measured in the MEDIA timescale: the presentation time of the
    # first frame we want shown.
    media_time = trim_front_frames * media_units_per_frame
    # segment_duration is measured in the MOVIE timescale: how long the element
    # presents, in movie units. One frame is movie_duration / total_frames movie
    # units for this constant-rate clip.
    movie_units_per_frame = movie_duration // total_frames
    segment_duration = presented_frames * movie_units_per_frame

    # Find the single identity edit list entry ffmpeg wrote and overwrite it in
    # place. elst layout: 4-char tag, 4 bytes version+flags, 4 bytes entry_count,
    # then per entry (version 0): 4 bytes segment_duration, 4 bytes media_time,
    # 4 bytes rate. We keep the entry count and box size unchanged.
    elst_offset = data.find(b"elst")
    if elst_offset < 0:
        raise SystemExit("no elst box found; this base clip has no edit list to rewrite")
    version = data[elst_offset + 4]
    entry_count = struct.unpack(">I", data[elst_offset + 8:elst_offset + 12])[0]
    if version != 0 or entry_count != 1:
        raise SystemExit(
            f"expected one version-0 edit list entry, found version {version} "
            f"with {entry_count} entries")

    entry_offset = elst_offset + 12
    struct.pack_into(">I", data, entry_offset + 0, segment_duration)
    struct.pack_into(">i", data, entry_offset + 4, media_time)
    # Leave the playback rate field (entry_offset + 8) untouched at 1.0.

    open(output_path, "wb").write(data)
    presented_seconds = segment_duration / movie_timescale
    media_seconds = movie_duration / movie_timescale
    print(
        f"wrote {output_path}: sample table spans {media_seconds:.3f}s "
        f"({total_frames} frames), edit list presents {presented_seconds:.3f}s "
        f"({presented_frames} frames) starting at source frame {trim_front_frames} "
        f"(media_time {media_time} in a {media_timescale} timescale)")


if __name__ == "__main__":
    main()
