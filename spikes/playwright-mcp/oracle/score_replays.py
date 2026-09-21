"""Score replay artifacts after locator execution; never generate or refine locators."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "replay-manifest.json"
KEY = Path(__file__).with_name("answer-key.json")
REPLAYS = ROOT / "artifacts" / "replays"
OUTPUT = REPLAYS / "oracle-results.json"


def load(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def main():
    manifest = load(MANIFEST)
    key = load(KEY)["scenarios"]
    results = []
    for scenario in manifest["scenarios"]:
        runs = []
        for run in (1, 2):
            artifact = REPLAYS / f"scenario-{scenario['id']:02}" / f"run-{run}.json"
            evidence = load(artifact) if artifact.exists() else {"status": "NOT_RUN"}
            expected = key[str(scenario["id"])]["expected"]
            state_ok = evidence.get("status") == "PASS" and all(
                evidence.get("resultingState", {}).get(name) == value
                for name, value in expected.items()
            )
            observed = evidence.get("observedTarget") or {}
            # IDs are an internal post-run identity signal where present. For
            # the custom option in Scenario 11, no id exists; uniqueness plus
            # the exact recorded option's accessible name and resulting value
            # is the objective identity evidence.
            identity_ok = observed.get("id") == scenario["expectedTarget"]
            if scenario["id"] == 11:
                identity_ok = (
                    evidence.get("matchCount") == 1
                    and observed.get("role") == "option"
                    and observed.get("accessibleName") == "High"
                    and state_ok
                )
            runs.append({
                "run": run,
                "executed": evidence.get("status") == "PASS",
                "unique": evidence.get("matchCount") == 1,
                "targetIdentityOk": identity_ok,
                "stateOk": state_ok,
                "failure": evidence.get("failure"),
            })
        results.append({
            "id": scenario["id"],
            "locator": scenario["locator"],
            "quality": scenario.get("quality", "PASS"),
            "runs": runs,
            "bothRunsPass": all(item["executed"] and item["unique"] and item["targetIdentityOk"] and item["stateOk"] for item in runs),
        })
    OUTPUT.write_text(json.dumps({"schemaVersion": 1, "results": results}, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT}")


if __name__ == "__main__":
    main()
