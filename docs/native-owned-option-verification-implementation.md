# Native owned-option selected-state verification implementation

Implementation date: 2026-09-28. The deferred-only capability specified by [the reviewed design](selected-option-verification-review.md) is implemented. Independent offline capability gating, exact public-target approval and a separately approved real-provider proof remain pending. This report is implementation evidence, not a release decision. No default/selector, public admission, Python/UI contract, credentialed provider workflow or approved public browser workflow changed.

## Boundary and contracts

The concrete gap was that the action family could select a native owned option, while VerificationGoal had no reviewed native selected-state observation/projection. The new path keeps verification authority separate from action success:

`admitted native claim → decision 6 → protected observation 2 → strategy/comparison 2 → authenticated trace 5 → fresh compiler 4 → assertion 2 in resolved 9 → two fresh deterministic runner-9 evaluations → existing authenticated deferred result/projection`.

The new TestSpec-v6/source-contract-2 branch has `verificationVersion: "2"`, an exact contiguous authored option label/span, expected selected boolean and exact authored control constraints. Role, name and label constraints retain distinct source ownership. Both source extractions preserve the complete clause, source order/dependencies, literal occurrence, polarity and every owner constraint. Deterministic validation enforces structure/provenance/accounting/agreement; it does not recognize English selection phrases. Existing V1 VerificationGoals retain their own fidelity and versioned routes.

The actual gated production factory now uses `qa_deferred_action_interpretation_v6`, `qa_deferred_action_source_first_v2` and the native `agentic_native_option_verification_decision_v6` adapter. The independent extraction receives original source and the reviewed contract only. Decision 6 can request an admitted goal/claim reference and compare an actual selected boolean; it cannot introduce a control name, frame, executable value, selector or additional constraint. The model-facing observation summary omits private option/value/ownership data.

## Runtime facts and correspondence

The runtime renews the complete `combobox`/`listbox` domain across every current frame, including hidden controls, before option lookup or durable-frame correspondence. Only admitted exact role/name constraints and reviewed proven label association may narrow it. Bounds remain 8 frames, 80 controls and 80 options. Zero/multiple controls, inaccessible/truncated enumeration, stale/replaced nodes or inconsistent renewal stop without a usable fact. One retained visible native single select is supported; disabled control/option state is readable. Custom and multiple-select controls remain unsupported.

The fixed WP2B native option fact/handle readers were moved without semantic changes to a neutral browser-action utility. Action and verification share native displayed label, text, value, disabled, selected and membership meanings; their authority journals remain separate. `HTMLOptionElement.selected` is read in the utility world. ARIA selected attributes, preceding action success and model values do not supply verification truth.

One exact displayed label and one unique runtime value must identify a present option owned by the independently unique select. A negative assertion requires that present option to be unselected; absence is a non-QA stop. Complete facts are bracketed by state/epoch reads, complete predicate renewal, retained-node identity, option/control/frame ownership and a final native selected-state read. Private identity journals are bounded and closed with the session. Observer/controller issuance uses real prototype/private journal authority; overriding methods or recomputing schema hashes cannot mint origin.

Where authored label constraints are used, a bounded closed correspondence signature records only existing reviewed relation facts: native control ID when present, source ID when present, native `for`/wrapped/`aria-labelledby` kind, native `for` ID and ARIA IDREF group. This signature is never a locator or candidate-narrowing rule. Complete admitted-domain uniqueness comes first. The signature must be nonempty for a label-constrained proof and null/empty otherwise; runtime control/option/source identity handles are disjoint, and the ownership digest is revalidated. Compiler/replay relation substitution stops even when a convenient current control has the same label and option value. Existing WP2C exact contribution/group correspondence is unchanged: wrapped labels containing ordinary option descendant text or independently authored portions of a combined label group are not broadened by this package. Wrapped/ARIA/multiple-label tests use valid reviewed exact correspondence.

Trace capture accepts only protected current observations and genuine successful evaluation strategies with exact admitted claim/source/order/state linkage. Evaluated false is successful verification evaluation, not failed grounding. The compiler reconstructs the full admitted predicate and native ownership/frame/label correspondence in its fresh protected session. A unique fresh option value may differ from exploration; the compiler pins that fresh value in assertion 2. Each replay independently proves the predicate, relation, frame, option ownership and pinned value. Mapping/frame/ownership/staleness uncertainty stays non-QA. A fresh native selected boolean that differs from expected is a deterministic false observation.

Private proof IDs and ownership/session/epoch evidence are separate from canonical replay agreement. Agreement compares the assertion, actual selected boolean and evaluation; fresh proof IDs legitimately differ. Successful native proof can appear only on an assertion-passed/failed step, with exact before/after continuity. Stopped/unproven steps cannot carry it. Pure readback validates complete counts, label/value uniqueness, membership facts, ownership digests and assertion correspondence; real runner origin and authenticated persistence remain independently required.

## Integration and compatibility

The actual mocked HTTP-provider/protected-loopback primary integration executes navigation, `Select Option 1.`, and `Verify that Option 1 is selected.` through all stages to two agreeing completed assertions and `QA_ASSERTION_PASSED`. The source invents no dropdown name and supplies no DOM value. Source-first requests contain neither primary extraction nor browser state.

Other tests cover Option 2, positive/negative true and false observations, Country/role/name constraints, absent options/controls, complete multi-control ambiguity (including a second control without the requested option), hidden/custom controls, duplicate labels/values, truncation, frame/label drift, native property changes, identical-markup replacement, model-added constraints/values, source/trace/proof/store tampering, observer overriding, provider failure taxonomy and cleanup uncertainty. Fresh compiler remapping succeeds; replay remapping rejects. Real authenticated native artifact projection reopens in a fresh process with exploration/MCP/MCP-SDK imports blocked. Safe Node/Python projection exposes neither source/option values nor private assertions/proofs. No Python/UI field change was needed.

Older source/wire identities, V1 observations/strategies/assertions and historical trace/compiler/runner/result families remain separately readable and isolated. Old ARIA selected observations retain their historical semantics; they do not authorize native claims. The compiler still uses its existing protected MCP-backed fresh session; deterministic runners and persisted read/projection do not import it.

## Validation

The following commands passed. All Node suites used one worker and distinct output directories. No opt-in live suite ran.

```powershell
npx.cmd playwright test tests/native-option-verification-source.spec.ts tests/native-owned-option-verification.spec.ts --workers=1 --output=test-results-native-option-final
```

53 passed, 0 failed, 0 skipped on the final native contract tree. This includes the full three-step actual mocked-provider path and authenticated native fresh-process blocked-import restart.

```powershell
npx.cmd playwright test tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-interpretation-v2-wp1b.spec.ts tests/deferred-action-grounding-wp1-v2-independent-gate.spec.ts tests/deferred-action-grounding-wp2a.spec.ts tests/deferred-action-grounding-wp2b.spec.ts tests/deferred-action-grounding-wp2c.spec.ts tests/deferred-action-grounding-wp2d-a.spec.ts tests/deferred-action-grounding-wp2d-b.spec.ts tests/deferred-action-grounding-wp3a.spec.ts tests/deferred-action-grounding-wp3b.spec.ts tests/deferred-action-grounding-wp4a.spec.ts tests/deferred-action-grounding-wp4b.spec.ts tests/deferred-action-production-wp5a.spec.ts --workers=1 --output=test-results-native-option-deferred-compat
```

334 passed, 0 failed, 0 skipped. This broader run preceded the final additive pure proof check requiring an empty source-ID list when label ownership is null. That correction and its forged-proof regression were subsequently covered by the entire 53-case native suite; no runtime, historical family or broader suite behavior changed after this run.

```powershell
npx.cmd playwright test tests/goal-directed-verification-wp1.spec.ts tests/goal-directed-observation-wp2.spec.ts tests/goal-directed-verification-wp3a.spec.ts tests/goal-directed-trace-wp3b-a.spec.ts tests/goal-directed-trace-wp3b-b.spec.ts tests/goal-directed-compiler-wp4a.spec.ts tests/goal-directed-runner-wp5a.spec.ts tests/openai-responses-p2-1b.spec.ts tests/openai-adapters-p2-1c.spec.ts --workers=1 --output=test-results-native-option-historical-compat
.venv\Scripts\python.exe -m unittest tests.python.test_deferred_workflow_wp5a -v
npm.cmd run typecheck
npm.cmd run build
```

Historical verification/provider compatibility: 83 passed, 0 failed, 0 skipped, before the same native-only pure check. Python deferred host/protocol/projection/UI compatibility: 7 passed, 0 failed, 0 skipped. Final post-correction typecheck and build passed. The broader historical universe was not required or run.

## Independent-gate and live-proof handoff

An independent test-automator capability gate should inspect the actual source/admission, private observation/capture/strategy origin, compiler assertion and runner/readback path, then rerun the listed focused and changed-boundary compatibility sets on the frozen tree, Python deferred suite, typecheck/build and the native blocked-import authenticated restart. It should independently verify positive/negative false observations versus non-QA uncertainty, option/control ownership, complete all-frame ambiguity, compiler-remap/replay-pin policy, fresh identity/label/frame mutation rejection and safe projection. It must not enable the selector or run a credentialed/public workflow.

Only after that gate passes should an operator revisit the prepared exact three-step live procedure and obtain/confirm the reviewed exact public-target profile/isolation authorization. Provider extraction quality and actual public-page behavior remain unproven. Jointly wrong semantic extractions remain the reviewed probabilistic admission risk. Arbitrary relations, custom controls, multiple selection, generic button/link successful activation and unsupported verification forms remain unsupported. Optional linguistic robustness remains separate from primary live release closeout.
