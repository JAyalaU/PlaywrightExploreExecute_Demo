# Native owned-option selected-state verification independent gate

Initial gate date: 2026-09-29. The initial result was **blocked on exact-task coverage**. Following the test-only alias and runbook corrections documented below, the independent final-tree regate completed on 2026-09-29 with result: **OFFLINE CAPABILITY GATE PASSED**. This report does not approve the workflow selector, authorize a public target, or record a live provider/browser proof.

## Blocker-closure addendum (2026-09-29)

The exact-source harness and runbook-documentation blockers initially reported below were corrected; see [the focused closure report](native-owned-option-exact-source-proof-closure.md). The final-tree regate below independently verified the exact public task through both extraction calls, admission, trace, compiler, and two protected replay contexts, while resolving the target host only to loopback and denying other browser requests. It completes with two agreeing true assertions and `QA_ASSERTION_PASSED`. The live runbook and current status reflect the implemented native selected-state semantics and current reviewed version names.

The offline gate does **not** authorize the workflow selector, public target, or live proof. The exact public target still requires separate approval, and the production selector/default remains unchanged.

## Scope and result

Reviewed the repository instructions, system overview, current status, selected-option design review, and implementation report. Inspected the deferred source/admission contract, provider and decision wires, native option observation, source-to-strategy correspondence, authenticated trace/capture, fresh compiler projection, ResolvedTestSpec v9 runner assertion/proof validation, replay agreement, and safe projection path. No production code or workflow selection was changed. No credentialed provider or public target was used.

The reviewed capability is implemented across the intended deferred-only v2 inner contracts. I found no architectural violation in the audited implementation. Historical VerificationGoal v1, observation v1, strategy v1, assertion v1, and workflow families remain separate; the native claim is not silently upgraded into them.

## Findings

- **Native truth and authored meaning:** The source claim carries an exact authored option label/span, expected boolean, and source-owned role/name/label constraints. It has no DOM value, locator, current reference, or approval field. Both extraction responses must agree on source occurrence, polarity, owner constraints, order and dependencies. The independent source-first input is the original source and reviewed contract; it does not receive the primary extraction or browser state. The option label is used as the option subject. It does not become a control name.
- **Complete control domain:** The protected reader enumerates all current page frames and the bounded `combobox`/`listbox` domain, including hidden matches, before looking up the option label or reconstructing the durable frame. Only admitted exact constraints can narrow the domain; a proven accessible-label relation is checked after the broad role/name query and cannot use option membership to manufacture uniqueness. The tests explicitly cover a second eligible control that lacks the requested option, hidden/custom extra controls, and cross-frame ambiguity.
- **Owned native option state:** The runtime reads native option label/value/selected facts through the isolated utility-world reader, verifies current control/frame/option ownership and complete membership, and renews retained identities and state before issuing evidence. Contradictory `aria-selected` and page-world overrides of native getters do not change the result. Missing options, duplicate label/value mappings, truncation, stale/replaced nodes, frame/label drift, query errors and incomplete candidate evidence stop as non-QA. A negative claim requires an existing uniquely owned option whose native selected state is false; absence never satisfies negation. Disabled native state remains readable.
- **No action-success shortcut:** Verification obtains a separate protected read-only fact. The action effect is not used as the verification actual. A change in selected boolean with intact identity and mapping remains deterministic assertion truth; a within-read identity/state change is stale and non-QA.
- **Compiler and replay mapping:** The fresh compiler reruns the full predicate and may accept a newly derived unique DOM value, then pins that value and label-ownership digest in assertion v2. Each model-free runner independently remaps the authored label and requires exact equality with the compiler-pinned value. Replay-side mapping, frame or label-owner drift stops without repair. The compiler continues to use its existing protected MCP-backed fresh session; the deterministic runner and persisted runner-facing read path remain MCP-free.
- **Agreement and privacy:** Native replay facts retain actual selected boolean and evaluation. Agreement hashes the corresponding assertion facts and source step linkage, not private proof IDs, session IDs, or runtime refs. The authenticated restart test observes distinct proof/control identities while the pair still agrees. Native safe projection tests reject option/source text, option values, assertions, actual/expected values and protected proof fields; Python accepts the same bounded projection without new private fields.
- **Compatibility:** The focused historical verification/provider suite passed. Deferred compatibility covers tagged-family rejection, old-route isolation and no fallback. Historical `aria-selected` semantics remain in their old assertion family and do not authorize native option claims.

The prepared [real-provider gate procedure](deferred-action-grounding-live-release-gate.md) was stale in two places: it described selected-option verification as unsupported/ARIA-backed and listed extraction identities `qa_deferred_action_interpretation_v5` / `qa_deferred_action_source_first_v1`. The procedure and evidence form were corrected in the blocker-closure report. The exact three-step task and existing public approval/isolation procedure remain unchanged. Exact URL approval and a separately authorized live proof remain outstanding.

At the time of this gate, the primary integrated test fell short of the exact-source acceptance condition. Its fixture helper rewrote the authored navigation step and provider task input to `Go to http://127.0.0.1:<port>/.`; the fixture page was `/`, not `/dropdown`. The authored `Select Option 1.` and `Verify that Option 1 is selected.` clauses were retained, and the full deferred route passed, but it was not the exact task `Go to https://the-internet.herokuapp.com/dropdown.` followed by those clauses. The trusted request start URL, source navigation goal, and actual browser URL were linked. The safe test-only alias subsequently added under the blocker-closure addendum preserves those links, uses a loopback-only profile pin and request interception, and denies all other browser requests. It does not fabricate a public approval, page URL, or current-state evidence and does not weaken production checks. No public approval or public request was attempted.

## Final-tree validation

All Node suites ran serially with one worker and separate output directories. There were no failures or skips.

| Suite | Result |
|---|---:|
| Native source and end-to-end focused suite | 54 passed, 0 failed, 0 skipped |
| Deferred WP1A–WP5A changed-boundary compatibility | 334 passed, 0 failed, 0 skipped |
| Historical verification/provider compatibility | 83 passed, 0 failed, 0 skipped |
| Python deferred host/protocol/projection/UI suite | 7 passed, 0 failed, 0 skipped |
| Native authenticated restart after final build, import-blocked | 1 passed, 0 failed |
| Typecheck | Passed |
| Build | Passed |

Commands:

```powershell
npx.cmd playwright test tests/native-option-verification-source.spec.ts tests/native-owned-option-verification.spec.ts --workers=1 --output=test-results-native-option-independent-regate-final

npx.cmd playwright test tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-interpretation-v2-wp1b.spec.ts tests/deferred-action-grounding-wp1-v2-independent-gate.spec.ts tests/deferred-action-grounding-wp2a.spec.ts tests/deferred-action-grounding-wp2b.spec.ts tests/deferred-action-grounding-wp2c.spec.ts tests/deferred-action-grounding-wp2d-a.spec.ts tests/deferred-action-grounding-wp2d-b.spec.ts tests/deferred-action-grounding-wp3a.spec.ts tests/deferred-action-grounding-wp3b.spec.ts tests/deferred-action-grounding-wp4a.spec.ts tests/deferred-action-grounding-wp4b.spec.ts tests/deferred-action-production-wp5a.spec.ts --workers=1 --output=test-results-native-option-independent-regate-deferred

npx.cmd playwright test tests/goal-directed-verification-wp1.spec.ts tests/goal-directed-observation-wp2.spec.ts tests/goal-directed-verification-wp3a.spec.ts tests/goal-directed-trace-wp3b-a.spec.ts tests/goal-directed-trace-wp3b-b.spec.ts tests/goal-directed-compiler-wp4a.spec.ts tests/goal-directed-runner-wp5a.spec.ts tests/openai-responses-p2-1b.spec.ts tests/openai-adapters-p2-1c.spec.ts --workers=1 --output=test-results-native-option-independent-regate-historical

.venv\Scripts\python.exe -m unittest tests.python.test_deferred_workflow_wp5a -v
npm.cmd run typecheck
npm.cmd run build
npx.cmd playwright test tests/native-owned-option-verification.spec.ts --grep "native replay proof is separately validated" --workers=1 --output=test-results-native-option-independent-regate-restart
```

The final restart test authenticates stored native replay/projection in a new process while blocking imports under `/exploration/`, `@playwright/mcp`, and `@modelcontextprotocol/`. It also tampers with persisted proof data and confirms authentication rejects the altered record.

The three Node suites contain **471 unique tests** (54 + 334 + 83), all passed. The post-build restart command reran one case already included in the 54-test native suite; it is reported separately above and is not added to that total. SHA-256 comparison of all 178 `app/` and `src/` production files before and after this gate found **zero changes or additions**.

The exact authored task passed through the actual mocked-provider/protected-loopback route with both extraction inputs unchanged, matching admitted source/digest/span/URL, and two agreeing true selected-state observations ending in `QA_ASSERTION_PASSED`. No dropdown name or DOM value was authored. The test-only target alias pins `the-internet.herokuapp.com:443` to loopback, installs the protected route in each fresh context, denies unexpected DNS names and aborts every other browser request. This is not public-target approval or a live proof. Positive/negative true and false assertion outcomes were exercised; agreeing false assertions yield deterministic `QA_ASSERTION_FAILED`, while ownership, mapping, ambiguity, frame and incomplete-evidence uncertainty remain non-QA. Two eligible dropdowns stop `NON_UNIQUE` before mutation/compile/replay/QA. Compiler remapping succeeds only when fresh and unique; replay requires equality with that compiler-pinned mapping.

**Current release boundary:** the independent offline capability gate passed after correction. The prepared exact-task live procedure may proceed unchanged to the separate approval step, subject to a separately approved exact public URL/profile and the existing protected-isolation preflight. No approval was created, selector/default enabled, or live proof run by this gate. Custom controls, multiple selects, generic activation and unsupported relationships remain outside the supported subset.

No architectural violations were found in the reviewed native VerificationGoal boundary. The test-only exact-source alias is bounded to loopback and does not grant public authority; the offline pass is not a live proof. Native selected `true` and `false` observations produce deterministic QA truth when ownership and mapping are intact; ambiguity, stale/incomplete evidence, owner/frame/mapping drift, runner stops and cleanup uncertainty stay non-QA. The primary exact three-step task passes; two dropdowns stop before mutation. Historical families and their `aria-selected` semantics remain isolated.

SELECTED_OPTION_VERIFICATION_OFFLINE_GATE_PASSED
