#!/usr/bin/env bash
#
# Generate the test clips into test/clips/. Requires ffmpeg.
#
# Rotation clips: a landscape clip with an asymmetric marker (red top-left
# quadrant on blue), then remuxes of it with 90/180/270-degree display-rotation
# metadata.
#
# Frame-index clips: 30 frames, each saying which frame it is in two ways at once
# (see make-counter-frames.py, which draws them).
#
#   * The BOTTOM half carries a white bar, 5 pixels wide, at x = 5n. This is what
#     the test suite reads, and it reads nothing else. Position survives the
#     browser's YUV-to-RGB conversion exactly, which a brightness code would not,
#     and the frame is 150 pixels wide so the 30 bars tile it exactly, one slot
#     each: frame 0's bar sits flush against the left edge and frame 29's flush
#     against the right, with no column belonging to no frame. Keep the width at
#     5 * the frame count if either ever changes.
#   * The TOP half carries the frame number in large plain digits. Nothing in the
#     suite looks at it. It is for the human who opens one of these clips in a
#     player, or loads it into the demo page or an app being debugged, and wants
#     to see which frame is on screen without counting bar positions by eye.
#
# Two versions of the same 30 frames:
#   counter-cfr.mp4  constant 30 fps
#   counter-vfr.mp4  variable: 33 ms per frame, but every 5th frame is held for
#                    66 ms. An assumed constant frame rate mismaps this clip;
#                    the container's real timestamp table does not.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p clips

# The counter frames are drawn once, here, and every clip below is encoded from
# the same bytes, so two fixtures differing in container or codec differ in
# nothing else. Python rather than ffmpeg's drawtext filter: drawtext needs an
# ffmpeg built with libfreetype and plenty are not. A bar alone could be drawn
# with geq; digits cannot.
python3 make-counter-frames.py 150 90 30 clips/counter-frames-150x90.gray
python3 make-counter-frames.py 170 94 25 clips/counter-frames-170x94.gray

# Spelled as arrays so each ffmpeg invocation can splice in "the counter frames"
# as its input without repeating the six arguments that say how to read raw
# bytes. Headerless grayscale: no container, no timestamps, just frames.
COUNTER_FRAMES=(-f rawvideo -pix_fmt gray -video_size 150x90 -framerate 30
    -i clips/counter-frames-150x90.gray)
COUNTER_FRAMES_170x94=(-f rawvideo -pix_fmt gray -video_size 170x94 -framerate 25
    -i clips/counter-frames-170x94.gray)

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
#   * -sc_threshold 0 (no scene-change keyframes) so the group of pictures is
#     exactly what -g 10 says: keyframes at frames 0, 10 and 20 and nowhere else,
#     which the table tests assert and counter-elst.mp4's cut depends on. Without
#     it x264 reads the frame number's digits changing shape as a scene cut and
#     inserts a fourth keyframe.
# -qp 1 is still visually lossless at the scale that matters here: the bar edges
# stay a hard black/white step, so visibleFrame()'s "columns brighter than half"
# detection reads the same bar position on all three browsers' YUV-to-RGB paths.
ffmpeg -y -loglevel error "${COUNTER_FRAMES[@]}" \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -qp 1 -bf 0 -g 10 -sc_threshold 0 clips/counter-cfr.mp4

# settb pins the timebase to milliseconds so the setpts expression below is in
# whole ms and needs no rounding; without it the encoder re-times against the
# source's 1/15360 timebase and the intended gaps come out wrong.
ffmpeg -y -loglevel error -i clips/counter-cfr.mp4 \
    -vf "settb=1/1000,setpts='33*N + 33*floor(N/5)'" \
    -fps_mode passthrough -video_track_timescale 1000 \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -qp 1 -bf 0 -g 10 -sc_threshold 0 clips/counter-vfr.mp4

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

# A clip carrying a real leading empty edit — media_time -1, several seconds, not
# the ~10-20ms an AAC track's encoder priming delay writes into nearly every
# audio-bearing MP4 (counter-leading-gap-elst.mp4's own audio track below ends up
# with exactly that kind of tiny edit, for free, as a contrast case in the same
# file). Real-world source: an MP4 built by independently trimming and remuxing
# two HLS streams came out with the video track's real media starting ~3s after
# the audio's; ffmpeg recorded that honestly as an empty edit ahead of the real
# samples in the video track's elst, rather than as a media_time offset the way
# counter-elst.mp4 above has one. See "3." in what-should-we-work-on-next.md for
# why the engine currently reports this clip's frame 0 at time 0.00 and should
# report 3.00 instead.
#
# ffmpeg will not write an empty edit for a single lone track -- there is nothing
# to desynchronize it from, so it just starts wherever it starts. -itsoffset on
# the video input against a second (audio) track reproduces the real mechanism:
# the muxer sees a video track whose first sample is 3s later than the other
# track's and writes a real empty edit to hold the gap, exactly as the original
# incident did. -c:v copy keeps counter-cfr.mp4's frames byte-identical, so its
# bar-position identity still holds: this clip's frame 0 is source frame 0, bar
# at x = 0, just reported 3s into the composition timeline instead of at 0.
ffmpeg -y -loglevel error \
    -itsoffset 3 -i clips/counter-cfr.mp4 \
    -f lavfi -i "anullsrc=r=44100:cl=mono:d=4" \
    -c:v copy -c:a aac -map 0:v -map 1:a \
    clips/counter-leading-gap-elst.mp4

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
#
# The encoder list is captured to a variable before being searched, rather than
# piped straight into `grep -q`. Under this script's `set -o pipefail`, that pipe
# is a race: `grep -q` exits the instant it matches, ffmpeg takes SIGPIPE writing
# what is left, and pipefail reports the whole pipeline as failed even though the
# encoder was found. Whether it loses depends on how much ffmpeg still had to
# write — so a build with MORE encoders compiled in is likelier to be wrongly
# reported as having none, which is exactly the wrong way round.
has_encoder() {   # has_encoder <ffmpeg> <encoder name>
    local listing
    listing="$("$1" -hide_banner -encoders 2>/dev/null || true)"
    case "$listing" in *"$2"*) return 0 ;; *) return 1 ;; esac
}

if has_encoder ffmpeg libtheora; then
    FFMPEG_THEORA=ffmpeg
else
    FFMPEG_THEORA="$(uvx --from imageio-ffmpeg python -c \
        'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())' \
        2>/dev/null | tail -1)" || FFMPEG_THEORA=""
fi
if [ -n "$FFMPEG_THEORA" ] && has_encoder "$FFMPEG_THEORA" libtheora; then
    "$FFMPEG_THEORA" -y -loglevel error "${COUNTER_FRAMES[@]}" \
        -pix_fmt yuv420p -c:v libtheora -q:v 10 clips/counter-cfr.ogv
    "$FFMPEG_THEORA" -y -loglevel error \
        -f lavfi -i "sine=frequency=440:duration=1" \
        "${COUNTER_FRAMES[@]}" \
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
ffmpeg -y -loglevel error "${COUNTER_FRAMES[@]}" \
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

# ==================================================================
# AVI container fixtures (added for the AVI-indexing work). AVI has no native
# <video> tier, so an AVI whose codec WebCodecs can decode plays ONLY through the
# WebCodecs engine, and one whose codec it cannot must be refused cleanly. These
# clips exercise both index flavors (legacy idx1 and OpenDML) and both outcomes.
# Self-contained block so it stays cleanly separable.
# ==================================================================

# 1. Classic idx1 AVI, H.264, constant 30 fps — the counter clip (frame n's bar
# at x = 5n, 150x90) muxed to AVI. ffmpeg writes H.264 into AVI as an Annex B
# bitstream with SPS/PPS in-band on each keyframe and a legacy idx1 at the end,
# which is the WebCodecs-decodable happy path. Same coding choices as
# counter-cfr.mp4 (High 8-bit 4:2:0, no B-frames) so every browser's WebCodecs
# decodes it and the bar edges stay a hard step for the pixel readback.
ffmpeg -y -loglevel error "${COUNTER_FRAMES[@]}" \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -qp 1 -bf 0 -g 10 -sc_threshold 0 -f avi clips/counter-idx1.avi

# 2. OpenDML (indx super-index + ix00) AVI, H.264 — the same 30 frames, but with
# the hierarchical index the real >2 GB capture files use. ffmpeg only emits an
# OpenDML index for very large files, so make-opendml-avi.py rewrites the idx1
# clip above into an OpenDML one (frame bytes copied verbatim, index structure
# replaced, no idx1). See that script for the exact byte layout it produces.
python3 make-opendml-avi.py clips/counter-idx1.avi clips/counter-opendml.avi

# 3. A second frame rate AND non-multiple-of-16 dimensions, to catch rate/scale
# and stride assumptions: 25 fps, 170x94, H.264 idx1. Parser-only (the browser
# pixel walk uses the 150x90 counter above), so the odd geometry is free to be
# awkward. 25 frames at 1/25 s spacing is what the table test pins.
ffmpeg -y -loglevel error "${COUNTER_FRAMES_170x94[@]}" \
    -pix_fmt yuv420p -c:v libx264 -profile:v high -qp 1 -bf 0 -g 10 -sc_threshold 0 -f avi clips/counter-avi-25fps.avi

# 4. Uncompressed rawvideo AVI (biCompression 0 / BI_RGB, the pal8 shape that
# motivated the task) — the honest-no case. WebCodecs has no raw-frame decoder and
# a raw backend is a separate future task, so the engine must refuse this cleanly
# (a clear error, no crash, bounded time), NOT play it. Small and short; its pixels
# do not matter, only that its codec is undecodable.
ffmpeg -y -loglevel error -f lavfi \
    -i "color=c=black:s=48x32:d=0.3:r=10,format=pal8" \
    -c:v rawvideo -f avi clips/counter-rawvideo.avi

# 5. MJPEG AVI — the shape a webcam, a machine-vision camera or an older
# camcorder writes. No browser has an MJPEG VideoDecoder, but every browser has a
# JPEG decoder and each of these frames is one whole JPEG image
# (src/image-frame-decoder.js), so this plays and its pixels are walked. Hence a
# full 150x90 counter clip, like the H.264 AVIs above.
#
# -q:v 1 (best quality) so the bar's edges stay a hard black/white step through
# the JPEG's DCT, which is what visibleFrame()'s "columns brighter than half"
# reads. yuvj420p is the full-range flavour every JPEG decoder expects.
ffmpeg -y -loglevel error "${COUNTER_FRAMES[@]}" \
    -c:v mjpeg -q:v 1 -pix_fmt yuvj420p -f avi clips/counter-mjpeg.avi

# 6. The same MJPEG frames in a QuickTime/MP4 container, where the sample entry
# is `jpeg` rather than the AVI FourCC `MJPG`. Indexed by mp4box like any other
# ISOBMFF file and decoded down the same image-frame path, so this is what proves
# the path is the container's business and not AVI's.
ffmpeg -y -loglevel error "${COUNTER_FRAMES[@]}" \
    -c:v mjpeg -q:v 1 -pix_fmt yuvj420p clips/counter-mjpeg.mov

echo "Wrote AVI fixtures:"
ls clips/counter-idx1.avi clips/counter-opendml.avi clips/counter-avi-25fps.avi \
    clips/counter-rawvideo.avi clips/counter-mjpeg.avi clips/counter-mjpeg.mov

# ==================================================================
# MPEG-4 Part 2 (`mp4v`) — what OpenCV's VideoWriter writes by default, and so
# what a great deal of scientific footage is stored as.
#
# Like the `jpeg` sample entry above, `mp4v` is one mp4box registers no parser
# for, so the track arrives classified as metadata with no dimensions; the
# rescue in src/container-index.js reads the entry's own bytes and its `esds`
# instead. Unlike `jpeg`, there is no decoder to fall back on: only WebKit
# decodes MPEG-4 Part 2 (through the <video> element; no browser's WebCodecs
# does), so frame-index-test.mjs expects a walk there and a clean refusal on
# Chromium and Firefox.
#
# -vtag mp4v pins the four-character code: ffmpeg would otherwise write `FMP4`
# for this encoder, which is the AVI-style tag and not what OpenCV produces.
# -q:v 1, -bf 0 and -g 10 for the same reasons as the H.264 clips above — hard
# bar edges for visibleFrame(), no reordering, and a predictable group of
# pictures.
ffmpeg -y -loglevel error "${COUNTER_FRAMES[@]}" \
    -pix_fmt yuv420p -c:v mpeg4 -vtag mp4v -q:v 1 -bf 0 -g 10 clips/counter-mp4v.mp4

echo "Wrote MPEG-4 Part 2 fixture:"
ls clips/counter-mp4v.mp4

# ==================================================================
# Matroska codec fixtures (added when the Matroska scan gained a sample table,
# so WebM/MKV can reach the WebCodecs engine). One clip per codec the parser
# builds a decoder configuration for, because the hard part is not the sample
# table — it is deriving a codec STRING that is right: each codec keeps its
# profile, level and bit depth somewhere different (CodecPrivate for H.264, HEVC
# and AV1; the first keyframe's own header for VP9; nowhere at all for VP8).
# Self-contained block so it stays cleanly separable.
#
# The VP9 cases are the counter-*.webm clips generated further up, which this
# work turned from native-only into WebCodecs-decodable.
# ==================================================================

# 1. H.264 in Matroska — the case that was not merely inexact before but
# UNPLAYABLE on WebKit, which demuxes no Matroska at all: the engine indexed the
# clip perfectly and then had only a <video> element that refused it. Now it
# decodes through WebCodecs on every browser. The variable-rate counter clip
# (remuxed, frames copied) so exactness cannot come from an assumed frame rate,
# and so the sample byte ranges are proven by the pixels: a wrong offset decodes
# to garbage or nothing, not to the right bar.
ffmpeg -y -loglevel error -i clips/counter-vfr.mp4 -c copy clips/counter-vfr.mkv

# 2. VP8 in WebM — the codec with no setup record and no profile to derive, so
# its codec string is the plain 'vp8' WebCodecs registers. Also what a browser's
# own MediaRecorder writes, which makes it a common real-world upload.
ffmpeg -y -loglevel error -i clips/counter-cfr.mp4 \
    -pix_fmt yuv420p -c:v libvpx -b:v 0 -crf 4 -qmin 0 -qmax 20 -g 10 clips/counter-vp8.webm

# 3. AV1 in WebM — the codec string is read out of the av1C record (profile,
# level, tier, bit depth are fixed bit positions in its first three bytes) and the
# record doubles as the decoder description. Chromium and Firefox decode it
# through WebCodecs; WebKit decodes AV1 in neither WebCodecs nor <video>, so it
# refuses the clip, which frame-index-test.mjs asserts rather than skips.
ffmpeg -y -loglevel error -i clips/counter-cfr.mp4 \
    -pix_fmt yuv420p -c:v libsvtav1 -crf 5 -preset 8 -g 10 clips/counter-av1.webm

# 4. HEVC in Matroska — for the codec-string builder, which has the most to get
# right of any of them (profile space, the bit-REVERSED compatibility flags, tier,
# level, and the trailing constraint bytes: 'hvc1.1.6.L30.90'). Deliberately a
# parser-only fixture, not a browser case: Playwright's Chromium ships no HEVC
# decoder and its WebKit fails 8-bit HEVC identically in MP4 and MKV, so a browser
# case here would pin a property of the test browsers rather than of this engine.
# matroska-table-test.mjs is where it earns its keep.
ffmpeg -y -loglevel error -i clips/counter-cfr.mp4 \
    -pix_fmt yuv420p -c:v libx265 -x265-params log-level=none:scenecut=0 -crf 5 -g 10 \
    clips/counter-hevc.mkv

echo "Wrote Matroska codec fixtures:"
ls clips/counter-vfr.mkv clips/counter-vp8.webm clips/counter-av1.webm clips/counter-hevc.mkv
