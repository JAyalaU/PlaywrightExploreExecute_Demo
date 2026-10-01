# Test-suite rationalization audit

## Scope and evidence

This is a read-only audit of the repository instructions, system overview, current status, current `package.json`, `playwright.config.ts`, `pyproject.toml`, and every runnable TypeScript Playwright spec and Python `test_*.py` file under `tests/`. It also accounts for test support files under those trees. Current `deferred-action-v1` WP1–WP5 contracts and regression reports were used as the primary capability map; released `agentic-exploration-v1` and historical `goal-directed-v1`, `structured-action-v1`, P2–P4 and resolved v2–v8 routes are treated as compatibility families.

The inventory count is 91 TypeScript specs and 19 Python test modules. Counts below are authored declaration counts from `test(...)`/`def test_*`, not expanded runtime cases; loops/parameterized tests can generate substantially more cases (for example, native-option and fixture matrix suites). Classification is one primary category per runnable test file. **D** identifies a newer duplicate assertion, **U** identifies a unique regression/boundary; where neither is called out, this audit found no known newer duplicate and no individually identified hard-won regression. **B/M** is real browser/MCP execution (mock-only means No); **S1** is the recommended `--workers=1` setting; **P** means safe parallel execution in the proposed group. For mixed files, retain U cases and consolidate D cases. Dispositions are recommendations; no cleanup is performed here.

## Current route map: `deferred-action-v1`

| Capability / invariant | Minimum retained evidence | Why it remains a hard gate |
|---|---|---|
| Source interpretation and admission | `deferred-action-goal-v2-wp1a`, `deferred-action-interpretation-v2-wp1b`, `deferred-action-interpretation-wp1-gate`, production WP5A cases | Two independent source-first extractions; complete authored obligations, structural validity, semantic agreement, ambiguity/unsupported distinction; no browser authority from model output. |
| Exact source canonicalization | `deferred-offsetless-source-reconstruction`, active v9/v5 coverage in interpretation and diagnostics suites | Exact ordered reconstruction including CRLF, UTF-16, repeated text, punctuation and source ownership; no search, trimming, source repair or cross-version fallback. |
| Extraction deadline / retry | `deferred-extraction-deadline-hardening`, `deferred-extraction-retry` | Deadline origin and late completion attribution; full independent phase allowance; exactly bounded retry for completed malformed JSON only; valid-JSON semantic/structural errors do not retry; authenticated restart/tamper and no public timing leakage. |
| Semantic disagreement | WP1 v2 suite, WP1 gate, WP5A integration | Independent extraction must disagree/reject before grounding; distinguish disagreement from malformed, ambiguity, unsupported, timeout and provider stops. |
| Candidate uniqueness / ownership | WP2A–D plus WP5A integration | Only unique eligible candidate is actionable; zero/multiple candidate and name/label/native ownership ambiguity stop before mutation. Keep a compact protected integration case in addition to pure matching contracts. |
| Native option ownership/value mapping | `native-owned-option-verification`, `native-option-verification-source`, WP2 execution and WP5A | Native `<select>` selected value comes from trusted option ownership/mapping; browser `value` is not invented as a DOM locator; preserve checkbox/radio and option-specific behavior. |
| Label association | Native owned-option and WP2 candidate tests; WP5A Country-owned label integration | Correct label/control relation is proven for nested and `for` labels; nearest/form ownership avoids another label or control stealing the mapping. |
| Action execution and witness | WP2C, WP2D-A/B, WP5A | Actual protected runtime decision/action/consequence produces runtime-owned witness; rejected/failing/recovery branches cannot enter the successful trace. |
| Trace v5 | WP2C/D, WP3A/B, WP5A persistence/restart cases | Exact accepted success facts and witnesses persist immutably/authentically; only actual trace readback can authorize compilation. |
| Compiler v4 / resolved v9 | WP3A/B, WP4A/B, WP5A | Fresh protected reconstruction validates obligation-to-target/effect correspondence and persists attempt; rejected compilation issues no v9. Keep version/mapping drift and persistence failures. |
| Deterministic runner v9 | WP4B and WP5A | Executes accepted v9 without LLM/MCP repair; complete guard, exact retained node and fresh effect proof; stop/cleanup are non-QA. |
| VerificationGoal selected-option capability | native owned option verification and WP5A | Selected-option assertion is a supported capability with proven label/control/option mapping; verify true/false and stale/fresh mapping behavior. |
| Two-replay agreement | WP4B and WP5A | Distinct fresh contexts/runs; corresponding observation agreement yields QA only for completed true/false; disagreement, zero assertions, runner or cleanup uncertainty remain non-QA. |
| Persistence and authentication | WP3B / WP4B / WP5A plus Python deferred module | Authenticated trace/compiler/replay readback, restart in a fresh process, tamper rejection and exact result re-derivation. This was a real WP4B test gap that was repaired; preserve it. |
| Node/Python/UI projection | Node external/projection suites; `test_deferred_workflow_wp5a.py`, `test_agentic_external_v2.py`, focused Python host/projection/UI suites | Closed exact wire parity, safe field projection, gated trusted selection, no task-based route selection/fallback, assertion-free execution labelled non-QA. |
| Route isolation | WP5A production and historical external/projection suites | Deferred v1 cannot enter agentic/legacy/goal-directed/structured stores, readers, projectors or routes; old families cannot silently accept newer artifacts. |

### Duplicated assertions across WP1–WP5

The WP suites are useful as design history and contain substantial edge-specific assertions, but the current broad all-spec run repeats several cross-cutting checks. Consolidate the routine current gate around **one focused interpretation/source group, one grounding-to-witness group, one compiler/replay group and one production/persistence/projection group**. Keep unit-level version/schema/parser checks in parallel, and retain only these cross-stage end-to-end repetitions:

- TestSpec/admission source digest, workflow gate and no-fallback checks repeat in WP1, independent-gate, WP5A, CLI and Python host suites. One primary test per Node admission/production boundary plus one Python host/UI parity test is sufficient; preserve malformed provider and route isolation cases.
- Candidate eligibility, uniqueness and label/option mapping recur in WP2A/B/C/D and WP5A. Retain pure cases for distinct matcher boundaries, and one protected integration for multiple dropdowns, label ownership, action-before-compile prevention and selected option.
- Witness/trace field validity and source/effect correspondence recur across WP2C/D, WP3A/B and WP4A. Keep each layer's authority transition and negative provenance check; consolidate repeated shape assertions that prove no additional layer-specific invariant.
- Compiler rejection/no v9 and runner stop/no QA recur in WP3/WP4/WP5 suites. Keep compiler issuance authority in compiler tests and QA classification/agreement in runner/pair tests; production should prove capability continuity and one representative failure per stop class.
- Authenticated readback, tamper checks, safe projection and no private data repeat across Node stores/projectors, subprocess CLI, Python contract and UI tests. Retain one restart boundary test, one tamper test per independent store family, Node/Python parity, and one UI projection test.
- Historical WP1–WP4 milestone suites for goal-directed and structured-action families currently repeat much of the same trace/compiler/runner/pair invariants now tested by deferred-action-v1. They should no longer be in routine current integration. Keep compact sentinels for own-reader compatibility, newer-artifact rejection, selector isolation and no fallback.

## TypeScript Playwright inventory

| File (approx. tests) | Behavior / D / U | B/M | S1 | P | Category and disposition |
|---|---|---:|---:|---:|---|
| `tests/deferred-action-goal-v2-wp1a.spec.ts` (22) | Active ActionGoal v2 source and obligation contracts; D: some admission cases recur in WP1B/WP5A; U: closed source/accounting edges. | No | No | Yes | **FAST_CURRENT** — retain; trim duplicate ordinary-schema assertions. |
| `tests/deferred-action-interpretation-v2-wp1b.spec.ts` (20) | Active primary/independent extraction and semantic admission; D: source failures recur in gate/production; U: phase/category matrix. | No | No | Yes | **FAST_CURRENT** — retain key phase distinctions and disagreement. |
| `tests/deferred-action-interpretation-wp1b.spec.ts` (14) | Earlier provider-wire/source contract; newer v2/v9 formats supersede active wire assertions. | No | No | Yes | **HISTORICAL_SENTINEL** — reduce to own old-reader acceptance and rejection by current reader. |
| `tests/deferred-action-interpretation-wp1-gate.spec.ts` (2) | Interpretation offline gate sentinels. D: overlaps WP1B; U: independent gate boundary. | No | No | Yes | **FAST_CURRENT** — retain only gate/isolation assertions. |
| `tests/deferred-action-grounding-wp1-v2-independent-gate.spec.ts` (5) | Historical WP1 v2 independent contract gate and prior-wire acceptance. | No | No | Yes | **HISTORICAL_SENTINEL** — compact old artifact readable by its version only. |
| `tests/deferred-offsetless-source-reconstruction.spec.ts` (12) | Exact full-source reconstruction, UTF-16/CRLF/repeats, native ownership and active v9/v5 forward-only derivation; D: a few invalid cases overlap general validators; U: hard-won source regressions. | No | No | Yes | **FAST_CURRENT** — preserve all unique source-fidelity regressions. |
| `tests/deferred-extraction-deadline-hardening.spec.ts` (9) | Deadline phase attribution, late completion and independent allowance; D: some retry timing setup; U: real timeout regression. | No | No | Yes | **FAST_CURRENT** — preserve. |
| `tests/deferred-extraction-retry.spec.ts` (11) | Malformed provider JSON retry, retry boundaries, authenticated attempts/restart; D: generic provider failure checks elsewhere; U: malformed JSON and retry policy. | No | No | Yes | **FAST_CURRENT** — preserve. |
| `tests/deferred-structural-diagnostics.spec.ts` (4) | Structural failure taxonomy and restricted diagnostics; D: some source cases; U: diagnostic category/public projection boundary. | No | No | Yes | **FAST_CURRENT** — retain compact taxonomy/leak checks. |
| `tests/deferred-action-grounding-wp2a.spec.ts` (16) | Candidate discovery/ownership contracts; D: uniqueness/label cases in later WP2/WP5; U: candidate set derivation. | Yes (protected local browser/MCP) | Yes | No | **CONSOLIDATE** — keep pure distinct matching and source-owner failures; move repeated integration assertions out. |
| `tests/deferred-action-grounding-wp2b.spec.ts` (18) | Runtime candidate bindings/current state; D: stale/unique behavior repeats WP2C/D; U: binding provenance. | Yes (protected local browser/MCP) | Yes | No | **CONSOLIDATE** — preserve current-state/stale binding unique cases. |
| `tests/deferred-action-grounding-wp2c.spec.ts` (22) | Protected action execution and witnesses; D: witness shape repeats WP2D/WP5; U: runtime-origin authority. | Yes | Yes | No | **CONSOLIDATE** — preserve runtime witness and failed-action cases; remove repeat shape matrix. |
| `tests/deferred-action-grounding-wp2d-a.spec.ts` (19) | Bounded execution controller; D: successful action cases repeated in D-B/WP5; U: selection/execution ordering. | Yes | Yes | No | **CONSOLIDATE** — retain order, budget and rejected action boundaries. |
| `tests/deferred-action-grounding-wp2d-b.spec.ts` (27) | Action/witness/verification execution; D: many cases recur in WP5A; U: exact witness ownership/strategy edges. | Yes | Yes | No | **CONSOLIDATE** — keep unique VerificationGoal and witness regressions, one end-to-end sample. |
| `tests/deferred-action-grounding-wp2-independent-gate.spec.ts` (4) | Historical WP2 gate and route-version isolation. D: WP2 suites cover behavior; U: gate/fallback boundary. | No | No | Yes | **HISTORICAL_SENTINEL** — reduce to gate and route version checks. |
| `tests/deferred-action-grounding-wp3a.spec.ts` (17) | Trace v5 assembly inputs/invariants; D: assembly validity repeated WP3B/WP5; U: successful facts only and witness provenance. | Yes (protected local browser/MCP) | Yes | No | **CONSOLIDATE** — keep unique trace-authority cases. |
| `tests/deferred-action-grounding-wp3b.spec.ts` (16) | Immutable trace v5 store/readback; D: tamper/restart overlaps WP4B/WP5; U: trace authentication origin. | Yes (protected local browser/MCP) | Yes | No | **CONSOLIDATE** — retain one authenticated trace readback/tamper set. |
| `tests/deferred-action-grounding-wp4a.spec.ts` (13) | Compiler v4 attempt/resolved v9 contracts and rejection; D: repeated WP4B/WP5; U: no v9 on rejected compile. | Yes (protected local browser) | Yes | No | **CONSOLIDATE** — preserve issuance/rejection and mapping-drift cases. |
| `tests/deferred-action-grounding-wp4b.spec.ts` (9) | Fresh compiler and authenticated resolution; D: compiler integration repeated WP5; U: fresh context and capability continuity. | Yes | Yes | No | **CURRENT_INTEGRATION** — retain as compiler integration focused group. |
| `tests/deferred-action-production-wp5a.spec.ts` (8) | Current full Node workflow, retries, route gate, replay persistence/readback and safe projection. D: component behavior appears in WP suites; U: cross-stage capability continuity and authenticated restart. | Yes | Yes | No | **CURRENT_INTEGRATION** — retain; primary deferred integration. |
| `tests/deferred-action-goal-wp1a.spec.ts` (11) | Early v1 ActionGoal reader/contracts. Superseded by v2 admission. | No | No | Yes | **HISTORICAL_SENTINEL** — own-reader accepts old artifact, active v2 path rejects it. |
| `tests/native-option-verification-source.spec.ts` (9) | Native option source/control association; D: label/value behavior in native-owned suite; U: authored-source provenance. | No | No | Yes | **FAST_CURRENT** — keep source-to-option/control regressions. |
| `tests/native-owned-option-verification.spec.ts` (12) | Selected state, native labels, trusted value mapping, fresh mapping drift and restart; D: some label tests in WP2/WP5; U: selected-option capability and real failure regressions. | Yes (protected fixture) | Yes | No | **CURRENT_INTEGRATION** — retain focused native verification group. |
| `tests/agentic-cli-v2.spec.ts` (2) | Agentic v2 CLI boundary, terminal/selection compatibility. D: production suite; U: CLI process boundary. | No | No | Yes | **HISTORICAL_SENTINEL** — retain small v2 reader/route isolation cases. |
| `tests/agentic-controller-wp2c.spec.ts` (12) | Released agentic M7 controller; deferred route supersedes behavior for routine active workflow. | No (mock only) | No | Yes | **HISTORICAL_SENTINEL** — retain protocol/controller compatibility and no cross-route selection. |
| `tests/agentic-current-state-wp2a.spec.ts` (14) | Released agentic current-state binding. D: active deferred tests exercise analogous capability; U: v2 baseline compatibility. | No (mock only) | No | Yes | **HISTORICAL_SENTINEL** — compact accepted/rejected v2 binding artifact tests. |
| `tests/agentic-domain-contracts-wp1.spec.ts` (7) | Released TestSpec v2 and agentic schemas. D: generic domain contracts; U: v2 parser compatibility. | No | No | Yes | **HISTORICAL_SENTINEL** — parser-own-artifact and newer rejection. |
| `tests/agentic-exploration-wp2-release.spec.ts` (9) | Released exploration route gate; D: controller/production; U: release workflow selection. | No (mock only) | No | Yes | **HISTORICAL_SENTINEL** — route-selection and no fallback only. |
| `tests/agentic-external-v2.spec.ts` (5) | Node ResultRecordV2/projection boundary; D: some Python parity; U: Node external contract. | No | No | Yes | **CURRENT_INTEGRATION** — retain cross-family and safe-projection contract. |
| `tests/agentic-production-wp4b.spec.ts` (10) | Released agentic production orchestration. D: active route and route sentinels; U: released v2 compatibility. | Yes | Yes | No | **HISTORICAL_SENTINEL** — one workflow acceptance and isolation sentinel; remove duplicate scenarios. |
| `tests/agentic-trace-assembly-wp2b.spec.ts` (7) | Agentic trace v2 assembly. D: v2 trace contracts; U: own trace construction compatibility. | No | No | Yes | **HISTORICAL_SENTINEL** — retain parser/assembler compatibility. |
| `tests/agentic-trace-compiler-wp3.spec.ts` (14) | Agentic compiler v1/v6 and identity checks; D: current compiler exercises analogous behavior; U: old artifact reader/compiler compatibility. | No (synthetic fixture) | No | Yes | **HISTORICAL_SENTINEL** — own v6 accepted; v9 rejected by older compiler. |
| `tests/agentic-trace-contracts-v2.spec.ts` (5) | Trace v2 own schema/parser. D: assembly tests; U: version acceptance isolation. | No | No | Yes | **HISTORICAL_SENTINEL** — retain compact parser sentinel. |
| `tests/goal-directed-verification-wp1.spec.ts` (8) | Goal-directed TestSpec v4/VerificationGoal schema. D: newer selected option, active TestSpec differs; U: v4 parser history. | No | No | Yes | **HISTORICAL_SENTINEL** — own reader and no deferred upgrade. |
| `tests/goal-directed-observation-wp2.spec.ts` (7) | Private observation result v1. Historical route behavior. | No (synthetic fixture) | No | Yes | **HISTORICAL_SENTINEL** — reader acceptance and cross-version refusal. |
| `tests/goal-directed-verification-wp3a.spec.ts` (9) | Historical M7 verification strategy controller. D: deferred WP2D; U: v3 route compatibility. | No (synthetic fixture) | No | Yes | **HISTORICAL_SENTINEL** — narrow versioned strategy sentinel. |
| `tests/goal-directed-trace-wp3b-a.spec.ts` (11) | Goal-directed trace v3 assembly. D: trace v5 structure; U: v3 reader/assembler. | No | No | Yes | **HISTORICAL_SENTINEL** — own artifact acceptance only. |
| `tests/goal-directed-trace-wp3b-b.spec.ts` (18) | Goal-directed trace v3 storage/readback. D: v5 auth store; U: v3 store isolation. | No | No | Yes | **HISTORICAL_SENTINEL** — retain own version auth/readback sentinel. |
| `tests/goal-directed-compiler-wp4a.spec.ts` (7) | Compiler v2/resolved v7 contracts. D: v4/v9; U: older reader compatibility. | No (synthetic fixture) | No | Yes | **HISTORICAL_SENTINEL** — v7 accepted by v2; v9 rejected. |
| `tests/goal-directed-runner-wp5a.spec.ts` (7) | Deterministic runner v7. D: v9 runner; U: no newer input accepted. | No (synthetic fixture) | No | Yes | **HISTORICAL_SENTINEL** — own resolved family accepted and v9 refused. |
| `tests/goal-directed-production-wp5b.spec.ts` (9) | Historical production route selection/orchestration. D: WP5A; U: no fallback and no cross-family terminal. | Yes | Yes | No | **HISTORICAL_SENTINEL** — shrink to isolation/selection. |
| `tests/structured-action-identity-wp1.spec.ts` (8) | TestSpec v5/action identity interpretation contract. Superseded active v6 ActionGoal. | No | No | Yes | **HISTORICAL_SENTINEL** — own v5 reader and deferred refusal. |
| `tests/structured-action-identity-wp2.spec.ts` (12) | Action identity witness/trace v4. D: deferred v5 witness; U: old trace contract compatibility. | No (synthetic fixture) | No | Yes | **HISTORICAL_SENTINEL** — preserve old reader only. |
| `tests/structured-action-identity-wp4a.spec.ts` (9) | Runner v8 identity checks. D: v9; U: v8 parser isolation. | No (synthetic fixture) | No | Yes | **HISTORICAL_SENTINEL** — own artifact accepted, v9 refused. |
| `tests/structured-action-identity-wp4b.spec.ts` (10) | Structured route orchestration and source/dist selection; D: deferred WP5A; U: source/dist singleton boundary and cross-route ambiguity refusal. | Yes | Yes | No | **HISTORICAL_SENTINEL** — keep child-process route-selection regression; remove repeated workflow path. |
| `tests/openai-live-p2-1d.spec.ts` (4) | Credentialed P2 interpretation calls guarded by `P2_1_OPENAI_LIVE`; not a deferred-action live suite. | Yes (live provider) | No | No | **LIVE_PROVIDER** — explicit opt-in legacy tier; never ordinary npm test. |
| `tests/deferred-action-live-interpretation.spec.ts` (4) | New deferred primary/source-first extraction, semantic admission and exact five-step live source; every test checks `PLAYWRIGHT_DEMO_LIVE_LLM_TESTS=1`. | Yes (live provider) | No | No | **LIVE_PROVIDER** — invoke only through the explicit gated live wrapper; stops before browser execution. |
| `tests/local-release-p2-2e.spec.ts` (4) | Legacy headed/live release path guarded by P2-2 live flag. | Yes (provider and browser) | Yes | No | **LIVE_PROVIDER** — manual/explicit legacy live tier only. |
| `tests/openai-wire-p2-1a.spec.ts` (6) | Legacy OpenAI wire schema/parser. D: active strict wire assertions; U: v1 wire reader. | No | No | Yes | **HISTORICAL_SENTINEL** — parser accepts own wire, rejects wrong-family data. |
| `tests/openai-responses-p2-1b.spec.ts` (11) | OpenAI Responses transport, allowlist and timeout behavior. D: deferred strict format coverage; U: transport allowlist/retry transport failures. | No | No | Yes | **CONSOLIDATE** — preserve shared transport boundary and current deferred format allowlist; remove redundant response-shape checks. |
| `tests/openai-adapters-p2-1c.spec.ts` (5) | Legacy adapter translation. D: current adapter tests; U: legacy mapping. | No | No | Yes | **HISTORICAL_SENTINEL** — reader/adapter compatibility. |
| `tests/local-command-p2-2d.spec.ts` (5) | Legacy CLI args/process invocation. D: current subprocess tests; U: CLI public compatibility. | No | No | Yes | **HISTORICAL_SENTINEL** — keep command invocation smoke test. |
| `tests/local-contracts-p2-2a.spec.ts` (6) | Legacy local contract schemas. D: current closed contracts; U: legacy parser. | No | No | Yes | **HISTORICAL_SENTINEL** — parser compatibility only. |
| `tests/local-headed-p2-2c.spec.ts` (4) | Legacy headed observational path. D: P4 viewer tests; U: headed/autonomy separation. | Yes (local headed browser) | Yes | No | **HISTORICAL_SENTINEL** — one no-autonomous-eligibility sentinel. |
| `tests/local-workflow-p2-2b.spec.ts` (8) | Legacy workflow composition. D: subprocess/agentic suites; U: v1 contract separation. | No (mock fixture) | No | Yes | **HISTORICAL_SENTINEL** — route isolation smoke only. |
| `tests/subprocess-protocol-p2-3a.spec.ts` (5) | Legacy subprocess v1 protocol. D: Python protocol; U: Node v1 closed parser. | No | No | Yes | **HISTORICAL_SENTINEL** — v1 reader and v2 rejection. |
| `tests/subprocess-entry-p2-3b.spec.ts` (5) | Legacy Node subprocess v1 entry. D: v2 CLI tests; U: old entry boundary. | No (child process only) | No | Yes | **HISTORICAL_SENTINEL** — one process-level legacy envelope test. |
| `tests/report-projection-p3b.spec.ts` (4) | Legacy v1 safe projection. D: v2 projection; U: v1 contract. | No | No | Yes | **HISTORICAL_SENTINEL** — v1 own projection and newer-family refusal. |
| `tests/subprocess-cancellation-p4-2.spec.ts` (3) | Child cancellation/cleanup contract; D: WP5A cancellation; U: generic subprocess supervision. | No (child process only) | No | Yes | **CURRENT_INTEGRATION** — keep one cancellation/cleanup bridge regression. |
| `tests/public-admission-p3a.spec.ts` (5) | Legacy admission URL/policy contract. D: current deferred trusted gate; U: public authority baseline. | No | No | Yes | **HISTORICAL_SENTINEL** — retain approval/policy rejection boundary. |
| `tests/public-admission-runtime-p3a.spec.ts` (3) | Admission runtime/DNS pins. D: config runtime; U: resolution pinning. | No (network mocked) | No | Yes | **CURRENT_INTEGRATION** — retain pin/TOCTOU invariant. |
| `tests/public-admission-config-runtime-p3f.spec.ts` (5) | Public admission config load/deny behavior. D: p3a; U: trusted config isolation. | No | No | Yes | **CONSOLIDATE** — one configured target and one reject/no-authority case. |
| `tests/public-browser-container-g1.spec.ts` (2) | Container mount/egress/management isolation. U: security boundary. | Docker/browser | Yes | No | **CURRENT_INTEGRATION** — release/security tier, not routine fast. |
| `tests/public-browser-node-g1.spec.ts` (5) | Browser container node/runtime isolation. D: container tests; U: protected launch restrictions. | Docker/browser | Yes | No | **CONSOLIDATE** — keep unique runtime enforcement cases in release group. |
| `tests/public-browser-public-profile-g1.spec.ts` (10) | Protected profile/browser policy. D: challenging DOM profile suite; U: profile authority. | Browser/container | Yes | No | **CONSOLIDATE** — merge duplicate profile cases, preserve network isolation. |
| `tests/public-run-environment-g1.spec.ts` (1) | Runtime environment stop classification. U: automation/environment stop is non-QA. | Browser/container | Yes | No | **CURRENT_INTEGRATION** — retain. |
| `tests/public-target-a.spec.ts` (4) | Historical target smoke/approval prerequisites. D: target qualification; U: explicit target authority. | Public browser | Yes | No | **HISTORICAL_SENTINEL** — replace broad live behavior with config/approval sentinel. |
| `tests/public-challenging-dom-qualification.spec.ts` (3) | Public target qualification. D: release-prep and DOM profile tests; U: target qualification evidence. | Public browser | Yes | No | **HISTORICAL_SENTINEL** — qualification only when target is explicitly approved. |
| `tests/public-challenging-dom-approval.spec.ts` (4) | Approval decision boundary. D: public admission; U: target-specific approval. | Public browser | Yes | No | **CONSOLIDATE** — keep no approval bypass and approved target check. |
| `tests/public-challenging-dom-public-profile-g1.spec.ts` (10) | Protected profile on challenging DOM. D: generic profile; U: target-specific incompatibility. | Browser/container | Yes | No | **CONSOLIDATE** — only unique target-specific network/cleanup assertions. |
| `tests/public-challenging-dom-release-prep.spec.ts` (2) | Historical release preparation. D: qualification and approval; likely no unique runtime contract. | Public browser | Yes | No | **DELETE_CANDIDATE** — after verifying no standalone external gate depends on it. |
| `tests/public-cloudflare-diagnostic-policy.spec.ts` (3) | Cloudflare challenge stop and diagnostic policy. D: environment stop coverage; U: challenge never becomes QA failure. | Public browser | Yes | No | **HISTORICAL_SENTINEL** — retain one blocked/challenge stop classification. |
| `tests/public-columbia-survey.spec.ts` (2) | Historical external target survey flow. D: generic workflow; U: no identified supported unique regression; verify approved-target inventory. | Public browser | Yes | No | **DELETE_CANDIDATE** — remove unless current approved target inventory identifies it as a supported contract. |
| `tests/public-link-collection-c.spec.ts` (5) | Link collection public-target run; older route. D: active selected-option and route; U: external capability smoke only. | Public browser | Yes | No | **HISTORICAL_SENTINEL** — stop treating as current regression; keep only if external capability remains supported. |
| `tests/public-web-cross-boundary-harness.spec.ts` (2) | Node-to-Python public web test harness. D: Python cross-boundary test; U: source/dist harness isolation. | No (child process only) | No | Yes | **CONSOLIDATE** — preserve separate-process boundary, avoid duplicating assertions in Python. |
| `tests/public-browser-headed-runtime-p4-3a.spec.ts` (4) | Headed container/viewer runtime isolation. D: P4 viewer tests; U: no control and observational-only. | Browser/container | Yes | No | **HISTORICAL_SENTINEL** — retain headed autonomy boundary. |
| `tests/live-events-p4-1a.spec.ts` (7) | Legacy event stream contracts/runtime; agentic P4 unavailable. D: Python event tests; U: Node sanitizer contract. | No | No | Yes | **HISTORICAL_SENTINEL** — parser/sanitizer and agentic-route isolation only. |
| `tests/live-images-p4-2a.spec.ts` (7) | Legacy image transport/limits. D: Python image tests; U: Node bounded image contract. | No | No | Yes | **HISTORICAL_SENTINEL** — reader/version and no-v2-channel sentinel. |
| `tests/live-viewer-p4-3b.spec.ts` (3) | Legacy viewer auth/view-only contract. D: runtime/UI; U: viewer cannot control browser. | Yes (local browser/UI) | Yes | No | **HISTORICAL_SENTINEL** — keep view-only boundary. |
| `tests/live-viewer-runtime-p4-3b.spec.ts` (4) | Legacy viewer runtime. D: viewer contract and Python UI; U: lifecycle/auth boundary. | Browser/container | Yes | No | **CONSOLIDATE** — one runtime auth/cleanup path in release tier. |
| `tests/project-env.spec.ts` (2) | `.env` parsing and precedence. D: Python env; U: Node startup env behavior. | No | No | Yes | **FAST_CURRENT** — retain current provider gate/env safety checks. |
| `tests/profile-m3.spec.ts` (6) | Profile fingerprint/policy. D: public profile tests; U: profile identity/fingerprint. | No | No | Yes | **CONSOLIDATE** — keep pure fingerprint contract, remove duplicated browser setup. |
| `tests/operational-controls-m8b.spec.ts` (6) | Cancellation, timeout, cleanup and typed stop controls. D: WP5A cancellation; U: generic operational control. | No (synthetic fixture) | No | Yes | **CONSOLIDATE** — keep stop taxonomy not already proved by integration. |
| `tests/system-regression-m8a.spec.ts` (5) | Cross-system invariants and no QA on automation/environment stop. D: route/production checks; U: broad invariant crosswalk. | No (synthetic fixture) | No | Yes | **CURRENT_INTEGRATION** — retain smallest high-level authority/stop smoke. |
| `tests/step-orchestration-m7b.spec.ts` (10) | Legacy action orchestration. D: deferred WP2; U: released-route compatibility. | Yes (local browser fixture) | Yes | No | **HISTORICAL_SENTINEL** — retain one old route accepted/no deferred fallback test. |
| `tests/handoff-m7c.spec.ts` (5) | Legacy handoff/deadline boundary. D: deferred deadlines; U: old typed stop compatibility. | No (synthetic fixture) | No | Yes | **HISTORICAL_SENTINEL** — compact old error mapping. |
| `tests/interpretation-m7a.spec.ts` (4) | Legacy interpretation validation. D: current WP1; U: legacy mapping. | No | No | Yes | **HISTORICAL_SENTINEL** — own-version parser only. |
| `tests/m6-mcp.spec.ts` (19) | Legacy MCP allowlist/session behavior. D: active protected session; U: MCP tool/network safety boundary. | No (mock only) | No | Yes | **HISTORICAL_SENTINEL** — retain allowed-tool and page-untrusted checks, consolidate repeated snapshots. |
| `tests/locator-contracts.spec.ts` (11) | Shared locator parsing/quality/uniqueness. D: WP2 candidate mapping; U: foundational locator grammar shared by routes. | No | No | Yes | **FAST_CURRENT** — keep core locator contract; deduplicate assertions mirrored in route suites. |
| `tests/runner-m4.spec.ts` (6) | Legacy runner v2–v5 behavior. D: v9 runner; U: historical resolved reader. | No (synthetic fixture) | No | Yes | **HISTORICAL_SENTINEL** — own version accepts, v9 refuses. |
| `tests/evidence-m5.spec.ts` (4) | Legacy evidence store/report behavior. D: current authenticated stores; U: legacy artifact compatibility. | No | No | Yes | **HISTORICAL_SENTINEL** — reader isolation/tamper sentinel. |
| `tests/domain-contracts.spec.ts` (13) | Shared older domain contracts. D: active v2 schemas, U: cross-version legacy schemas. | No | No | Yes | **CONSOLIDATE** — retain only schema-family dispatch and current invariants. |

The TypeScript inventory has one row for each runnable spec path; cross-references in capability and duplication sections are not additional classifications.

## Python test inventory

| File (approx. methods) | Behavior / D / U | B/M | S1 | P | Category and disposition |
|---|---|---:|---:|---:|---|
| `tests/python/test_deferred_workflow_wp5a.py` (7) | Deferred host/protocol/deferred stage/UI selection and safe projection; D: Node external tests; U: Python trusted-host boundary. | No | No | Yes | **CURRENT_INTEGRATION** — retain. |
| `tests/python/test_agentic_external_v2.py` (10) | Python protocol/projection ResultRecordV2 and deferred-family validation; D: deferred module; U: exact host boundary parity. | No | No | Yes | **CURRENT_INTEGRATION** — retain closed-contract parity. |
| `tests/python/test_report_projection_p3b.py` (5) | Legacy v1 projection parser. D: Node projection; U: Python v1 consumer. | No | No | Yes | **HISTORICAL_SENTINEL** — own projection accepted/newer rejected. |
| `tests/python/test_subprocess_host.py` (10) | Python host supervision, admission, cancellation and workflow selection; D: newer deferred host module; U: general host safety. | No | No | Yes | **CURRENT_INTEGRATION** — retain host trust and no-task-route-selection. |
| `tests/python/test_subprocess_release_p2_3d.py` (4) | Legacy v1 subprocess protocol/release, may include `P2_3_LIVE`; default tests must preserve the skip unless explicitly opted in. | Yes if live gate set; offline No | No (offline) | Yes | **HISTORICAL_SENTINEL** — split/guard live case; retain v1 parser and cross-version refusal. |
| `tests/python/test_public_web_cross_boundary.py` (1) | Node/Python harness boundary; source/dist subprocess lifecycle. D: TS harness; U: Python orchestration. | No (child process only) | No | Yes | **CURRENT_INTEGRATION** — one boundary smoke. |
| `tests/python/test_public_web_live.py` (1) | Explicit public-web real run guarded by `PUBLIC_WEB_LIVE`; separate from provider. | Public browser | Yes | No | **LIVE_PROVIDER** — classify in live/environment tier; do not include routine. |
| `tests/python/test_semantic_locator_status_codes_live.py` (1) | Public target plus live semantic/provider flow guarded by `SEMANTIC_LOCATOR_STATUS_CODES_LIVE`. | Yes (provider and browser) | Yes | No | **LIVE_PROVIDER** — legacy live tier only. |
| `tests/python/test_ui_workflow_p3d.py` (11) | Streamlit workflow, host dispatch and safe outcomes. D: deferred UI; U: legacy UI routing. | AppTest | No | Yes | **CONSOLIDATE** — retain representative workflow/no-fallback and non-QA rendering; remove duplicate widget paths. |
| `tests/python/test_ui_shell_p3c.py` (7) | UI safe field rendering and outcome labels. D: deferred UI tests; U: shell projection. | AppTest | No | Yes | **CURRENT_INTEGRATION** — keep exact field exclusion/non-QA smoke. |
| `tests/python/test_phase3_regression_p3e.py` (3) | Historical Phase 3 cross-boundary regressions. D: host/projection/UI suites; U: named old regression evidence. | AppTest | No | Yes | **HISTORICAL_SENTINEL** — retain only uncovered contract check. |
| `tests/python/test_project_env.py` (4) | Python `.env` load/precedence. D: Node env; U: Python startup config. | No | No | Yes | **FAST_CURRENT** — retain live-gate isolation. |
| `tests/python/test_live_events_p4_1b.py` (11) | Legacy event sanitization/wire types. D: TS event tests; U: Python parser. | No | No | Yes | **HISTORICAL_SENTINEL** — compact own-version reader. |
| `tests/python/test_live_event_release_p4_1c.py` (6) | Legacy event release parity. D: prior event module; U: cross-boundary version pairing. | No | No | Yes | **CONSOLIDATE** — merge unique parity assertions into event sentinel. |
| `tests/python/test_live_images_p4_2b.py` (10) | Legacy image bounds/validation. D: TS image tests; U: Python consumer. | No | No | Yes | **HISTORICAL_SENTINEL** — own version and size/sanitization sentinel. |
| `tests/python/test_live_image_release_p4_2c.py` (3) | Legacy image release parity. D: image tests; U: route separation. | No | No | Yes | **CONSOLIDATE** — merge one pairing/refusal assertion. |
| `tests/python/test_live_viewer_p4_3b.py` (5) | Legacy viewer authorization/view-only contract. D: TS viewer; U: Python viewer check. | No | No | Yes | **HISTORICAL_SENTINEL** — retain view-only authorization. |
| `tests/python/test_live_viewer_release_p4_3b.py` (2) | Legacy viewer release compatibility. D: viewer module; U: little unique behavior. | No | No | Yes | **DELETE_CANDIDATE** — after preserving viewer-auth and no-control assertions elsewhere. |
| `tests/python/test_live_viewer_ui_p4_3c.py` (8) | Legacy viewer UI rendering/security fields. D: shell/UI tests; U: viewer UI boundary. | AppTest | No | Yes | **HISTORICAL_SENTINEL** — one safe view-only UI smoke. |

### Non-test support files

These are not runnable test modules/specs and therefore are not assigned one of the six categories: `tests/fixtures/domain.ts`, `tests/helpers/action-v2-fixtures.ts`, `tests/helpers/deferred-v3-wire.ts`, `tests/helpers/deferred-v9-fixtures.ts`, `tests/python/mock_child.py`, and `tests/python/cancel_child.cjs`. They should be inventoried with their consuming suites before consolidation; preserve shared fixture semantics and child-process cancellation helpers while any consumer remains. `.gitkeep`, Python bytecode and `__pycache__` are not test sources.

## Proposed deletions and consolidations

No deletion was made in this audit. These are three whole-file deletion candidates, contingent on confirming no active release command treats the file as its sole evidence and first moving any unique boundary assertion into a retained test:

| Candidate | Why it can go | Required prerequisite |
|---|---|---|
| `tests/public-challenging-dom-release-prep.spec.ts` | Two release-preparation cases overlap target qualification and approval suites and do not define a current route invariant. | Keep target approval and environment-stop evidence in current public-admission/release coverage. |
| `tests/public-columbia-survey.spec.ts` | Two target-specific survey-flow cases have no identified current supported external contract; the workflow is covered by generic route integration. | Check the current approved-target inventory/release procedure. If the target remains a supported acceptance contract, retain one explicit compatibility sentinel instead of deleting. |
| `tests/python/test_live_viewer_release_p4_3b.py` | Two Python viewer release-parity methods duplicate the viewer auth/view-only contracts in Python and Node UI tests. | Preserve one Python auth/no-control assertion in `test_live_viewer_p4_3b.py` or `test_live_viewer_ui_p4_3c.py`. |

Consolidation sequence:

1. **WP1:** keep `deferred-action-goal-v2-wp1a`, active v2 interpretation, source reconstruction, deadline, retry, structural diagnostics and one explicit admission gate. Reduce prior v1 and v2-gate suites to version/read/fallback sentinels; retain all named source/canonicalization regressions.
2. **WP2:** split pure candidate/ownership predicates from protected execution. Keep one candidate unique/non-unique matrix, one protected action/witness/label/selected-option path, and negative no-mutation-on-ambiguity. Consolidate repeated success, witness-shape and ordinary label assertions across WP2A–D/WP5A.
3. **WP3:** retain trace v5 authority transition, witness provenance, immutable authenticated readback and one tamper case. Remove repeated schema-shape checks already covered by the version parser.
4. **WP4:** retain compiler v4 acceptance/rejection and no-v9-on-rejection, fresh mapping drift, deterministic runner v9 no-LLM/MCP authority, cleanup uncertainty, and two-replay agreement. Move duplicate basic guard/assertion cases into focused unit groups.
5. **WP5 / external:** keep one actual orchestration path proving trusted capability continuity through pair persistence, fresh-process restart/readback, cancellation, safe projection and route no-fallback. Keep Python host/wire/UI contract parity. Remove repeated copies of the same pass/fail/no-QA examples from adjacent WP files after mapping each remaining assertion to a capability row above.

## Historical route strategy

Do not run full behavior suites for every still-readable route. The minimum compatibility matrix is one sentinel per independent external/artifact family and per materially separate trust boundary:

1. Released agentic v2 trace/compiler/resolved v6 and subprocess/report projection v2: each own reader accepts its own fixture; old readers reject trace v5/resolved v9/deferred terminal; trusted selector chooses only the configured family.
2. Legacy subprocess/report projection v1 and resolved v2–v5: v1 accepts its envelope, refuses v2-only fields; legacy runner accepts its own resolved fixture and refuses v6+/v9.
3. Goal-directed v4/v3/v7 and structured-action v5/v4/v8: one own-reader fixture and one newer deferred artifact rejection for each generation boundary; retain the structured source-versus-dist child-process regression because singleton duplicate registration was a real test harness defect.
4. P4 event/image/viewer are legacy observation contracts. Keep parser/sanitizer, auth/view-only, and no-agentic-terminal authority sentinels. Do not run full UI/runtime behavior for these in ordinary development.
5. Public admission/browser security is not merely historical behavior: retain compact URL/DNS pin, approval, isolation, cleanup, environment-stop and headed-observation release checks. Remove obsolete target-specific user-flow tests unless that exact target remains a supported contract.

For each family, keep: own reader accepts its own artifacts; newer artifacts are rejected; selection is trusted and isolated; no fallback is possible. A dozen behavioral cases per milestone are not justified solely by read compatibility.

## Hard-won regression inventory

Keep these tests even when consolidating their parent suites:

- **Deadline attribution / late completion / full independent allowance:** `deferred-extraction-deadline-hardening.spec.ts` (and matching retry suite phase cases).
- **Malformed provider JSON:** `deferred-extraction-retry.spec.ts`; malformed completed response gets the bounded fresh retry, while valid JSON structural/semantic failures do not.
- **Exact source reconstruction:** `deferred-offsetless-source-reconstruction.spec.ts`, including exact five-step task, UTF-16/CRLF/repeated text and no injected offsets.
- **Trusted span derivation:** same source reconstruction suite; canonical spans derive from ordered text reconstruction, not provider offsets/search.
- **Canonical source-text derivation:** reconstruction suite and active WP1 tests; obligations, anchors, option label/constraint text derive from trusted owned source segments.
- **Reciprocal ownership derivation:** active v9/v5 source reconstruction / WP1 tests; reverse segment ownership and step linkage derive from trusted forward refs; malformed forward refs still reject.
- **Selected-option verification:** `native-owned-option-verification.spec.ts`, `native-option-verification-source.spec.ts`, one WP5A protected integration case.
- **Compiler/replay mapping drift:** WP4A/B and WP5A; selected candidate mapping changes must stop rather than compile/replay against a different target.
- **Authenticated restart/readback:** deferred WP5A production suite plus `test_deferred_workflow_wp5a.py`; retain a fresh-process read and safe projection with exploration/MCP imports unavailable, plus tamper rejection.

## Live-provider tier

Create explicit gated live commands, excluded from `npm test`, `test:fast`, `test:current`, `test:compat` and release offline checks. `playwright.config.ts` calls `loadProjectEnv()`, so `.env` may populate `OPENAI_API_KEY`; that must not itself enable a provider test. Every live spec must check an additional explicit gate such as `PLAYWRIGHT_DEMO_LIVE_LLM_TESTS=1`, and no ordinary command may set that gate. Keep the existing independent flags (`P2_1_OPENAI_LIVE`, `P2_2_HEADED_LIVE`, `AGENTIC_EXPLORATION_STATUS_CODES_LIVE`, Python `PUBLIC_WEB_LIVE`, `SEMANTIC_LOCATOR_STATUS_CODES_LIVE`, `P2_3_LIVE`) opt-in; do not accidentally invoke them in ordinary group commands.

Recommended small deferred live interpretation suite, four to six cases, with explicit subcommand selection:

1. Primary extraction of the exact approved five-step source.
2. Independent extraction using only original source plus admitted obligations.
3. Semantic admission of both extractions, including a known disagreement control where test setup permits without excessive calls.
4. Exact five-step reconstruction/canonicalization check using safe digests/contract outcomes only.
5. Malformed/normalization diagnostics with a deterministic mocked malformed response where possible; reserve a real provider malformed-output case as best-effort diagnostic, not a routine release prerequisite.

Use a fake HTTP transport for malformed/normalization diagnostics in offline groups. Real live suite is a separately invoked, cost-bearing observation and should report environment/provider stops distinctly from QA failure. Require explicit `.env` credentials plus the gate; credentials alone never execute calls. Existing `openai-live-p2-1d`, `local-release-p2-2e`, and Python `*_live.py` modules stay outside all ordinary scripts.

## Parallelism and proposed groups

Current Playwright config already uses `workers: 2`; `npm test` discovers the entire 91-spec tree, while one historical `test:p3-e-offline` script forces the entire Playwright universe to `--workers=1`. The deferred WP5A procedure serialized integration because protected Chromium/proxy pairs, child processes and local resource limits may contend. Pure schema/parser/normalizer tests do not share those resources and can run with normal multiple workers.

Recommended explicit grouping:

- **Fast/pure**: current deferred WP1, exact reconstruction, deadline/retry/diagnostics, locator/domain, environment, strict OpenAI wire/adapter unit contracts. Use default Playwright workers (2 now; CI may raise after evidence). No browser/MCP/provider.
- **Current integration**: WP2 execution and WP3–WP5 cross-stage suites, native option protected integration, current Node external/CLI/persistence and Python deferred host/projection/UI. Serialize only the actual protected-browser/process contention group with `--workers=1`; split independent source/contract files out so they remain parallel. Do not set global workers to one.
- **Compatibility**: only compact v1/agentic-v2/goal-directed/structured/P4/public-profile sentinels. Pure parsers parallel; container/browser lifecycle sentinels serialized and release-only.
- **Release**: typecheck/build, fast, current integration, compatibility and selected Python groups, in sequence where build artifacts are dependencies. Existing `npm test` should not be nested in release because it re-adds every historical spec.
- **Live**: explicit opt-in gates, serialized; never include in `test:all` unless `test:all` is deliberately an opt-in local umbrella and prints/skips safely. Preferred `test:all` remains offline-only.

Python uses `unittest`, has no pytest configuration, and each test module is invoked explicitly today; `unittest` module execution is sequential within one process. Group pure protocol/parser tests together, host/UI tests together (AppTest timing can fluctuate and should remain serial), live/provider/public browser modules separately and gated. Avoid broad `discover` in routine scripts until live modules are demonstrably gated and all helper/support files safe under discovery.

## Audit script proposal (superseded by Phase 1)

This is the read-only audit proposal, not the current executable script list. Do not copy it: it included public-runtime specs that Phase 1 excludes from offline compatibility. The source of truth is [`package.json`](../package.json); implemented groups, workers and measured outcomes are in [Phase 1 implementation](#phase-1-implementation). The deferred live wrapper is `scripts/run-live-interpretation-tests.mjs` and requires the explicit gate before Playwright starts.

```json
{
  "test": "npm run test:fast",
  "test:fast": "playwright test tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-interpretation-v2-wp1b.spec.ts tests/deferred-action-interpretation-wp1-gate.spec.ts tests/deferred-offsetless-source-reconstruction.spec.ts tests/deferred-extraction-deadline-hardening.spec.ts tests/deferred-extraction-retry.spec.ts tests/deferred-structural-diagnostics.spec.ts tests/native-option-verification-source.spec.ts tests/locator-contracts.spec.ts tests/domain-contracts.spec.ts tests/project-env.spec.ts tests/openai-responses-p2-1b.spec.ts --workers=2",
  "test:current": "npm run test:fast && playwright test tests/agentic-external-v2.spec.ts tests/subprocess-cancellation-p4-2.spec.ts tests/public-admission-runtime-p3a.spec.ts --workers=2 && playwright test tests/deferred-action-grounding-wp2a.spec.ts tests/deferred-action-grounding-wp2b.spec.ts tests/deferred-action-grounding-wp2c.spec.ts tests/deferred-action-grounding-wp2d-a.spec.ts tests/deferred-action-grounding-wp2d-b.spec.ts tests/deferred-action-grounding-wp3a.spec.ts tests/deferred-action-grounding-wp3b.spec.ts tests/deferred-action-grounding-wp4a.spec.ts tests/deferred-action-grounding-wp4b.spec.ts tests/deferred-action-production-wp5a.spec.ts tests/native-owned-option-verification.spec.ts --workers=1 && uv run python -m unittest tests.python.test_project_env tests.python.test_agentic_external_v2 tests.python.test_deferred_workflow_wp5a tests.python.test_subprocess_host tests.python.test_report_projection_p3b tests.python.test_ui_shell_p3c tests.python.test_ui_workflow_p3d",
  "test:compat": "playwright test tests/agentic-cli-v2.spec.ts tests/agentic-domain-contracts-wp1.spec.ts tests/agentic-trace-contracts-v2.spec.ts tests/goal-directed-verification-wp1.spec.ts tests/structured-action-identity-wp1.spec.ts tests/subprocess-protocol-p2-3a.spec.ts tests/report-projection-p3b.spec.ts tests/evidence-m5.spec.ts tests/public-admission-p3a.spec.ts tests/live-events-p4-1a.spec.ts tests/live-images-p4-2a.spec.ts --workers=2 && playwright test tests/goal-directed-compiler-wp4a.spec.ts tests/goal-directed-runner-wp5a.spec.ts tests/structured-action-identity-wp4a.spec.ts tests/structured-action-identity-wp4b.spec.ts tests/runner-m4.spec.ts tests/live-viewer-p4-3b.spec.ts tests/public-browser-container-g1.spec.ts tests/public-browser-node-g1.spec.ts tests/public-run-environment-g1.spec.ts tests/public-browser-headed-runtime-p4-3a.spec.ts --workers=1 && uv run python -m unittest tests.python.test_live_events_p4_1b tests.python.test_live_images_p4_2b tests.python.test_live_viewer_p4_3b",
  "test:release": "npm run typecheck && npm run build && npm run test:current && npm run test:compat",
  "test:live:interpretation": "node scripts/run-live-tests.mjs deferred-interpretation",
  "test:live": "node scripts/run-live-tests.mjs selected-live-suite",
  "test:all": "npm run test:release"
}
```

The obsolete proposal imagined a general `scripts/run-live-tests.mjs`; Phase 1 instead implements the deferred interpretation-only wrapper named above. Python uses `unittest` with explicit module lists and runs sequentially. The exact implemented lists and repository-local uv cache path are in `package.json`.

- `python -m unittest tests.python.test_project_env tests.python.test_agentic_external_v2 tests.python.test_deferred_workflow_wp5a tests.python.test_report_projection_p3b` for pure contracts/parity.
- `python -m unittest tests.python.test_subprocess_host tests.python.test_ui_shell_p3c tests.python.test_ui_workflow_p3d tests.python.test_phase3_regression_p3e` for host/UI, serialized.
- compatibility sentinels: legacy release/projection plus minimal P4 event/image/viewer modules, not broad discovery. The exact command above is transitional file selection; after milestone consolidation, narrow each file to sentinel test titles/tags rather than retaining every historical case.
- live modules only through explicit gates and explicit names.

## Audit-time estimates and decisions (pre-Phase 1)

The repository briefing reports approximately 30 minutes for the broad current run; no fresh stopwatch was run for this audit. The inventory has 752 authored TS test declarations and 109 Python `test_*` methods, before loop/parameter expansion; generated cases raise effective totals substantially. After the proposed consolidation, a routine fast suite retaining about 120–170 pure high-signal cases should target 1–3 minutes on a warm local tree. Current-route integration retaining about 70–110 cross-layer/protected cases should target 4–8 minutes serialized, with Python host/UI adding roughly 1–3 minutes. Release with 30–50 compact compatibility sentinels should target 8–12 minutes, a material reduction of approximately 60–75% from a ~30-minute all-milestone run. These are post-consolidation planning estimates, not a claim that the transitional commands as written already meet that target; no fresh stopwatch was run. Track first-run timings after implementation before finalizing thresholds.

Suggested disposition summary: preserve all named hard-won regressions; consolidate duplicated WP2–WP5 repetitions around authority transitions; make historical workflows sentinel-only; remove target-specific public flow tests with no current supported contract; separate every credentialed provider/browser test from normal scripts. No tests or production files were changed by this audit.

## Uncertainty / follow-up

Some suites combine mocked protected fixtures, child-process tests and browser launch in one file, so final `B/M`, `--workers=1` and safe-parallel membership should be confirmed against fixture setup before physically splitting files. The approximate counts are declaration counts, and elapsed runtime targets require measurement on a frozen tree. The delete candidates are intentionally conditional on checking that no release procedure still names them as its only evidence. In particular, public-target smoke tests must remain gated and must not be relabeled as current route behavior merely because a URL is still reachable.

## Phase 1 implementation

This section supersedes the proposed transitional commands above for the implemented Phase 1. No production files or behavior were changed. All 91 originally inventoried Playwright specs and 19 Python test modules remain, and one new explicitly gated live interpretation spec was added: 92 Playwright specs plus 19 Python modules now total 111 runnable test files. No file was removed. `npm test` now delegates to `test:fast`. `test:current` adds the active `deferred-action-v1` WP2–WP5 integration and Python host/UI coverage; `test:compat` selects offline compatibility contracts. `test:release` runs typecheck, build, current, and compatibility; `test:all` aliases that offline release gate.

The final offline groups intentionally exclude every public-browser/Docker runtime spec and any Python module that can start the P4 headed public proof from ambient opt-in flags. In particular, `public-admission-runtime-p3a`, public browser container/node/headed runtime proofs, target survey/release-preparation tests, and `test_live_viewer_release_p4_3b` remain available for explicit manual gates but do not run in release. This makes `test:release` and `test:all` offline even when the `.env` file contains `OPENAI_API_KEY` or a public-runtime flag is inherited.

### Live deferred interpretation

`test:live:interpretation` and `test:live` invoke `scripts/run-live-interpretation-tests.mjs`, which exits before Playwright starts unless `PLAYWRIGHT_DEMO_LIVE_LLM_TESTS=1` is already present in the process environment. Every new live test repeats the explicit gate and checks for `OPENAI_API_KEY`; the Playwright configuration continues to load `.env` without treating credentials as authorization. The four tests make six provider calls when fully run: one primary extraction, one independent source-first extraction, and two calls for each of semantic admission and the exact five-step task. They stop after interpretation/admission and create no browser context. Test assertions expose only bounded schema/step outcomes; provider request/response payloads are not printed. Existing private/local diagnostic hooks were left intact.

The authored five-step fixture is shared as `tests/helpers/deferred-five-step-source.ts`. The exact-source, malformed-response, retry/deadline, canonical provenance, selected-option and mapping/replay tests remain in the offline fast/current groups. The previously failing WP1 gate fixture was updated to use the current offsetless test-wire adapter so its second extraction and semantic-disagreement regression are exercised as intended; no production logic changed. The agentic CLI compatibility fixture now passes an explicit empty `OPENAI_API_KEY` to its offline children, preventing the project dotenv loader from turning its no-credential boundary check into a provider request.

### Whole-file candidate review

No audited whole-file deletion candidate was safe to remove in Phase 1:

- `public-challenging-dom-release-prep.spec.ts` is the specific Iuvaret1 row-scoped click and exact `#edit` destination proof referenced by `public-target-qualification.md`.
- `public-columbia-survey.spec.ts` is retained as the only target-specific survey evidence for the still-supported public link-collection compatibility path; it is excluded from routine/offline tiers.
- `test_live_viewer_release_p4_3b.py` is named by `p4-3-live-proof.md` and uniquely covers three owner transitions, observation/autonomy separation, cancellation revocation, and container disposal.

Those files are retained unchanged and excluded from offline tier scripts. No unique assertion was migrated because its owner file remains present. This is a reviewed retain decision, not a deletion deferred on filename age.

No historical sentinel assertions were moved or deleted in Phase 1. The full selected compatibility files now run only in the on-demand `test:compat`/release group; reducing those files internally remains a Phase 2 consolidation task.

### Phase 1 script and parallelism map

| Script | Playwright specs | Python modules | Worker grouping |
|---|---:|---:|---|
| `test:fast` / `npm test` | 12 pure/current contract and parser specs | 0 | Playwright 2 workers |
| `test:current` | 25 total, including fast | 7 current Node/Python integration modules | fast and independent external contracts at 2; browser/fixture integration at 1; Python `unittest` sequential |
| `test:compat` | 17 offline historical/current boundary specs | 3 parser/viewer compatibility modules | pure contracts at 2; remaining fixture group at 1; Python sequential |
| `test:release` / `test:all` | Current plus compat | Current plus compat | Script sequence; no global single-worker setting |
| `test:live:interpretation` | 1 opt-in live spec, 4 tests | 0 | 1 worker, no browser execution |

All Phase 1 measurements are complete. Measurements use PowerShell stopwatch around the exact npm script, Playwright dot reporter, local `.uv-cache-p3e`, and a verification-only Node preload that fails any global fetch to `api.openai.com`. The repository `.env` loader reported `OPENAI_API_KEY` present; its value was not read into output. All counted offline tests passed with zero provider endpoint attempts. The live launcher separately returned exit 2 before starting Playwright when the explicit gate was unset.

| Tier | Passed test cases | Skipped/live cases | Worker count | Measured wall clock |
|---|---:|---:|---|---:|
| `test:fast` | 153 | 0 / 0 | Playwright 2 | 3.58s |
| `test:current` | 522 (468 Playwright, 54 Python) | 0 / 0 | Playwright 2 then 1; Python sequential | 411.05s (6m51s) |
| `test:compat` | 132 (106 Playwright, 26 Python) | 0 / 0 | Playwright 2 then 1; Python sequential | 111.45s (1m51s) |
| `test:release` | 654 (522 current, 132 compat) | 0 / 0 | Current and compat groups | 533.87s (8m54s) |

The broad file count before Phase 1 was 110 runnable files; now it is 111 (92 Playwright specs plus 19 Python modules) because one gated live interpretation spec was added. No file was removed. The audit reported about 30 minutes for broad `npm test`, but that baseline was not freshly timed during Phase 1; `npm test` now selects 12 files and measured 3.42s for the same 153 cases as `test:fast` (measured 3.58s). The wrapper command refused with exit 2 before starting Playwright when its gate was unset; direct execution of the live spec with `.env` loaded skipped all four tests. `test:release` executes 42 Playwright spec files and 10 Python modules in its current and compatibility groups. Phase 2 implementation and its measured reductions are documented below.

## Phase 2 implementation

Phase 2 narrows the routine current and compatibility scripts around `deferred-action-v1` authority transitions. No production files, `.env` authorization behavior, live-provider scripts, or `test:fast` membership changed. The `--grep` arguments use Windows-compatible double quotes. Browser/MCP and process-contention current coverage runs with `--workers=1`; pure contracts use two workers; Python unittest remains sequential.

The selected current boundary set covers candidate ambiguity before mutation; native-option owner/value mapping; authored label association; semantic disagreement; protected execution and witness issuance; trace-v5 authenticated issuance/readback; compiler-v4 rejection without v9; fresh mapping drift; deterministic runner-v9/process isolation; non-QA uncertainty; four two-replay agreement outcomes; authenticated persistence/restart/tamper; selected-option verification; and production selector/projection continuity. `test:current` was checked with `--list` after consolidation: 48 WP2-WP5 cases across 11 specs, plus 8 external/cancellation cases. Its 54 Python cases remain unchanged.

Historical WP3-WP5 compatibility now runs compact selected cases: the goal-directed compiler keeps own-version compilation, evaluated-false non-QA, and temporal unsupported; the runner keeps own-version evaluation and closed-schema/drift stops; the trace sentinel proves v2 accepts its own artifact and rejects v3; the historical store and projector reject a valid deferred-family result; structured v5 proves selector isolation, no fallback, exact authored public task acceptance before browser startup, and version-specific source/dist adapter routing. Goal-directed production retains version selection, no-MCP-after-compile, provider/environment stop, temporal unsupported, and selector behavior. Exact public task coverage is a pre-browser contract test, not a live target run.

Physical consolidation removed 19 duplicated test cases while preserving negative and authority cases: one generic WP2D-B fill success assertion, one WP3A successful trace-shape assertion duplicated by WP3B/WP5, five repeated WP4A runner happy-path fixtures (choice, country, fill, checkbox, radio; textarea remains), four historical goal-directed compiler cases, three goal-directed runner cases, four structured-action WP4A cases, and the duplicate structured WP4B default happy-path test. No whole test file was deleted and no unique assertion was relocated. Remaining full historical details are available for direct on-demand investigation; routine `test:compat` runs the compact cases above.

### Retained hard-won regressions

The offline release selection still runs deadline attribution and independent retry allowance (`deferred-extraction-deadline-hardening.spec.ts`), malformed completed provider-response retry (`deferred-extraction-retry.spec.ts`), exact ordered five-step source reconstruction and trusted span/canonical-source derivation (`deferred-offsetless-source-reconstruction.spec.ts`, WP1), and reciprocal ownership derivation (WP1 source-contract specs). Current retains selected-option capability in the native-option verification integration, compiler/replay mapping drift in WP3B/WP4A, and authenticated restart/readback in the deferred production plus Python WP5A suites. These cases run in `test:fast` or selected `test:current`; they are not merely left on disk outside release.

### Phase 2 measured results

Measurements used PowerShell stopwatch around each npm command with `scripts/deny-openai-provider.cjs` preloaded through `NODE_OPTIONS`. The `.env` loader remained enabled. The preload throws on any global `api.openai.com` fetch; all offline tests passed with zero such attempts. The live interpretation wrapper still refused before Playwright with exit 2 when `PLAYWRIGHT_DEMO_LIVE_LLM_TESTS` was unset. Typecheck and build passed inside the final release run. `test:current` was rerun after current-suite edits; release ran after historical trims and the final typecheck correction.

| Tier | Phase 1 cases | Phase 2 cases | Phase 1 time | Phase 2 time | Workers and notes |
|---|---:|---:|---:|---:|---|
| `test:fast` | 153 | 153 | 3.58s | 3.25s standalone (3.0s in release) | Playwright 2; unchanged selection |
| `test:current` | 522 | 263 (209 Playwright, 54 Python) | 411.05s | 146.43s standalone | fast/external 2; protected 48-case group 1; Python sequential |
| `test:compat` | 132 | 71 (45 Playwright, 26 Python) | 111.45s | 60.10s standalone | pure group 2; historical/browser group 1; Python sequential |
| `test:release` | 654 | 334 | 533.87s | 236.09s | typecheck, build, current, compat; no live provider |

Routine current count fell by 259/522 (49.6%) and measured wall time fell by 264.62s (64.4%). Release count fell by 320/654 (48.9%) and release wall time by 297.78s (55.8%). The runnable file count remains 111 (92 Playwright specs and 19 Python modules); Phase 2 removed test cases, not files. The Phase 1 broad-run estimate of about 30 minutes was not freshly measured and is not used for comparison.

### Phase 3 candidates

- Split the long grep selections into named tags or small authority-boundary specs so intent is easier to review and less sensitive to title edits.
- Review the still-large WP2C/WP2D failure matrices for exact duplicate association/value drift assertions while retaining distinct spoofing, stale-state, and incomplete-evidence regressions.
- Keep remaining historical compiler/runner details available on demand; delete additional old behavior only after checking version-reader, security, and release-procedure owners.
