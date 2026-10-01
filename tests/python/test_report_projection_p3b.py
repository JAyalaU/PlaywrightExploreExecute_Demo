"""Closed consumer checks for the P3-B read-only Node projection."""

import json
from copy import deepcopy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "src"))
from playwright_demo.report_projection import parse_report_projection  # noqa: E402
from playwright_demo.protocol import InvalidWire  # noqa: E402

FP = "a" * 64
RESULT = {
    "protocolVersion": "1", "kind": "success",
    "context": {
        "testSpecId": "testp3b", "executionProfileRef": {"id": "p3b", "version": "1"},
        "profileFingerprint": FP, "presentationMode": "headless",
        "observation": {"state": "no_intervention", "autonomousEligible": True, "eventIds": []},
        "progress": {"stage": "replayed", "explorationAttemptId": "attemptp3b",
                     "resolvedSpecId": "resolvedp3b", "executionRunIds": ["runone", "runtwo"]},
        "report": {"kind": "available", "testSpecId": "testp3b"},
    },
    "terminal": {"phase": "execution", "status": "QA_ASSERTION_PASSED"},
}
PROJECTION = {
    "reportProjectionVersion": "1", "kind": "available", "testSpecId": "testp3b",
    "executionProfileRef": {"id": "p3b", "version": "1"}, "profileFingerprint": FP,
    "explorationAttemptId": "attemptp3b", "resolvedSpecId": "resolvedp3b",
    "executionRunIds": ["runone", "runtwo"], "terminal": RESULT["terminal"],
    "observation": "no_intervention", "screenshot": "stored_restricted",
    "outcomes": [{"phase": "execution", "status": "QA_ASSERTION_PASSED",
                  "assertionType": "assert_url", "expected": {"state": "withheld"},
                  "actual": {"state": "withheld"}}],
    "evidence": [{"evidenceId": "imagep3b", "owner": {"kind": "run", "id": "runone"},
                  "mediaType": "image/png", "sensitivity": "restricted",
                  "capturedAt": "2026-01-01T00:00:00.000Z", "byteLength": 3}],
}


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode("utf-8")


class ProjectionConsumerTests(unittest.TestCase):
    def test_accepts_correlated_closed_projection(self):
        self.assertEqual(parse_report_projection(encoded(PROJECTION), RESULT)["screenshot"],
                         "stored_restricted")

    def test_rejects_mismatch_and_artifact_path(self):
        self.assertRaises(InvalidWire, parse_report_projection,
                          encoded({**PROJECTION, "profileFingerprint": "b" * 64}), RESULT)
        self.assertRaises(InvalidWire, parse_report_projection,
                          encoded({**PROJECTION, "artifactRoot": "C:/private"}), RESULT)
        self.assertRaises(InvalidWire, parse_report_projection,
                          encoded({**PROJECTION, "evidence": [
                              {**PROJECTION["evidence"][0], "ref": "private.png"}]}), RESULT)

    def test_unavailable_is_projection_only(self):
        unavailable = {"reportProjectionVersion": "1", "kind": "unavailable",
                       "reason": "REPORT_NOT_FOUND"}
        self.assertEqual(parse_report_projection(encoded(unavailable), RESULT), unavailable)

    def test_rejects_unreviewed_outcome_vocabulary_and_display_strings(self):
        for field, unreviewed in (("phase", "private page text"),
                                  ("status", "PRIVATE_STATUS"),
                                  ("reason", "private provider diagnostic"),
                                  ("expected", {"state": "displayable", "value": "private page text"})):
            projection = deepcopy(PROJECTION)
            projection["outcomes"][0][field] = unreviewed
            with self.subTest(field=field):
                self.assertRaises(InvalidWire, parse_report_projection,
                                  encoded(projection), RESULT)

    def test_rejects_unreviewed_terminal_reason(self):
        projection = deepcopy(PROJECTION)
        projection["terminal"]["reason"] = "private provider diagnostic"
        result = deepcopy(RESULT)
        result["terminal"]["reason"] = "private provider diagnostic"
        self.assertRaises(InvalidWire, parse_report_projection, encoded(projection), result)


if __name__ == "__main__":
    unittest.main()
