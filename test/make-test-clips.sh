#!/usr/bin/env bash
#
# Generate the rotation-test clips into test/clips/: a landscape clip with an
# asymmetric marker (red top-left quadrant on blue), then remuxes of it with
# 90/180/270-degree display-rotation metadata. Requires ffmpeg.
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

echo "Wrote test clips:"
ls clips
