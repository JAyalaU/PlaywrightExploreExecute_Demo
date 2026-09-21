# Local fixture validation

Performed after the scenario-isolation correction.

| Check | Result |
|---|---|
| Isolated routes `/scenario/1/` through `/scenario/12/` | Passed; each returned its own scenario document. |
| Scenario 1 Save controls | Passed; exactly one `Save` control is present. |
| Scenario 5 intentional Save ambiguity | Passed; background and dialog `Save` controls remain. |
| Scenario 9 intentional Edit ambiguity | Passed; Billing and Shipping rows each retain `Edit`. |
| Deterministic reset | Passed; a fresh Scenario 1 navigation returned the original document. |
| Private oracle key HTTP access | Passed; `GET /oracle/answer-key.json` returned `404`. |
| Oracle route mappings | Passed; every private mapping points to its matching public scenario route. |
| Python syntax compilation | Passed for `spikes/playwright-mcp/`. |
| Offline oracle execution | Passed; existing unattempted evidence remained unattempted. |

No Playwright MCP attempt, browser scoring, or experimental conclusion was run as
part of this fixture-only correction.
