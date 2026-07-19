#!/usr/bin/env bash
#
# Generate the test clips into test/clips/. Requires ffmpeg.
#
# Rotation clips: a landscape clip with an asymmetric marker (red top-left
# quadrant on blue), then remuxes of it with 90/180/270-degree display-rotation
# metadata.
#
# Frame-index clips: 30 frames, each identifying itself by the POSITION of a
# white bar (frame n puts a 5-pixel bar at x = 5n, on black). The index is read
# back from the bar's position rather than a pixel value, so it survives the
# browser's YUV-to-RGB conversion exactly, which a brightness code would not.
# The frame is 150 pixels wide so that the 30 frames tile it exactly, one bar
# slot each: frame 0's bar sits flush against the left edge and frame 29's flush
# against the right, and no column of the image belongs to no frame. Keep the
# width at 5 * the frame count if either ever changes.
# Two versions of the same 30 frames:
#   counter-cfr.mp4  constant 30 fps
#   counter-vfr.mp4  variable: 33 ms per frame, but every 5th frame is held for
#                    66 ms. An assumed constant frame rate mismaps this clip;
#                    the container's real timestamp table does not.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p clips

ffmpeg -y -loglevel error -f lavfi \
    -i "color=c=blue:s=320x180:d=2:r=30,drawbox=x=0:y=0:w=160:h=90:color=red:t=fill" \
    -pix_fmt yuv420p -c:v libx264 -g 10 clips/plain.mp4

for degrees in 90 180 270; do
    ffmpeg -y -loglevel error -display_rotation "$degrees" -i clips/plain.mp4 \
        -c copy "clips/rot${degrees}.mp4"
done

# Near-lossless (-qp 1) rather than lossless (-qp 0), and 8-bit 4:2:0 High
# profile with no B-frames, because this fixture is decoded three ways in the
# test suite and two of them are fussy about how it is coded:
#   * -qp 0 makes libx264 emit the High 4:4:4 Predictive profile (avc1.f4xxxx).
#     WebKit's WebCodecs honestly rejects that profile at load, so the whole
#     WebCodecs path went untested on WebKit/iOS -- exactly the engine the test
#     matrix was widened to cover. -qp 1 with an explicit yuv420p keeps the High
#     (8-bit 4:2:0) profile every browser's WebCodecs decodes.
#   * -bf 0 (no B-frames) because B-frames reorder decode-versus-display and add
#     composition-time offsets, and the <video> element's frame-accurate seek
#     lands a frame off around them on the variable-frame-rate clip -- which
#     would make the native-index cases in frame-index-test.mjs mismap on every
#     browser. The original lossless clips had no B-frames as a side effect of
#     -qp 0; -bf 0 keeps that property explicit now that the encode is lossy.
# -qp 1 is still visually lossless at the scale that matters here: the bar edges
# stay a hard black/white step, so visibleFrame()'s "columns brighter than half"
# detection reads the same bar position on all three browsers' YUV-to-RGB paths.
ffmpeg -y -loglevel error -f lavfi \
    -i "color=c=black:s=150x90:d=1:r=30,format=gray,geq=lum='if(between(X,5*N,5*N+4),255,0)'" \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -qp 1 -bf 0 -g 10 clips/counter-cfr.mp4

# settb pins the timebase to milliseconds so the setpts expression below is in
# whole ms and needs no rounding; without it the encoder re-times against the
# source's 1/15360 timebase and the intended gaps come out wrong.
ffmpeg -y -loglevel error -i clips/counter-cfr.mp4 \
    -vf "settb=1/1000,setpts='33*N + 33*floor(N/5)'" \
    -fps_mode passthrough -video_track_timescale 1000 \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -qp 1 -bf 0 -g 10 clips/counter-vfr.mp4

# The same 30 frames again, in WebM. mp4box cannot parse this container at all,
# so these clips are what prove the engine's own Matroska cluster scan: without
# it counter-vfr.webm can only be mapped by an assumed constant frame rate, which
# is wrong for it. VP9 lossless, so the bars stay exactly where they were drawn.
ffmpeg -y -loglevel error -i clips/counter-cfr.mp4 \
    -pix_fmt yuv420p -c:v libvpx-vp9 -lossless 1 -g 10 clips/counter-cfr.webm

ffmpeg -y -loglevel error -i clips/counter-cfr.mp4 \
    -vf "settb=1/1000,setpts='33*N + 33*floor(N/5)'" \
    -fps_mode passthrough \
    -pix_fmt yuv420p -c:v libvpx-vp9 -lossless 1 -g 10 clips/counter-vfr.webm

# A clip carrying an edit list, so the element's timeline does NOT start at zero
# (its first frame reports mediaTime 0.133, not 0). Output-side -ss with stream
# copy writes the elst; the cut snaps forward to the next keyframe, which with
# -g 10 is frame 10 — so this clip's first frame is the original frame 10 and
# its bar sits at x = 50. frame-index-test.mjs asserts exactly that, which is
# what proves the container-to-element timeline calibration is working rather
# than the offset merely happening to be zero.
ffmpeg -y -loglevel error -i clips/counter-cfr.mp4 -ss 0.2 \
    -c copy clips/counter-elst.mp4

# A clip with a real mdat, for the startup-cost test: how many bytes must arrive
# before the engine can show a frame? That question is meaningless against the
# clips above -- they are a few KB, so any block size fetches the whole file and
# a fat blocking read looks free. Random noise defeats the encoder (nothing to
# predict), so 10 s of 720p lands in the tens of MB; -g 30 gives a keyframe per
# second, so decoding a frame costs at most one second of video, not the file.
ffmpeg -y -loglevel error -f lavfi \
    -i "nullsrc=s=640x360:d=8:r=30,geq=random(1)*255:128:128" \
    -pix_fmt yuv420p -c:v libx264 -preset ultrafast -qp 26 -g 30 \
    -movflags +faststart clips/startup.mp4

# A few MB, and its moov at the END (no +faststart) -- the shape of a real phone
# clip, and the one the byte budgets above are blind to. Opening it is a chain of
# dependent reads, and on a bucket 400 ms away the round trips ARE the load time
# however few bytes they carry: a 2.6 MB clip took eight of them, and four
# seconds, while every byte budget passed. Small enough that the engine should
# stop chasing ranges and just take the file.
ffmpeg -y -loglevel error -f lavfi \
    -i "nullsrc=s=320x180:d=5:r=30,geq=random(1)*255:128:128" \
    -pix_fmt yuv420p -c:v libx264 -preset ultrafast -qp 34 -g 30 \
    clips/midsize.mp4

# 1080p, for the cache-memory test: a decoded frame is width x height x 4 bytes,
# so how much memory the frame cache holds is decided by the clip, not by the
# frame count. Every other clip here has small frames, which is precisely why a
# cache budgeted in frames looked harmless for so long -- at 320x180 a 82-frame
# window is 19 MB, and at 1080p the same window is 680 MB and takes the decoder
# down with it on a phone. A smooth synthetic pattern (not noise) so 5 seconds of
# 1080p stays a few MB on disk; the pixels are irrelevant here, the SIZE is not.
ffmpeg -y -loglevel error -f lavfi -i "testsrc2=s=1920x1080:d=5:r=30" \
    -pix_fmt yuv420p -c:v libx264 -preset ultrafast -qp 30 -g 30 \
    -movflags +faststart clips/hd.mp4

echo "Wrote test clips:"
ls clips

# ==================================================================
# Regression fixtures appended by the test-fixtures work: they pin the engine's
# CURRENT graceful-degradation behavior on input classes that upcoming feature
# work (fragmented-MP4 indexing, edit-list handling in the WebCodecs path, a
# WebM sample table for WebCodecs) will deliberately touch. Everything below is a
# self-contained block so it stays cleanly separable from the clips above.
# ==================================================================

# A fragmented remux of the constant-frame-rate counter clip: empty_moov moves
# every sample out of the moov and into moof fragments, the shape a live/DASH
# packager writes. The engine detects fragmentation and feeds the whole file
# through mp4box so every moof's sample table is parsed (see
# container-index.js), which makes this clip index as fully as the unfragmented
# original — a guarantee, not a happens-to-fit-in-one-parse accident.
ffmpeg -y -loglevel error -i clips/counter-cfr.mp4 \
    -c copy -movflags frag_keyframe+empty_moov clips/counter-fragmented.mp4

# The variable-frame-rate twin, fragmented: the strongest fragmented-MP4 case.
# Constant-rate clips cannot tell a real moof-derived timestamp table from a
# lucky guess; this one can — its frames mismap under any assumed constant rate,
# so indexing it exactly proves the fragment pass reads the real per-frame
# timestamps out of the truns.
ffmpeg -y -loglevel error -i clips/counter-vfr.mp4 \
    -c copy -movflags frag_keyframe+empty_moov clips/counter-vfr-fragmented.mp4

# The same 30 counter frames in Ogg/Theora, for the engine's own Ogg page scan
# (src/ogg.js). Theora is constant-frame-duration by codec design, so there is no
# VFR twin; what these clips prove is that the packet counting and identification-
# header math produce the right table at all, and (audio variant) that pages of a
# multiplexed Vorbis stream are not counted as video frames. Theora at the top
# quality setting keeps the bar edges hard enough for visibleFrame()'s
# brighter-than-half detection.
#
# The Homebrew ffmpeg has no libtheora encoder, so resolve one: use the system
# ffmpeg if it can encode Theora, else the full static build that imageio-ffmpeg
# ships (fetched through uv, which caches it). If neither is available the Ogg
# fixtures are skipped with a warning, and the tests that need them skip too.
if ffmpeg -hide_banner -encoders 2>/dev/null | grep -q libtheora; then
    FFMPEG_THEORA=ffmpeg
else
    FFMPEG_THEORA="$(uvx --from imageio-ffmpeg python -c \
        'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())' \
        2>/dev/null | tail -1)" || FFMPEG_THEORA=""
fi
if [ -n "$FFMPEG_THEORA" ] \
        && "$FFMPEG_THEORA" -hide_banner -encoders 2>/dev/null | grep -q libtheora; then
    "$FFMPEG_THEORA" -y -loglevel error -f lavfi \
        -i "color=c=black:s=150x90:d=1:r=30,format=gray,geq=lum='if(between(X,5*N,5*N+4),255,0)'" \
        -pix_fmt yuv420p -c:v libtheora -q:v 10 clips/counter-cfr.ogv
    "$FFMPEG_THEORA" -y -loglevel error \
        -f lavfi -i "sine=frequency=440:duration=1" \
        -f lavfi -i "color=c=black:s=150x90:d=1:r=30,format=gray,geq=lum='if(between(X,5*N,5*N+4),255,0)'" \
        -map 0:a -map 1:v -shortest \
        -c:a libvorbis -pix_fmt yuv420p -c:v libtheora -q:v 10 \
        clips/counter-vorbis-audio.ogv
else
    echo "WARNING: no ffmpeg with libtheora found; skipping the Ogg fixtures" >&2
fi

# A WebM whose FIRST track entry is audio and whose SECOND is video: the audio
# stream is mapped before the video stream so the Matroska Tracks element lists
# audio first. The engine's cluster scan must skip the audio track entirely and
# index only the video frames; a scan that counted the first track's blocks would
# map audio packets as frames. frame-index-test.mjs proves the video frames still
# map exactly. (-shortest so the audio does not outrun the 30 video frames.)
ffmpeg -y -loglevel error \
    -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=48000" \
    -i clips/counter-cfr.mp4 \
    -map 0:a -map 1:v -shortest \
    -c:a libopus -c:v libvpx-vp9 -lossless 1 -g 10 clips/counter-audio-first.webm

# A clip carrying a TRIMMING edit list: the container sample table spans all 30
# frames but the element presents only a 20-frame window that begins in the
# middle of the first group of pictures. This is the case the shifting edit list
# in counter-elst.mp4 is NOT: there the element presents every remaining frame, so
# the durations still match. Here they must not (see make-trimming-edit-list.py
# for why an `ffmpeg -ss -c copy` cut cannot produce this shape). The engine
# HONORS this edit list: it numbers frames over just the 20 presented ones, so
# both engines play the trimmed window frame-exact (display frame 0 is source
# frame 5). frame-index-test.mjs proves the pixels; robustness-test.mjs pins the
# tier/frameIndexIsExact/numFrames signals.
python3 make-trimming-edit-list.py clips/counter-cfr.mp4 clips/counter-trimming-elst.mp4

# A 10-bit HEVC (Main 10) clip — the iPhone HDR default, and the format WebKit's
# WebCodecs accepts at load and then dies on mid-stream. known-bad-codec-test.mjs
# uses it to check that createBestEngine routes this codec straight to the native
# <video> element on WebKit (rather than crashing a second into playback). Only
# the container's declared codec string matters to that test — mp4box reads the
# hvcC without decoding — so the clip's content is unimportant; it reuses the
# counter pattern. -tag:v hvc1 so the sample entry is hvc1 (not hev1); either way
# the hvcC declares general_profile_idc 2 (Main 10), which is what is detected.
ffmpeg -y -loglevel error -f lavfi \
    -i "color=c=black:s=150x90:d=1:r=30,format=gray10le,geq=lum='if(between(X,5*N,5*N+4),1023,0)'" \
    -pix_fmt yuv420p10le -c:v libx265 -tag:v hvc1 -x265-params log-level=none \
    -g 10 clips/counter-hevc10.mp4

# Corrupt and truncated inputs, for robustness-test.mjs. Each pins that the engine
# fails SOFTLY on malformed bytes -- bounded time, no page crash, either a
# human-readable error or a graceful fallback -- rather than hanging or throwing
# uncaught. They are generated here from the clips above so they track any changes
# to those clips.
#
# A front-moov (faststart) MP4 is the raw material for the truncated-mdat case:
# faststart needs a seekable output so it is written to a real file, then truncated
# below. It is only an intermediate, so it is not one of the shipped fixtures.
ffmpeg -y -loglevel error -i clips/counter-cfr.mp4 -c copy \
    -movflags +faststart clips/counter-faststart.mp4
python3 - <<'PYTHON'
import os
# A WebM cut off partway through its cluster data: a real interrupted download or
# a partial upload. The header and Tracks survive; the frame data does not.
webm = open("clips/counter-cfr.webm", "rb").read()
open("clips/corrupt-webm-truncated-cluster.webm", "wb").write(webm[:int(len(webm) * 0.60)])

# The EBML magic number followed by pure noise: something that announces itself as
# Matroska but carries no valid element tree, so the scan starts and then finds
# nothing it can use.
open("clips/corrupt-ebml-magic-then-garbage.webm", "wb").write(
    bytes([0x1A, 0x45, 0xDF, 0xA3]) + os.urandom(2048))

# An MP4 whose moov is intact (front-loaded with +faststart) but whose mdat is
# truncated: the index parses perfectly and every frame's byte range points past
# the end of the file, so decoding must fail rather than read garbage. Keep the
# mdat box header plus a sliver of payload, drop the rest.
faststart = open("clips/counter-faststart.mp4", "rb").read()
mdat = faststart.find(b"mdat")
open("clips/corrupt-mp4-truncated-mdat.mp4", "wb").write(faststart[:mdat + 8 + 200])

# Pure noise with no recognizable container magic at all: not Matroska, no ftyp,
# nothing mp4box or the Matroska scan can latch onto.
garbage = bytearray(os.urandom(4096))
garbage[0:4] = b"\x00\x00\x00\x00"   # make sure it cannot look like a box length of note
open("clips/corrupt-pure-garbage.bin", "wb").write(bytes(garbage))
print("wrote corrupt/truncated fixtures")
PYTHON

echo "Wrote regression fixtures:"
ls clips/counter-fragmented.mp4 clips/counter-audio-first.webm \
    clips/counter-trimming-elst.mp4 clips/corrupt-*
