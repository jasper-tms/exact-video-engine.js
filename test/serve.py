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
"""
import http.server
import os
import re
import socketserver
import sys


class RangeRequestHandler(http.server.SimpleHTTPRequestHandler):
    def send_head(self):
        range_header = self.headers.get('Range')
        if range_header is None:
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
        self.end_headers()
        self.wfile.write(body)
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
