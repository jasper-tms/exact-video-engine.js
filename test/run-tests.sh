#!/usr/bin/env bash
#
# Generate test clips if needed, serve the repo root, and run every test.
# Requires ffmpeg, node, and Playwright (npm install playwright).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f test/clips/rot270.mp4 ] || [ ! -f test/clips/counter-vfr.mp4 ] \
        || [ ! -f test/clips/counter-vfr.webm ] || [ ! -f test/clips/startup.mp4 ] \
        || [ ! -f test/clips/midsize.mp4 ] || [ ! -f test/clips/hd.mp4 ]; then
    bash test/make-test-clips.sh
fi

# test/serve.py, not `python3 -m http.server`: the latter ignores Range headers
# and answers 200 with the whole file, which the engine reads over Range. That is
# survivable for a few-KB clip and nonsense for anything larger (see serve.py).
python3 test/serve.py 8798 >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
sleep 1

status=0
node test/rotation-test.mjs || status=1
node test/frame-index-test.mjs || status=1
node test/display-test.mjs || status=1
node test/offscreen-test.mjs || status=1
node test/startup-test.mjs || status=1
node test/memory-test.mjs || status=1
exit "$status"
