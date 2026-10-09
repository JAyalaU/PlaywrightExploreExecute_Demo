# Destination document readiness experiment

> **D1 status: frozen historical public-site experiment (2026-10-07).** This six-run local-Windows readiness experiment answered a time-dependent public navigation question. Its driver was removed; the original harness path below no longer exists. It required native schema-5 trusted approval, Windows Chromium and public-site access. See the [experiment index](../../tools/experiments/README.md).

## Method

On 2026-10-05, [the dedicated harness](../scripts/destination-readiness-experiment.mjs) ran six sequential fresh `local-windows` v5 `ProtectedContextFactory` sessions using bundled Playwright Chromium. Live viewing was off. Each session created one page, navigated once to `https://the-internet.herokuapp.com/` with `waitUntil: 'domcontentloaded'` and the profile's 90-second navigation ceiling, then counted the exact `Dropdown` role link. A non-2xx root response or nonunique link would have ended that run without retry. Every root qualified. Each run clicked the link once through an ordinary Playwright locator.

Passive main-frame response, navigation-commit, DOMContentLoaded, and load listeners were attached before navigation. A navigation commit received an opaque document-generation identifier. The destination was sampled as soon as the click returned, then after `page.waitForLoadState('domcontentloaded')`, then after `page.waitForLoadState('load')`; each wait had the same 90-second ceiling. Each sample read `document.readyState`, the native `select` count, and the combobox role count. The harness checked whether later samples belonged to the generation seen immediately after click. There were no sleeps, reloads, retries, screenshots, viewer frames, MCP, candidate grounding, provider calls, deferred workflow, compiler, or replay. All six sessions closed with verified cleanup.

## Results

All root and destination main-document responses were HTTP 200, with exact sanitized root and `/dropdown` URLs respectively and no redirects. Each root had exactly one `Dropdown` link. All six clicks succeeded. `Select` and combobox counts agreed at every destination sample; the table shows native selects. DCL means DOMContentLoaded. Times in parentheses are the wait duration after the immediate sample.

| Run | Root HTTP | Click | Immediate state | Immediate select | DCL state | DCL select | Load state | Load select | Outcome |
|---|---:|---|---|---:|---|---:|---|---:|---|
| 1 | 200 | 183 ms | loading | 0 | complete (30,194 ms) | 1 | complete (1 ms) | 1 | Same generation; select appeared by DCL |
| 2 | 200 | 256 ms | complete | 1 | complete (1 ms) | 1 | complete (0 ms) | 1 | Same generation; present immediately |
| 3 | 200 | 186 ms | complete | 1 | complete (1 ms) | 1 | complete (0 ms) | 1 | Same generation; present immediately |
| 4 | 200 | 159 ms | interactive | 1 | interactive (1 ms) | 1 | complete (36 ms) | 1 | Same generation; present immediately |
| 5 | 200 | 208 ms | complete | 1 | complete (1 ms) | 1 | complete (1 ms) | 1 | Same generation; present immediately |
| 6 | 200 | 205 ms | interactive | 1 | complete (1 ms) | 1 | complete (1 ms) | 1 | Same generation; present immediately |

Root navigation took 34,241, 1,070, 10,171, 1,077, 1,161, and 28,769 ms respectively. All destination sampling and lifecycle waits succeeded; no destination document replacement was observed. Run 1's immediate sample saw a successful destination response and exact URL but `readyState=loading`, zero selects, and zero comboboxes. Its same-generation DCL sample saw one of each. The other five documents already had one of each when sampled after click. The test did not measure the exact moment within the interval when the select entered the DOM.

At the instant the immediate sample began, the passive listeners had not yet recorded DOMContentLoaded or load for the destination in any run. These listener flags were captured before the asynchronous DOM and role reads; a later `readyState=interactive` or `complete` in the same sample therefore does not contradict the earlier flags. Both lifecycle waits completed in every run, and the generation recorded when the click returned matched every subsequent sample.

## Classification and conclusion

**`SELECT_RELIABLY_APPEARS_BY_DOMCONTENTLOADED`**. Every healthy destination document had the native select and combobox by its DOMContentLoaded boundary. One of six lacked both immediately after the click returned, then acquired both in the same document. HTTP failure, document replacement, and live-view capture do not explain that run. This supports a post-click readiness race as a mechanism for immediate zero-candidate reads; it does not prove that every earlier workflow stop had that same cause.

**Recommended shared production rule for later implementation:** after an action commits a new document, do not begin the next DOM-dependent grounding or execution operation until that committed document reaches DOMContentLoaded. Apply the rule consistently to exploration and runner replay, with a bounded wait and same-document check. This experiment does not change production navigation behavior.
