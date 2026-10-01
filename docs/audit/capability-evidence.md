# Empirical capability evidence

This report classifies only behavior exercised by checked-in tests or explicitly recorded completed live evidence. A type, schema, prompt, or release procedure alone does not count as proof. "Fixture only" means an offline browser fixture or deterministic mock demonstrates the behavior; it does not demonstrate real-provider interpretation. Current structured-action-v1 has completed its offline gate, but its approved-public-target real-provider proof is still pending.

## Capability matrix

| Capability | Classification | Evidence and limit |
|---|---|---|
| Navigation | **Proven live provider** | The released `agentic-exploration-v1` Status Codes operator run navigated the approved public site and completed a two-replay QA pass. This does not prove the newer structured-action-v1 route. See [agentic-v2 release gate](../agentic-v2-release-gate.md). |
| Named link click | **Proven live provider** | The same completed run clicked `Status Codes`, `200`, and `here` links and passed exact URL checks. It establishes these specific named/contextual link operations on that route, not general link robustness. |
| Paraphrased named link click | **Fixture only** | Structured identity tests feed six equivalent phrasings through controlled interpretation responses and check normalized identity; they do not ask a real provider to paraphrase or resolve the request. The structured-action live gate lists paraphrase as optional future evidence and is still pending. See `structured-action-identity-wp1.spec.ts` and the [current live gate](../structured-action-identity-live-release-gate.md). |
| Named button click | **Fixture only** | The Add/Remove protected-fixture integrations click the named `Add Element` button through structured action binding and replay. No completed live-provider button-click proof is recorded for structured-action-v1. |
| Existence | **Fixture only** | Goal-directed observation/verification and structured Add/Remove fixtures establish positive counts and replay predicates. Most tests supply already-structured VerificationGoal objects or scripted model decisions. |
| Absence | **Fixture only** | Add/Remove fixtures observe a complete zero count before insertion; tests also verify freshness after mutation. The exact structured-action live proof is pending. |
| Dynamic post-action presence | **Fixture only** | The Add/Remove fixture inserts `Delete` after `Add Element`; a fresh observation sees it, and the full offline goal-directed integration compiles and replays the result. |
| Hidden versus present | **Fixture only** | Observation and runner fixtures distinguish a hidden matching control from zero matches/visibility. This is fixture behavior, not live-provider evidence. |
| Count/cardinality | **Fixture only** | Fixtures cover zero, positive, exact counts, and evaluated-false count predicates, including two agreeing false replay assertions. |
| Enabled/disabled | **Fixture only** | Trusted property observation and deterministic runner fixtures read enabled state for named controls. No live-provider proof is recorded. |
| Text/value | **Fixture only** | Fixtures exercise text, input value, checked, and selected native-select value observations/assertions. This evidence spans the older runner and goal-directed fixtures; it is not proof that the structured-action provider route can interpret arbitrary text/value requests. |
| URL verification | **Proven live provider** | The released Status Codes run completed three exact URL checks with matching deterministic replays. URL verification on the structured-action-v1 route remains unproven live. |
| `select_option` | **Fixture only** | `runner-m4.spec.ts` executes a native `<select>` operation with the authored target `Role` and value `User`, then checks the resulting value. This is legacy resolved-runner coverage with the target and value already structured; it does not prove current agentic interpretation, target discovery, or operation selection. |
| Dropdown option availability | **Unknown** | The inspected tests do not demonstrate a model/runtime flow that enumerates or semantically inspects the options of an unfamiliar dropdown. A fixture containing `<option>` elements and a successful fixed-value selection is not evidence of option discovery. |
| Selected-state verification | **Fixture only** | The legacy runner fixture selects `User` and then reads/asserts the select value. No completed structured-action-v1 provider run verifies selection state. |
| Unnamed controls | **Unsupported** | No checked-in end-to-end test demonstrates acting on an unnamed control. Current structured action tests build intents with an accessible name, and current binding evidence is based on a named semantic target; a unique unnamed-control workflow is not empirically established. |
| Multiple similar controls | **Fixture only** | Protected-binding and observation fixtures reject duplicate semantic matches or uniqueness-required property reads rather than choosing by position. This proves fail-closed fixture behavior, not successful contextual resolution of similar controls. |
| Frames | **Fixture only** | Local browser fixtures prove nested-frame observation/replay and reject frame drift or ambiguous ancestry. There is no recorded live-provider frame task. |
| Prerequisites | **Fixture only** | Fixtures exercise opening a menu/dialog or revealing a target before acting, and keep prerequisite identity separate from authored target identity. The current live structured-action proof has not run. |
| Temporal verification | **Partially proven** | Fixture exploration can establish a grounded present→action→absent transition. The tested deterministic compiler rejects that temporal strategy as unsupported, so it cannot currently become a reproducible accepted test. See `goal-directed-verification-wp3a.spec.ts` and `goal-directed-production-wp5b.spec.ts`. |
| Relative/spatial relationships | **Unsupported** | The goal-directed fixture explicitly treats an unreviewed `above` relationship as unsupported. No deterministic relationship assertion is evidenced. |
| Ambiguous target recovery | **Fixture only** | M7 fixtures exercise wrong-selection feedback, distinct alternatives, and retry/recovery under fixed budgets; duplicate/ambiguous semantic identity is also tested to fail closed. They do not prove live-provider recovery on the structured-action route. |

## What the test suites actually establish

- `agentic-v2-release-gate.md` records one completed operator-reported real-provider proof for the older released `agentic-exploration-v1` route: named link navigation, exact URL assertions, two agreeing fresh deterministic replays, and verified cleanup. It does not report open-ended capability breadth or structured-action-v1 behavior.
- Current structured-action suites exercise the controlled pipeline using local HTTP pages and deterministic action/verification models. In particular, `structured-action-identity-wp2.spec.ts` supplies structured TestSpec v5 action intents and selects refs from known fixture snapshots. `structured-action-identity-wp4a.spec.ts` supplies prepared actions/predicates to the deterministic runner. These are valuable binding, provenance, compiler, and replay checks, but they do not prove real-model decisions.
- `structured-action-identity-wp4b.spec.ts` does exercise the local interpretation adapter through a mocked provider transport. The mock returns a prebuilt structured response for Add/Remove, including for the exact public-URL wording before browser startup. This proves adapter routing, wire format, parsing, and validation against that supplied response; it does not prove a live provider would infer the same structure.
- Goal-directed integration tests often provide already-structured `VerificationGoal` instances and scripted observation/conclusion actions. They establish trusted observation and strategy-controller behavior under those inputs, not natural-language interpretation quality.
- The select-option proof is confined to the legacy v2 runner fixture. It begins with the authored target and option value already present in structured steps, and locators already accepted. It does not show the model separating `Option 1` from an unnamed dropdown target.

## Fixture and wiring gaps

Fixture suites can validate browser/runtime and artifact mechanics while hiding production integration gaps. The repository's own status history records such a gap: structured-action-v1 initially requested TestSpec v5 while production still selected the v2 interpretation adapter, which could not carry `ActionTargetIntentV1`; the adapter selection was corrected and source plus built-dist mocked-transport tests now check it. That correction is offline wiring evidence, not a live-provider proof.

Likewise, fixture-generated or injected structured outputs bypass the model's hardest decisions: extracting intended target identity from prose, separating target from operation argument, resolving an unnamed or contextual control, and choosing a verification strategy that the compiler can represent. Passing fixture integrations do not establish those model behaviors. The known-good Add/Remove case is currently supported through fixture integration; its current structured-action approved-public-target provider proof remains open.

### Evidence gap

Highest-value claimed capabilities still lacking empirical demonstration are:

1. A completed real-provider run on the current structured-action-v1 route, from natural language through v5 interpretation, M7, trace v4, compiler v3, v8, and two agreeing replays.
2. Dropdown reasoning that identifies the control, inspects available options, distinguishes target from option argument, and verifies selected state. Current evidence covers only a legacy runner selecting a supplied option value on a supplied named control.
3. Real-provider interpretation of paraphrased actions, role-unspecified targets, ambiguous controls, and recovery choices. Existing paraphrase/recovery coverage uses mocked or scripted decisions.
4. Action on unnamed controls and relationship/context-based target identification. No successful current-route evidence demonstrates these cases.
5. End-to-end deterministic replay for temporal verification. Fixture exploration can recognize one tested temporal transition, but compiler evidence shows it stops before a reproducible artifact.
