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

# -qp 0 (lossless) so the bar's edges stay exactly where they were drawn.
ffmpeg -y -loglevel error -f lavfi \
    -i "color=c=black:s=160x90:d=1:r=30,format=gray,geq=lum='if(between(X,5*N,5*N+4),255,0)'" \
    -pix_fmt yuv420p -c:v libx264 -qp 0 -g 10 clips/counter-cfr.mp4

# settb pins the timebase to milliseconds so the setpts expression below is in
# whole ms and needs no rounding; without it the encoder re-times against the
# source's 1/15360 timebase and the intended gaps come out wrong.
ffmpeg -y -loglevel error -i clips/counter-cfr.mp4 \
    -vf "settb=1/1000,setpts='33*N + 33*floor(N/5)'" \
    -fps_mode passthrough -video_track_timescale 1000 \
    -pix_fmt yuv420p -c:v libx264 -qp 0 -g 10 clips/counter-vfr.mp4

# A clip carrying an edit list, so the element's timeline does NOT start at zero
# (its first frame reports mediaTime 0.133, not 0). Output-side -ss with stream
# copy writes the elst; the cut snaps forward to the next keyframe, which with
# -g 10 is frame 10 — so this clip's first frame is the original frame 10 and
# its bar sits at x = 50. frame-index-test.mjs asserts exactly that, which is
# what proves the container-to-element timeline calibration is working rather
# than the offset merely happening to be zero.
ffmpeg -y -loglevel error -i clips/counter-cfr.mp4 -ss 0.2 \
    -c copy clips/counter-elst.mp4

echo "Wrote test clips:"
ls clips
