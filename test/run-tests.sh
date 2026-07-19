#!/usr/bin/env bash
#
# Generate test clips if needed, serve the repo root, and run every test.
# Requires ffmpeg, node, and Playwright (npm install playwright).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f test/clips/rot270.mp4 ] || [ ! -f test/clips/counter-vfr.mp4 ] \
        || [ ! -f test/clips/counter-vfr.webm ] || [ ! -f test/clips/startup.mp4 ] \
        || [ ! -f test/clips/midsize.mp4 ] || [ ! -f test/clips/hd.mp4 ] \
        || [ ! -f test/clips/counter-trimming-elst.mp4 ] \
        || [ ! -f test/clips/counter-hevc10.mp4 ] \
        || [ ! -f test/clips/corrupt-pure-garbage.bin ]; then
    bash test/make-test-clips.sh
fi

# Node-only unit tests: no browser, no server. These run in plain Node directly
# against the src/ modules, up front and cheaply. The Matroska parser (and its
# WebM indexing progress reports), the known-bad-codec routing decision, and the
# trimming-edit-list arithmetic are all pure enough to check without a browser.
node_status=0
node test/matroska-progress-test.mjs || node_status=1
node test/decode-support-test.mjs || node_status=1
node test/edit-list-test.mjs || node_status=1

# test/serve.py, not `python3 -m http.server`: the latter ignores Range headers
# and answers 200 with the whole file, which the engine reads over Range. That is
# survivable for a few-KB clip and nonsense for anything larger (see serve.py).
# TEST_PORT lets two checkouts run their suites at the same time (the test
# drivers read the same variable through test/harness.mjs).
TEST_PORT="${TEST_PORT:-8798}"
export TEST_PORT
python3 test/serve.py "$TEST_PORT" >/dev/null 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
sleep 1

status=0

# The correctness core runs under all three browser engines. WebKit here is the
# Safari/iOS engine, so a green run is the closest continuous-integration proxy
# for "works on a phone"; Firefox is the third independent decode+present stack.
# Each driver reads TEST_BROWSER through test/harness.mjs and carries its own
# explicit per-browser expectations (see frame-index-test.mjs), so a non-Chromium
# regression fails the run rather than passing quietly.
for browser in chromium webkit firefox; do
    echo "=== correctness core: $browser ==="
    TEST_BROWSER="$browser" node test/rotation-test.mjs || status=1
    TEST_BROWSER="$browser" node test/frame-index-test.mjs || status=1
    TEST_BROWSER="$browser" node test/display-test.mjs || status=1
    TEST_BROWSER="$browser" node test/offscreen-test.mjs || status=1
done

# Chromium-only. These lean on a Chrome DevTools Protocol session (startup's
# network throttling), Chromium's precise decoded-frame accounting (memory), or
# a Chromium-specific decoder error surface (decoder-failure), and the task they
# verify is engine bookkeeping that is not browser-specific — so running them
# under one engine is enough and porting them would only add contortions.
echo "=== chromium-only: startup, memory, decoder-failure, known-bad-codec ==="
node test/startup-test.mjs || status=1
node test/memory-test.mjs || status=1
node test/decoder-failure-test.mjs || status=1
# known-bad-codec spoofs navigator.vendor to exercise the WebKit routing path from
# Chromium (the decision is codec-string-based, so no real HEVC decode is needed).
node test/known-bad-codec-test.mjs || status=1

# Chromium-only too, but for a different reason: robustness-test pins that
# malformed and truncated inputs fail softly (bounded time, no page crash). That
# graceful-degradation contract is engine bookkeeping, not a decode-path
# difference, so one engine exercises it fully.
echo "=== chromium-only: robustness ==="
node test/robustness-test.mjs || status=1

# Fold in the Node-only unit tests that ran before the server came up.
[ "$node_status" -eq 0 ] || status=1
exit "$status"
