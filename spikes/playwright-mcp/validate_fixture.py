"""Structural validation for the isolated local feasibility-spike fixture.

This check never calls Playwright MCP or the scoring oracle. It verifies only
the public HTTP fixture shape and confirms the private answer key remains
outside the served root.
"""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError
from urllib.request import urlopen

ROOT = Path(__file__).parent
FIXTURE = ROOT / "fixture"
ANSWER_KEY = ROOT / "oracle" / "answer-key.json"


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:
        pass


def get(url: str) -> tuple[int, bytes]:
    try:
        with urlopen(url) as response:  # nosec B310: loopback test server only
            return response.status, response.read()
    except HTTPError as error:
        return error.code, error.read()


def main() -> None:
    handler = partial(QuietHandler, directory=str(FIXTURE))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    try:
        pages: dict[int, bytes] = {}
        for scenario in range(1, 13):
            status, content = get(f"{base}/scenario/{scenario}/")
            assert status == 200, f"scenario {scenario} returned {status}"
            assert f'data-scenario="{scenario}"'.encode() in content, f"scenario {scenario} is not isolated"
            pages[scenario] = content

        assert pages[1].count(b">Save<") == 1, "scenario 1 must expose one Save control"
        assert pages[5].count(b">Save<") == 2, "scenario 5 must retain background/dialog Save ambiguity"
        assert pages[9].count(b">Edit<") == 2 and b"Billing row" in pages[9], "scenario 9 must retain Billing-row Edit ambiguity"
        assert get(f"{base}/scenario/1/")[1] == pages[1], "fresh scenario navigation must reset deterministically"
        assert get(f"{base}/oracle/answer-key.json")[0] == 404, "private answer key must not be served"

        key = json.loads(ANSWER_KEY.read_text(encoding="utf-8"))["scenarios"]
        for scenario, expected in key.items():
            route = expected["route"]
            status, content = get(f"{base}{route}")
            assert status == 200 and f'data-scenario="{scenario}"'.encode() in content, f"oracle route mismatch for scenario {scenario}"
    finally:
        server.shutdown()
        server.server_close()

    print("Fixture structural validation passed: 12 isolated routes, required ambiguities, reset, and private oracle boundary.")


if __name__ == "__main__":
    main()
