"""Score recorded MCP attempts without exposing the answer key to exploration.

This program is intentionally an offline oracle. It is run only after primary
MCP evidence has been captured. The fixture web server never serves this
directory, and its answer key must not be copied into MCP prompts, snapshots,
or browser-accessible page data.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts"
ATTEMPTS = ARTIFACTS / "primary-attempts.json"
KEY = Path(__file__).with_name("answer-key.json")
OUTPUT = ARTIFACTS / "oracle-results.json"


def load(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def score_attempt(attempt: dict, expected: dict) -> dict:
    """Score only evidence supplied after a primary attempt.

    Future MCP runners must include `observedTarget`, `matchCount`, `actionOk`,
    `resultingState`, and (when a locator exists) `cleanRuns`. This keeps the
    oracle deterministic while reserving A/B/C/D and locator-quality judgments
    for the approved targeted human review.
    """
    if attempt["status"] == "NOT_ATTEMPTED":
        return {"id": attempt["id"], "status": "NOT_ATTEMPTED", "oracle": "NOT_RUN"}

    required = {"observedTarget", "matchCount", "actionOk", "resultingState"}
    missing = sorted(required - attempt.keys())
    if missing:
        return {"id": attempt["id"], "status": "INVALID_EVIDENCE", "missing": missing}

    correct_target = attempt["observedTarget"] == expected["target"]
    unique = attempt["matchCount"] == 1
    state_ok = all(attempt["resultingState"].get(k) == v for k, v in expected["expected"].items())
    return {
        "id": attempt["id"],
        "status": "SCORED",
        "correctTarget": correct_target,
        "unique": unique,
        "actionOk": bool(attempt["actionOk"]),
        "stateOk": state_ok,
        "resolutionObjectivePass": correct_target and bool(attempt["actionOk"]),
        "locatorRuns": attempt.get("cleanRuns", "NOT_APPLICABLE"),
    }


def main() -> None:
    attempts = load(ATTEMPTS)
    key = load(KEY)["scenarios"]
    observed = attempts["scenarios"]
    if sorted(str(item["id"]) for item in observed) != sorted(key):
        raise SystemExit("Attempt evidence must contain exactly the 12 approved scenario IDs.")
    result = {
        "schemaVersion": 1,
        "inputStatus": attempts["runStatus"],
        "mcpToolInventory": attempts["mcpToolInventory"],
        "results": [score_attempt(item, key[str(item["id"])]) for item in observed],
        "humanReviewRequiredFor": ["A/B classification", "C permitted-information boundary", "non-obvious locator quality", "ambiguous/disputed evidence"],
    }
    OUTPUT.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()
