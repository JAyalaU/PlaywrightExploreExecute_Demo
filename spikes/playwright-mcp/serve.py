"""Serve only the public deterministic fixture for the feasibility spike."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from functools import partial

ROOT = Path(__file__).parent / "fixture"

if __name__ == "__main__":
    handler = partial(SimpleHTTPRequestHandler, directory=str(ROOT))
    server = ThreadingHTTPServer(("127.0.0.1", 4173), handler)
    print("Serving deterministic spike fixture at http://127.0.0.1:4173")
    server.serve_forever()
