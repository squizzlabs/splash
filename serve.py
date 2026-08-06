#!/usr/bin/env python3
"""No-cache local server for Just The Trip."""

from argparse import ArgumentParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


class NoCacheHandler(SimpleHTTPRequestHandler):
    def rewrite_callback(self):
        parsed = urlsplit(self.path)
        if parsed.path.rstrip("/") == "/callback":
            self.path = "/auth.html" + (("?" + parsed.query) if parsed.query else "")

    def do_GET(self):
        self.rewrite_callback()
        super().do_GET()

    def do_HEAD(self):
        self.rewrite_callback()
        super().do_HEAD()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()


def main():
    parser = ArgumentParser(description="Serve Just The Trip locally")
    parser.add_argument("--port", type=int, default=59832)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    handler = lambda *items, **kwargs: NoCacheHandler(*items, directory=str(root), **kwargs)  # noqa: E731
    server = ThreadingHTTPServer(("localhost", args.port), handler)
    print(f"Just The Trip: http://localhost:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
