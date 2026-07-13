#!/usr/bin/env bash
#
# Generate test clips if needed, serve the repo root, and run the rotation
# test. Requires ffmpeg, node, and Playwright (npm install playwright).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f test/clips/rot270.mp4 ] || [ ! -f test/clips/counter-vfr.mp4 ]; then
    bash test/make-test-clips.sh
fi

python3 -m http.server 8798 --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
sleep 1

status=0
node test/rotation-test.mjs || status=1
node test/frame-index-test.mjs || status=1
exit "$status"
