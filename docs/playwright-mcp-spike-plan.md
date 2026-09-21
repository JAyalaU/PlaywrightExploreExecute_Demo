# Playwright MCP element resolution: feasibility spike

## Question and falsifiable claims

Can Playwright MCP resolve UI targets from human descriptions and produce sufficiently durable Playwright locators without manually maintained selector hints?

This spike evaluates two related claims independently:

1. **Resolution claim:** Given a natural-language step and the current page, MCP identifies and interacts with the intended target directly (A) or through reasonable context from the step and page (B) in at least 10 of the 12 scenarios below, including all seven ordinary scenarios and at least three of the five difficult scenarios.
2. **Locator-generation claim:** For correctly resolved targets, MCP generates normal Playwright locators whose identities are based primarily on stable semantic or application-provided information available from the explored page state. The locators remain unique, point to the correct elements, and pass the intended action or assertion in two fresh, isolated Playwright contexts. At least 10 of the 12 scenarios must meet these conditions, including all seven ordinary scenarios and at least three of the five difficult scenarios.

A durable locator may use role and accessible name, label, placeholder, meaningful visible text with appropriate scoping, parent or region scoping, frame scoping, or a stable application-provided test identifier that MCP discovers or generates without manually supplied selector knowledge. These are examples, not a required preference order. A locator does not meet the durability claim if its identity depends primarily on screen coordinates, DOM position, `nth-child` or equivalent positional CSS, incidental CSS/XPath structure, transient or generated IDs, hidden selector knowledge unavailable through permitted MCP exploration, or manually supplied hints. Two successful executions do not override this quality criterion.

These thresholds measure hint-free feasibility. A claim that MCP reduces hints compared with the competing approach requires a separate comparison using the same scenarios.

## Fixed protocol

Use one small, deterministic test site containing the 12 scenarios below. Give the explorer only each natural-language instruction, the start URL, and any credentials needed to enter the site. Do not provide DOM structure, selectors, test IDs, or an answer key. Pin and record the MCP and Playwright versions, browser, viewport, and operating system. First check whether the installed MCP version exposes `browser_generate_locator`; the [research](playwright-mcp-research.md#testing-capability-and---capstesting) records an inconsistency between the documented testing tools and `--caps` option list. If the tool is unavailable, record **BLOCKED_BY_CAPABILITY** for the locator-generation claim and continue testing resolution. Do not substitute a hand-written locator or treat tool absence as a resolution failure.

For each scenario, navigate from the same clean starting state; use `browser_snapshot` and, where useful, `browser_find`; perform only interactions implied by the instruction; call `browser_generate_locator` for the selected target when available. Permit a new snapshot after navigation, opening a menu, or rendering a component. Permit contextual disambiguation using visible role, name, surrounding text, parent region, frame identity, or position expressly described in the instruction. Do not permit source inspection, developer tools, `browser_evaluate`, raw DOM queries, or selector guessing during the primary attempt. After the primary attempt is scored, a separate diagnostic pass may use these mechanisms to explain C or D.

When locator generation is available, run each candidate locator's intended action or assertion twice in separate fresh Playwright Test contexts, resetting fixture state between runs. Check uniqueness and target identity in both runs. Use isolated MCP sessions for exploration; do not rely on its default persistent profile. If access requires login, seed an isolated session with the same named authentication state used by the two clean test runs, and record that state's identity without saving secrets in evidence. Authentication itself is outside this spike. The [research](playwright-mcp-research.md#contexts-and-authentication) documents MCP's persistent and isolated modes and Playwright Test's per-test contexts.

## Outcome labels

- **A — Direct:** The first relevant snapshot or `browser_find` result identifies one correct target using information in the instruction.
- **B — Contextual:** The correct target is found after at most two state changes or scoped searches justified by the instruction, such as opening a menu, entering a dialog, selecting a named region, or entering an iframe.
- **C — Hidden selector knowledge:** Resolution requires a DOM query, CSS/XPath, test ID, source inspection, coordinates, or a manually supplied hint that the instruction and accessible page context did not provide.
- **D — Unresolved:** The target cannot be identified reliably even with the diagnostic mechanisms, or no workable interaction/locator exists.

Score **resolution** as a success when the attempt is A or B and exercises the correct target. Score it as a failure when it is C or D, exercises the wrong target, or needs a human-supplied selector or hint.

Score **locator generation** as a success only when resolution succeeds and the MCP-generated locator meets the quality criterion, remains unique, points to the correct target, and passes both clean runs. Score it as partial when resolution succeeds but the locator passes only one clean run, requires automatic refinement from information already present in the instruction and snapshot, or passes twice while failing the locator-quality criterion. Score it as failure when the attempt is C or D, selects the wrong target, or needs a human-supplied selector or hint. If `browser_generate_locator` is unavailable, mark the locator-generation claim **BLOCKED_BY_CAPABILITY** rather than assigning scenario locator failures. A manual selector or hint always fails the core hint-free claim, even if it makes the final test execute.

## Scenario matrix

Evidence supplements the common evidence bundle specified below. Hint states whether a manual selector or hint is needed for the scenario to pass; for every row, **yes means failure**. The success and partial descriptions below refer to locator generation when the tool is available; resolution is scored independently under the rules above.

| # | Natural-language scenario and capability | Expected MCP behavior | Success / partial / failure | Hint | Additional evidence |
|---|---|---|---|---|---|
| 1 | Select **Save**. Normal semantic button. | Snapshot exposes `button "Save"`; generate a role/name locator. | Correct button with durable locator in two runs / correct button but locator unstable or below the quality criterion / C, D, or wrong button. | No | Button's accessible name and post-click state. |
| 2 | Open **Settings**. Link navigation. | Snapshot exposes `link "Settings"`; locate and navigate. | Correct destination with durable locator in two runs / locator unstable or below the quality criterion / wrong link or C/D. | No | Starting and destination URLs. |
| 3 | Open the **top-right menu**, then select **Admin**. Menu opened by a button. | Find the button from its label or stated position, click, resnapshot, then find Admin within the opened menu. | Correct menu and item with durable locators in two runs / locator unstable or below the quality criterion / wrong menu or C/D. | No | Before/after snapshots showing menu state and target identity. |
| 4 | Choose **User** in the **Role** dropdown. Native select or accessible dropdown. | Find the labeled control, expose options if needed, select User. | Correct field/value with durable locator in two runs / locator unstable or below the quality criterion / wrong field or C/D. | No | Control role/name and selected value. |
| 5 | Open **Edit profile**; confirm **Save** appears in the dialog. Modal/dialog scoping. | Open dialog, resnapshot, find Save within the named dialog. | Correct dialog button with durable locator in two runs / locator unstable or below the quality criterion / background Save chosen or C/D. | No | Snapshot showing dialog and any background duplicate. |
| 6 | After loading, select **Continue**. Dynamically rendered element. | Resnapshot after the defined trigger; find the newly rendered button. | Correct target without a fixed sleep, using a durable locator in two runs / locator unstable or below the quality criterion / premature or wrong target, C/D. | No | Trigger, render timing, and before/after snapshots. |
| 7 | Select the **Search** icon. Icon-only button with an accessible label. | Snapshot exposes `button "Search"`; generate semantic locator. | Correct icon button with durable locator in two runs / locator unstable or below the quality criterion / C/D or wrong icon. | No | Accessible label and screenshot identifying the icon. |
| 8 | Select the **top-right menu icon**. Poorly labeled, non-semantic clickable control. | Snapshot may omit the target or expose insufficient identity; test whether context alone resolves it. | Correct target and durable locator in two runs / correct target but locator unstable or below the quality criterion / C/D or wrong control. | No | Snapshot gap, screenshot, and diagnostic explanation if C/D. |
| 9 | Select **Edit** for the **Billing** row. Duplicated visible text. | Find Billing row or region and scope its Edit control. | Correct row's Edit with durable locator in two runs / locator unstable or below the quality criterion / another Edit or C/D. | No | All Edit matches and row context. |
| 10 | Select **Submit** in the **payment frame**. Iframe. | Snapshot identifies frame content; generated locator retains frame scope. | Correct frame target with durable locator in two runs / frame found but locator unstable, below the quality criterion, or missing necessary scope / C/D. | No | Frame identity, snapshot, and generated frame scope. |
| 11 | Set **Priority** to **High**. Custom JavaScript/React-style control. | Snapshot exposes usable role, name, and options across state changes. | Correct value with durable locator in two runs / target found but locator unstable or below the quality criterion / C/D or wrong value. | No | Closed/open snapshots and resulting value. |
| 12 | Select **Apply** inside the **Preferences** component. Open Shadow DOM. | Test whether MCP exposes the descendant and generates a working locator; Playwright itself supports open shadow roots, while MCP behavior is unproven. | Correct descendant with durable locator in two runs / target found but locator unstable or below the quality criterion / C/D. | No | Host/descendant relationship and locator result. |

Use an **open** shadow root for scenario 12. Closed shadow roots are outside scope: the [research](playwright-mcp-research.md#shadow-dom-documented-playwright-behavior) reports that Playwright locators do not support them. The same research notes that iframe snapshots can expose frame content, but MCP's generated locator format for frames is unspecified.

## Evidence bundle and scoring

For every attempt, retain the exact instruction, start state, MCP tool calls and responses, initial and state-change snapshots, `browser_find` results when used, selected snapshot reference, resolution label A/B/C/D, and reason for any scoping step. Capture a screenshot at the point of selection. When locator generation is available, retain the generated locator, the page-state information from which its identity was derived, its locator-quality assessment and rationale, and the result of each clean test run, including locator match count, target identity, action/assertion result, and relevant URL or UI state. Retain a Playwright trace for failed or partial clean runs; video is optional and must be configured in Playwright Test because MCP code recording is not video recording, as documented in the [research](playwright-mcp-research.md#video). Redact credentials and session secrets.

Build the deterministic fixture so an automated scoring harness can access a private answer key or internal fixture identity that is never exposed to the MCP explorer, the LLM, the natural-language instruction, or the accessibility snapshot as artificial test metadata. The oracle should check objective outcomes where practical: which target was exercised, locator match count and uniqueness, resulting UI state, expected URL or navigation state, expected selected value, and whether both isolated executions succeeded. Oracle metadata must not become an implicit exploration hint.

Use targeted human review for judgments the oracle cannot reliably make: A versus B, whether resolution crossed the permitted-information boundary and therefore constitutes C, non-obvious violations of the locator-quality criterion, and ambiguous or disputed classifications. Record the judgment and its supporting evidence. Score the primary attempt before any diagnostic DOM or source inspection. Do not change scenario wording or thresholds after attempts begin.

## Experiment-wide decision rule

Apply the same precommitted scenario thresholds independently to **resolution** and, when available, **locator generation**. Count a resolution scenario only when it succeeds under the resolution rule. Count a locator scenario only when it succeeds under the locator-generation rule.

- **SUPPORTED:** At least 10 of 12 succeed, including all seven ordinary scenarios (1–7) and at least three of the five difficult scenarios (8–12); no wrong target is accepted as a pass.
- **PARTIALLY_SUPPORTED:** At least 7 of 12 succeed, but the SUPPORTED rule is unmet. Report the exact A/B/C/D distribution and which failures required hints.
- **REJECTED:** Fewer than 7 succeed.
- **BLOCKED_BY_CAPABILITY:** Applies only to the locator-generation claim when `browser_generate_locator` is unavailable in the pinned MCP version. Continue reporting the independently scored resolution result.

Report both claim results separately. If the intended architecture requires MCP-native locator generation, an unavailable `browser_generate_locator` may make that architecture **BLOCKED for the pinned MCP version**, even if resolution is SUPPORTED. Do not interpret tool absence as evidence that MCP failed to resolve a target.

Any wrong-target selection is a scenario failure and must be called out separately, even when the overall claim label is PARTIALLY_SUPPORTED. C and D outcomes show where hints, app accessibility changes, or another discovery mechanism would be necessary.

## What this spike cannot establish

The spike does not measure comparative hint reduction without running the competing approach on the same cases. It does not establish durability across future UI redesigns, browser engines, locales, responsive layouts, cross-origin or nested frames, closed shadow roots, canvas-only controls, protected production applications, authentication setup, or arbitrary third-party sites. Two clean runs test immediate reproducibility, not long-term locator stability. The [research](playwright-mcp-research.md#elements-that-snapshots-may-not-expose) documents available fallbacks but no general MCP guarantee that inaccessible or canvas-rendered elements appear in snapshots.
