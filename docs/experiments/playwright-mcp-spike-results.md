# Playwright MCP feasibility spike: completed execution

Run date: 2026-09-19. This report supersedes the earlier blocked execution record after fixture isolation and completion of fresh-context locator replay.

## Environment and MCP capabilities

The deterministic local fixture ran at `http://127.0.0.1:4173`, with isolated routes `/scenario/1/` through `/scenario/12/`. The replay harness used Chromium through `@playwright/test` 1.57.0 / Playwright 1.57.0. The configured MCP session exposed and used `browser_navigate`, `browser_snapshot`, `browser_find`, `browser_click`, `browser_select_option`, `browser_wait_for`, `browser_generate_locator`, and `browser_take_screenshot`. No authentication was required.

Primary MCP exploration used only each instruction, its route, accessibility snapshots/find results, and the instructed state changes. It did not use source, DOM inspection, oracle data, test IDs, CSS/XPath selectors, evaluation, or DevTools before scoring.

## Scenario matrix

| # | Resolution | Exact MCP-generated locator | Primary interaction | Quality | Fresh replay #1 / #2 |
|---|---|---|---|---|---|
| 1 | A | `getByRole('button', { name: 'Save' })` | Saved | Pass | Pass / Pass |
| 2 | A | `getByRole('link', { name: 'Settings' })` | `/settings.html` | Pass | Pass / Pass |
| 3 | B | `getByRole('menuitem', { name: 'Admin' })` | Admin selected | Pass | Pass / Pass |
| 4 | A | `getByLabel('Role', { exact: true })` | User selected | Pass | Pass / Pass |
| 5 | B | `getByRole('dialog', { name: 'Edit profile dialog' }).getByRole('button', { name: 'Save' })` | Dialog Save visible | Pass | Pass / Pass |
| 6 | B | `getByRole('button', { name: 'Continue' })` | Continued | Pass | Pass / Pass |
| 7 | A | `getByRole('button', { name: 'Search' })` | Search selected | Pass | Pass / Pass |
| 8 | B | `getByText('☰')` | Menu opened | **Fail**: glyph does not provide a durable semantic or application identity | Pass / Pass |
| 9 | B | `getByRole('row', { name: 'Billing row' }).getByRole('button', { name: 'Edit' })` | Billing edit selected | Pass | Pass / Pass |
| 10 | B | `locator('iframe[title="payment frame"]').contentFrame().getByRole('button', { name: 'Submit' })` | Submitted | Pass | Pass / Pass |
| 11 | B | `getByRole('option', { name: 'High' })` | Priority High | Pass | Pass / Pass |
| 12 | A | `getByRole('button', { name: 'Apply' })` | Applied | Pass | Pass / Pass |

The A/B/C/D distribution is A=5, B=7, C=0, D=0. No wrong target was selected, and no manual selector, test ID, or other hidden hint was supplied.

## Oracle and replay evidence

The primary post-exploration oracle passed all 12 correct-target, uniqueness, action, and expected-state checks. The replay harness used the exact locator strings recorded above. For each scenario it navigated from its clean route, ran only prerequisite interactions already implied by the primary flow (for example opening the menu before exercising the recorded menuitem locator), counted the recorded locator, exercised or asserted it, checked the expected visible state, then closed the context. It repeated that process in a second independently created context.

All 24 runs had match count 1, exercised the expected target, and reached the expected state. For Scenario 11, the final `option "High"` has no element ID; the private oracle therefore verified identity from its unique accessible role/name plus the resulting Priority value. This did not alter the recorded locator. Scenario 8 also executed uniquely in both contexts, but it remains a locator-quality failure under the predeclared rule.

Artifacts are under [replay evidence](../../spikes/playwright-mcp/artifacts/replays), including one JSON record for each scenario/run and the [post-replay oracle result](../../spikes/playwright-mcp/artifacts/replays/oracle-results.json). Primary snapshots and screenshots remain under [primary evidence](../../spikes/playwright-mcp/artifacts), with the original [primary oracle output](../../spikes/playwright-mcp/artifacts/oracle-results.json).

## Verdicts

**Resolution claim: SUPPORTED.** All 12 scenarios were A or B and exercised the correct target. This exceeds the fixed 10-of-12 requirement, includes all seven ordinary scenarios, and includes all five difficult scenarios.

**Locator-generation claim: SUPPORTED.** MCP generated a locator for every correctly resolved target. Eleven locators passed the durable-locator quality rule and replayed uniquely against the correct target in both fresh contexts. That exceeds the fixed 10-of-12 rule, includes all seven ordinary scenarios, and includes four of five difficult scenarios. Scenario 8 is partial only: it replays twice but fails the quality criterion.

**Experiment-wide verdict: SUPPORTED.** On this deterministic fixture, the evidence supports Playwright MCP as the exploration and target-resolution mechanism and supports MCP-native locator generation for the proposed QA-validation workflow. This demonstrates immediate reproducibility in clean contexts, not stability after an application redesign.

## Limitations

The approved limits remain: this does not cover arbitrary applications, future UI redesigns, other browser engines, locales, responsive layouts, cross-origin or nested frames, closed shadow roots, canvas-only controls, authentication, or protected production applications. It does not compare manual-hint use with another approach. Scenario 8 shows that interaction resolution can succeed while the generated locator still fails the durable-locator requirement.
