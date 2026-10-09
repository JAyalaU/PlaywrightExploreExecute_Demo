# Native owned-option selection verification review

Review date: 2026-09-28. Status: **design recommendation; capability is not implemented**. This closes the design question, not the live release gate. No production code, selector configuration, provider workflow, or browser proof changed or ran.

## Decision and scope

Add one deferred-only, explicitly versioned VerificationGoal capability: **the native selected state of one exact authored option owned by one independently unique choice control**. M7 chooses a reviewed read-only observation; the protected runtime establishes its complete ownership and state facts; the successful verification strategy preserves that observation and comparison; the fresh compiler emits a closed assertion; both runner-v9 sessions evaluate it independently.

Keep ActionGoal v2, WP2 action grounding, and action execution unchanged. Do not reinterpret the existing `selected` property, add an English phrase recognizer, or use a successful select action as the verification fact. The extension is generic to authored option labels and positive/negative selection, including `Option 1`, `Option 2`, and other inert literals.

Inspected boundary: `verification-goal.ts`, deferred TestSpec-v6/v2 and semantic admission/wire contracts, trusted observations, verification strategy/controller and trace record, compiler-v4 projection, v9 assertion/run facts, runner-v9 verification, and the WP2B/native runner option readers required for reuse. Public admission, UI layout, general grounding, and other action mechanisms are outside the review.

## Confirmed evidence

| Boundary | Current evidence | Consequence |
|---|---|---|
| Authored source | `app/domain/verification-goal.ts:8` / `:17` exclude option subjects and selected intent. `app/domain/test-spec-v6-v2.ts:57` invokes the existing hint-fidelity validator. | Adding a runtime boolean alone does not authorize the authored claim. |
| Strategy meaning | `app/interpretation/verification-strategy.ts:64` / `:78` use current role/hint correspondence; the unhinted boolean path supports visible/enabled/checked. | An unhinted selected comparison cannot establish this clause. Expanding English matching would reproduce the bottleneck. |
| Existing selected fact | `app/exploration/trusted-observation.ts:173` and `app/runner/verification-v9.ts:78` read `aria-selected`. | This is a different capability; native option state must read `HTMLOptionElement.selected`, regardless of an absent or contradictory ARIA attribute. |
| Native ownership | `app/exploration/action-candidate-grounding.ts:55` / `:63` use fixed utility-world engines for complete native options, displayed label, value, disabled, selected, and ownership. `app/domain/action-option-grounding.ts:41` requires one action-issued candidate control. | Reuse the browser facts and bounds, but not the action admission/binding record as a verification authority. |
| Projection | `app/domain/goal-directed-compiler.ts:19` / `:115` define assertion-v1 and project only existing strategy forms. `app/domain/deferred-action-compiler.ts:40` / `:99` consume those forms and fresh v1 observations. | A distinct native assertion and fresh-observation correspondence must be threaded through the deferred family. |
| Trace and replay | `app/domain/agentic-trace-v5.ts:26` currently imports the historical verification record; `app/runner/deferred-v9.ts:158` executes assertions read-only inside the protected callback and checks state continuity. | Extend only the deferred verification record/union, preserving genuine capture, ordering, authentication, and fresh replay. |
| Value policy | `app/domain/deferred-action-compiler.ts:34`; WP3B/WP4A completion reports. | Exploration values are not compiler authority; fresh compiler mapping can differ. Replay must require equality with the compiler-pinned mapping. |

These are confirmed code boundaries. Real-provider extraction quality and the current public page's actual state remain unverified; no claim of live support follows from this review.

## Authored meaning and admission

Introduce a tagged native-choice verification source branch in deferred TestSpec v6/sourceContractVersion 2 only, with `verificationVersion: "2"`. Preserve the existing exact source clause/instruction span, goal ID, instruction, and optional authored dependency. Require a closed native-selection claim containing:

- exact authored option label and its one contiguous source occurrence/span;
- expected selected boolean;
- the full exact claim/source linkage;
- an explicit bounded list of authored control constraints, initially exact role, exact accessible name, or proven accessible-label text, each with its own source span/ownership;
- an explicit unresolved-material outcome when interpretation cannot supply this claim faithfully.

The option label is an **option subject**, never a control name. Empty control constraints are valid for `Verify that Option 1 is selected.` Do not invent an unnamed control's name, infer an owner from the preceding action, or set a browser value in this source branch. Existing whole-instruction accounting and ordered clause ownership remain intact. This is one bounded semantic claim, not a new ActionGoal obligation graph.

Both existing independent extractions must emit the same claim and constraint ownership. The source-first extractor still receives only original source and the reviewed contract, never primary output or browser state. Canonical admission compares exact option occurrence, expected boolean, all owner constraints, source clause/order, dependencies, and version tags. Deterministic checks validate spans, shape, linkage, bounds, and agreement. They do **not** decide positive/negative meaning by matching `selected`, `not`, `verify`, or synonyms. The new tagged branch must not pass through the historical regex hint-authority path. Existing untagged VerificationGoals retain their historical handling.

M7 may select the reviewed observation and cite its observation ID; its requested label/constraints and concluding expected boolean must equal the admitted source claim mechanically. M7 cannot add a discovered control name or frame to resolve ambiguity. Failure to agree or classify the native claim stops at interpretation; unsupported context remains unsupported, never silently dropped. Jointly wrong source interpretations remain the existing probabilistic semantic-admission risk, not something a new regex can prove away.

## Trusted observation contract

Use a separate `observationVersion: "2"`, `kind: "native_owned_option_state"` contract. A model request carries only an admitted goal/claim reference (or the exact closed claim checked against that reference). It supplies no DOM value, current ref, CSS/XPath, script, operation, assertion truth, or arbitrary relation. Expected polarity belongs to the comparison; the observation reads actual state without selecting, focusing, scrolling, or otherwise mutating the page.

The runtime derives the reviewed choice domain: `combobox` and `listbox`, all current-page frames, with the existing frame/candidate/option bounds (8/80/80) and bounded strings. Apply only admitted exact role/name constraints and proven label ownership. Enumerate with `includeHidden: true`, as the existing broad candidate reader does; hidden, disabled, custom or nonmatching-option controls cannot be removed to manufacture uniqueness. Enumerate the entire domain **before** using the option label and before durable-frame correspondence. Zero controls is `NO_MATCH`; two or more is `NON_UNIQUE`. For one control, require a visible current native single select; a hidden sole target, custom control or multiple select stops unsupported. Disabled state does not prevent the read-only observation.

Then enumerate that retained control's complete native option collection using the trusted utility world. Prove every option is owned by that same select and current frame. Map the exact authored text using native `option.label` (including its native fallback), retaining separate text and value facts. Require one exact displayed-label match and, conservatively consistent with WP2B, one option with that runtime-derived value. Duplicate labels or value collisions are non-QA ambiguity. Do not reinterpret text/name/value as interchangeable matches. Disabled state is recorded but does not invalidate a read-only state assertion: a disabled owned option can validly be selected or unselected. Do not reuse WP2B's enabled-action check for verification.

A complete record includes existing source/profile/fingerprint/test/attempt/session/page/state/mutation/timestamp provenance and digest, plus claim/admission digest, complete candidate count/domain/constraint evidence, selected control's frame ancestry and runtime identity, complete owned option facts, exact matched option identity/label/value, and `selected: boolean`. It states completeness explicitly and links label-association evidence where used. Keep all values and detailed facts private.

Issue records only from a protected observer journal with actual runtime ownership. Retain control and option handles during the read; bracket enumeration/state reads with fresh state, complete domain renewal, frame ownership, retained-node identity, option membership/mapping, and final selected-state checks. Replacement with identical markup must not inherit the old fact. Truncation, inaccessible frame, query error, detached node, mutation, stale evidence, or inconsistent final read yields an error record/non-QA stop, not a partial usable list. Extend protected capture/current-evidence checks for this new record. Parsing a schema/digest remains integrity checking, never origin authority.

The closed complete-result payload is structurally `kind: native_owned_option_state`, `candidateComplete: true`, `candidateCount: 1`, `optionsComplete: true`, `optionCount: bounded integer`, `labelMatchCount: 1`, `valueMatchCount: 1`, `owner: proven current control/frame identity`, `option: proven current option identity with exact label/runtime value/native membership`, and `selected: boolean`, plus the complete bounded facts/proof records described above. Error results carry `complete: false` and a closed reason. The request has no `expectedSelected` or model value. For example, the same actual fact `selected: false` is compared to `true` for the positive claim and `false` for the negative claim; observation truth is independent of either comparison.

## Reuse, strategy, compiler and replay

Factor only necessary fixed browser readers into a neutral browser-action/verification utility module: complete native option facts/handles, stable ownership and exact-label mapping, and existing label/frame semantics. This preserves identical browser meaning while keeping runner imports free of exploration/MCP/SDK. Do not import the action runtime into the runner, synthesize an ActionGoal to obtain a binding, or reuse an old action/post-effect record. The **new verification observation** owns its capture and claim authority; action and verification can share implementations of facts, not their evidence.

Use a tagged successful verification strategy v2 and comparison v2 for this native observation. Comparison is a single boolean equality with the admitted expected selected state, linked to an actual current complete observation. Preserve goal/admission/claim digest, observation IDs, owner/state epochs, action ordinal, evaluated boolean, and satisfied/unsatisfied conclusion. An evaluated false strategy is still a successfully evaluated verification strategy; it is not a grounding failure. It enters trace v5 only through the real protected observer/controller journal, with ordered source/state linkage and authenticated persistence.

Project a new deferred-only assertion-v2 variant, conceptually:

```json
{
  "assertionVersion": "2",
  "kind": "native_owned_option_selected",
  "sourceStrategyDigest": "<digest>",
  "sourceClaimDigest": "<digest>",
  "controlPredicate": "<closed admitted role/name/label constraints and all-frame bounds>",
  "optionLabel": "<exact authored label>",
  "expectedSelected": true,
  "frame": "<independently proven durable ancestry>",
  "compiledOptionValue": "<fresh compiler-derived value>",
  "mappingPolicy": "require_fresh_mapping_equal_compiled_argument"
}
```

The placeholders describe closed typed records, not strings to be interpreted. No source prose, locator language, refs, observation IDs as locators, or arbitrary predicates are executable. The compiler independently reruns the entire native observation predicate in its fresh protected context at the ordered verification step. It validates source/strategy correspondence, all-frame uniqueness, labels, frame ancestry, native ownership, complete options and fresh mapping. Its native selected comparison must correspond to the recorded strategy/evaluation under existing fresh verification acceptance semantics; mismatch rejects compilation without a resolved artifact, preserving real preceding execution accounting.

**Mapping policy:** a uniquely remapped value may differ from exploration and be accepted by the compiler, exactly as native actions already allow. The compiler pins its freshly derived value in the assertion. Both replays independently enumerate and remap the authored label and require the fresh value to equal that compiler value. Replay value drift is an option-mapping non-QA stop, never repair or a false assertion. For a trace with a select action and subsequent selection assertion, validate the fresh correspondence of each at its ordered point; an intervening mapping mutation remains a stop.

The runner evaluates the new assertion inside its existing protected read-only callback. It first proves the complete domain, the unique control, durable frame/label ownership, native capability, unique existing option and complete pinned mapping, then reads native `selected` on the retained current option with renewed identity/state checks. No action-success witness, `aria-selected`, compiler private state, MCP, model, snapshot, discovery, or old runner supplies truth. Private replay facts retain assertion, actual boolean, evaluated boolean and required guard/ownership proof linkage. The guard/ownership proof is a private sibling provenance record, independently mechanically validated against its run/session/page/state and runtime issuer. Its ephemeral refs, observation IDs, session IDs, capture digests and journals are **not** part of the canonical assertion `actual` or the replay-agreement operand. Canonical actual remains only the deterministic selected boolean. Pair agreement continues comparing corresponding exact closed assertion shape, actual boolean and evaluation, unchanged; distinct fresh proof identities must not create artificial disagreement. Privacy projection remains unchanged.

The fresh compiler is model-free but may use its existing MCP-backed protected observation session to obtain runtime facts; this review does not make compiler-v4 MCP-free. The deterministic runner and persisted runner-facing readback remain model-free/MCP-free, including fresh-process authentication with exploration/MCP/SDK imports blocked.

For both polarities, compute `evaluated = actualSelected === expectedSelected`. A complete false comparison is a deterministic false observation; two agreeing false observations yield QA failure. Two completed agreeing true observations, persistence and verified cleanup can yield QA pass. Missing control/option, duplicated matches, incomplete evidence and mapping/frame drift cannot yield true for the negative claim. Negation means **the existing uniquely owned option is unselected**, not absence. Option 2 can be observed unselected without an Option 2 action. Verification does not require an enabled control/option for read-only truth.

A selected-boolean change between compiler and replay, with the full predicate, ownership and pinned value still freshly proven, is a newly evaluated true/false observation rather than mapping uncertainty. Two agreeing false observations may therefore produce QA failure; different replay booleans produce a reproducibility stop. A change during one observation's protected read is stale/uncertain and remains non-QA. This distinguishes actual assertion failure from identity/value drift.

## Versioning and compatibility

Avoid whole-family bumps: trace v5, compiler v4, resolved v9, runner v9 and replay/result/projection versions continue as the current deferred family with explicit new inner capability versions. Add deferred-only unions for native source v2, observation v2, strategy/comparison v2, and assertion v2. Leave shared VerificationGoal/TrustedObservationV1/SuccessfulVerificationStrategyV1/AssertionV1 schemas and all historical readers/compilers/runners unchanged. New records are explicit capabilities, never reinterpretations or automatic upgrades of old artifacts. Old binaries must reject the new tagged variant, not fall back.

Use new provider format identities rather than modifying existing stored identities: next primary `qa_deferred_action_interpretation_v6`, independent `qa_deferred_action_source_first_v2`; version the reviewed contract/prompt and admission metadata accordingly. Add verification decisionVersion `6` (5 is already grounding), with a new response-format identity; keep decision-v4 for historical verification. Bounded semantic orchestration/admission itself stays unchanged. New versioned tags enter all canonical digests and authenticated readbacks.

This requires a deferred-only successful verification record/capture/readback bridge instead of widening `SuccessfulVerificationRecordV3` globally. Update compiler-v4 fresh-observation and v9 assertion/run-fact unions, pure validation and store reconstruction together. Preserve fresh-process read/projection with exploration, MCP and SDK imports blocked. No new external fields, Python/UI truth logic, workflow selector, default, public authority, or live gate behavior are needed. Existing bounded safe enums and counts suffice.

## Minimal implementation package and acceptance

Recommend one bounded package owned by **mcp-developer** because it crosses protected observation issuance and compiler/readback authority; have **test-automator** independently gate it. Implement source/wire/admission mechanical support, neutral fact reuse, native observation/journal, M7 strategy, trace capture, compiler assertion and runner evaluation together. Contract-only source work can be assigned to typescript-pro if needed, but should not create a second independently designed semantic policy. Expected gain: the exact release clause becomes replayable without page-specific effects or lexical rules. Cost: one new reviewed inner capability across the existing pipeline, with no new browser action, routing, or result family.

Required offline matrix before revising the live preflight limitation:

| Case | Expected result |
|---|---|
| Exact three-step primary task; one unnamed native dropdown; label differs from value | Actual mocked adapter/admission → M7 native fact → authenticated trace/compiler/v9 → two true replays → QA pass. No invented control name/model value. |
| Option 2 selected; positive Option 2 and negative Option 1 claims | Each fresh native fact/comparison evaluates true. |
| Present unique Option 1 unselected, positive claim | Completed false observations; two agreeing false → QA failure. |
| Present unique selected Option 1, negative claim | Completed false observations; two agreeing false → QA failure. |
| No control or no owned option; positive or negative claim | Non-QA; absence never satisfies negation. |
| Two eligible controls, even if only one contains requested label; cross-frame equivalent | Non-QA ambiguity before option-based narrowing. |
| Duplicate labels/value collisions, truncated candidates/options or frame errors | Non-QA, no complete strategy/assertion authority. |
| Admitted owner label/name/role; changed association, frame or replacement | Correct proven narrowing only; drift/replacement non-QA. No preceding-action owner shortcut. |
| Contradictory `aria-selected`, overridden page-world getters, forged complete record | Native utility facts prevail; forged record receives no protected origin. |
| Exploration value changes before compiler | Fresh unique compiler remapping allowed and pinned. |
| Compiler value changes before either replay | Non-QA mapping stop; no remapping repair, false QA, or older fallback. |
| Selected boolean changes between compiler and replay with intact identity/mapping | Fresh deterministic true/false evaluation; agreement determines QA, disagreement remains non-QA. |
| Disabled native owned option | Read-only native state can be evaluated; no new action authorization. |
| Source label/polarity/owner alteration, extra request constraint, stale/foreign observation | Admission disagreement or mechanical strategy/trace/compiler rejection. |
| Independent replays differ on selected boolean | Non-QA reproducibility stop. |
| Late uncertainty/cleanup failure, restart/tamper, historical selected/route isolation | Preserve earlier valid accounting; authenticated readback and bounded privacy unchanged; non-QA where uncertain. |

The review checked the normal primary path, the negative missing-option failure path, and the compiler-to-replay value-drift edge against current contract semantics analytically. No implementation or tests ran in this review. After implementation, run its focused end-to-end suite, affected deferred source/trace/compiler/runner/replay/host compatibility, typecheck/build, and blocked-import readback tests, then an independent offline gate. Public URL approval/profile isolation and separately approved real-provider extraction/browser proof remain outstanding. Unsupported custom/multiple selects, arbitrary relationships and generic activation remain outside this package. Do not remove the live preflight caveat until those offline checks pass.

Priority: release-blocking capability gap, not a defect in existing native action success. Residual risks are joint semantic misinterpretation, protected browser environmental drift and target approval, all requiring the existing independent admission and offline/live evidence boundaries rather than broader architectural work.

SELECTED_OPTION_VERIFICATION_REVIEW_COMPLETE
