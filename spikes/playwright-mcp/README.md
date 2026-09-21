# Playwright MCP feasibility-spike fixture

This directory is an intentionally small, local-only fixture for the approved
Playwright MCP feasibility spike. It is not product code.

Start the fixture (only `fixture/` is served):

```powershell
python spikes/playwright-mcp/serve.py
```

Each attempt must start on its isolated route:
`http://127.0.0.1:4173/scenario/1/` through
`http://127.0.0.1:4173/scenario/12/`. The private oracle answer key is outside
the served directory and must not be supplied to an MCP explorer or used during
primary resolution.

Run the scoring harness after collecting a primary-attempt evidence file:

```powershell
python spikes/playwright-mcp/oracle/score.py
```

The harness reads `artifacts/primary-attempts.json` and writes
`artifacts/oracle-results.json`. It deliberately reports an unattempted result
when no browser/MCP evidence is present; it never invents a target selection.

## Fixture correction: scenario isolation

The original shared page exposed controls from unrelated scenarios at the same
time. That made Scenario 1's `Select Save.` instruction ambiguous because a
Profile-related background Save button was also visible. The fixture now serves
one scenario per route so unrelated controls do not enter the accessibility
surface. This is an experimental-fixture correction only: it does not change
the spike hypothesis, scenario wording, A/B/C/D taxonomy, or acceptance
criteria. Intentional ambiguity remains in Scenario 5 (background and dialog
Save controls) and Scenario 9 (Billing and Shipping Edit controls).

Run structural validation without conducting an MCP attempt:

```powershell
python spikes/playwright-mcp/validate_fixture.py
```

## Recorded-locator replay

The replay harness tests the exact locators recorded from the completed MCP
primary exploration. It does not invoke MCP, regenerate a locator, or replace
one with a hand-written alternative. Each run creates and closes a separate
Chromium browser context.

Install the isolated test dependency and browser once:

```powershell
cd spikes/playwright-mcp
npm install
npx playwright install chromium
```

Run the replay suite (the local fixture server must already be running):

```powershell
npm run replay
python oracle/score_replays.py
```

The recorded locators and replay action contracts are in
`replay-manifest.json`. Per-run artifacts and the post-replay oracle result are
written to `artifacts/replays/`. Scenario 8 remains a locator-quality failure
even if both replay runs pass: immediate execution reproducibility does not
make its glyph-based locator durable.
