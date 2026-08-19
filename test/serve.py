#!/usr/bin/env python3
"""
Static file server for the test suite that actually honours HTTP Range with 206.

`python3 -m http.server` does not: it ignores the Range header and returns the
whole file with a 200. Every clip the engine plays in the browser is read over
Range, so a server that fakes it is not serving what production serves.

It got away with it because the other fixtures are a few KB: the whole file IS
the range, near enough, and the engine's byte-buffer check then finds every
subsequent read already in hand. The moment a fixture has a real mdat
(clips/startup.mp4), a 200 hands back the entire file with the wrong offsets and
the demuxer chokes -- and any measurement of "how many bytes does the engine
need before the first frame" is meaningless regardless, since every read reports
the whole file.

Cloud Storage and Firebase Storage both answer 206. So does this.

It can also serve a clip SLOWLY, per request: a delay before the response (the
round trip to a distant bucket) and a cap on the rate the body is written at
(the link), both from query parameters, so one running server answers every
condition the stall test asks for. Use these rather than the DevTools
protocol's throttling whenever the browser is not Chromium.

    clips/hd-long.mp4?latencyMilliseconds=150&bytesPerSecond=2000000
"""
import http.server
import os
import re
import socketserver
import sys
import time
from urllib.parse import parse_qs, urlparse

# Body-pacing granularity. Small enough that a rate cap shapes the transfer
# rather than delivering it in visible lumps, large enough not to make a
# multi-megabyte read a syscall storm.
PACING_CHUNK_BYTES = 64 << 10



class RangeRequestHandler(http.server.SimpleHTTPRequestHandler):
    def _throttle_settings(self):
        """This request's (latency, rate) from its query parameters; both zero
        (off) unless given. A value that will not parse is ignored."""
        latency = 0.0
        bytes_per_second = 0.0
        query = parse_qs(urlparse(self.path).query)
        for name, value in (('latencyMilliseconds', 'latency'),
                            ('bytesPerSecond', 'rate')):
            if name not in query:
                continue
            try:
                parsed = float(query[name][0])
            except ValueError:
                continue
            if parsed < 0:
                continue
            if value == 'latency':
                latency = parsed
            else:
                bytes_per_second = parsed
        return latency, bytes_per_second

    def _write_paced(self, body, bytes_per_second):
        """Write the body at no more than `bytes_per_second`. Each chunk waits
        until its own deadline against a clock started once, so the rate holds
        across the whole transfer rather than drifting with each write's cost."""
        if not bytes_per_second:
            self.wfile.write(body)
            return
        started_at = time.monotonic()
        written = 0
        while written < len(body):
            chunk = body[written:written + PACING_CHUNK_BYTES]
            self.wfile.write(chunk)
            written += len(chunk)
            behind = written / bytes_per_second - (time.monotonic() - started_at)
            if behind > 0:
                time.sleep(behind)

    def send_head(self):
        latency_milliseconds, bytes_per_second = self._throttle_settings()
        # Charged before anything is sent, which is where a real round trip
        # falls: the engine's decode driver is blocked on this response for the
        # whole of it.
        if latency_milliseconds:
            time.sleep(latency_milliseconds / 1000.0)

        range_header = self.headers.get('Range')
        if range_header is None:
            # The base class writes the body itself, so the rate cap does not
            # reach this path. It serves the test pages and the engine build,
            # not the clips being measured.
            return super().send_head()

        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404)
            return None

        file_size = os.path.getsize(path)
        match = re.match(r'bytes=(\d+)-(\d*)$', range_header.strip())
        if not match:
            self.send_error(400, 'malformed Range')
            return None

        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else file_size - 1
        end = min(end, file_size - 1)
        if start > end or start >= file_size:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{file_size}')
            self.end_headers()
            return None

        with open(path, 'rb') as handle:
            handle.seek(start)
            body = handle.read(end - start + 1)

        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Accept-Ranges', 'bytes')
        # Content validators, like production object stores send on 206s (Cloud
        # Storage and Firebase Storage both do). The engine's index cache keys
        # URL sources on these; without them a URL clip is simply never cached,
        # which would leave the cache's URL path untestable against this server.
        modified_time = int(os.path.getmtime(path))
        self.send_header('Last-Modified', self.date_time_string(modified_time))
        self.send_header('ETag', f'"{file_size:x}-{modified_time:x}"')
        # Or a second run reads the clip from the browser's cache and measures
        # nothing.
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self._write_paced(body, bytes_per_second)
        except (BrokenPipeError, ConnectionResetError):
            pass    # the page navigated away mid-read; nothing to report
        return None

    def log_message(self, *args):
        pass    # the suite's output is the test results, not an access log


class ThreadingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8798
    with ThreadingServer(('127.0.0.1', port), RangeRequestHandler) as httpd:
        httpd.serve_forever()
