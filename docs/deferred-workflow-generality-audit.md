# Deferred workflow generality audit

Date: 2026-10-05. Scope: read-only review of the active, gated `deferred-action-v1` `poc_v1` path. No provider or public browser run was used. The three reported terminal outcomes are observations, not sufficient private evidence to assign a unique runtime cause. References below identify the current contracts and code; historical designs are not treated as implementation.

## Current vocabulary and decision point

| Capability | Admitted vocabulary | First committed | Later boundary |
|---|---|---|---|
| Navigation | Approved absolute URL | Interpretation/admission | Compiler and runner replay the fixed URL. |
| Action goal | `activate`, `enter_text`, `choose`; optional explicit `click`, `fill`, `select_option`; entered text or choice argument | Interpretation | Active PoC correspondence maps effects to `click`, `fill`, `select_option` **before** candidate query. |
| Action target | Authored `role`, exact `name`, `context`, `uniqueness`, polarity; dependency | Interpretation | Correspondence admits exact role, `dropdown`/`select` to `combobox`, exact name, label context and uniqueness. Other obligations remain pending. Grounding enumerates matching roles/names across frames and proves one fresh actionable candidate. |
| Ordinary verification | Optional subject role (`button`, `link`, `dialog`, `row`, `textbox`, `checkbox`, `heading`), name, scope; optional intent `presence`, `property`, `cardinality`, `relationship`, `temporal` | Interpretation | Verification controller chooses a reviewed observation/comparison. A relationship hint cannot be evaluated. Temporal comparison can be explored but cannot be projected to deterministic assertion v1. |
| Native option verification | `native_owned_option_selected`, exact option label, expected selected boolean, owner role/name/label constraints | Interpretation | Grounding proves native single-select owner/option and selected state; compiler pins fresh option mapping; runner rechecks. Other `selected` meanings use the ordinary property route only where supported. |
| Observations | Complete role/name match count; unique target `visible`, `enabled`, `checked`, `expanded`, `selected`, `text`, `value`, `semantic`; URL; snapshot for inspection | MCP/verification strategy requests from a **closed** set | Trusted observation supplies evidence; snapshot is not evidence grade. |
| Comparisons | Count `equal`, `greater_than`, `at_least`, `at_most`; boolean equality; string `equal`, `contains`, URL prefix; `appears`/`disappears` transition | Verification strategy after observation, constrained by interpreted hint/wording | Compiler projects count, unique boolean/string and URL. Transition has no projection. |
| Resolved actions | `click`, `fill`, `select_option` with fresh guard, one eligible target and operation-specific native effect/delivery | Fresh compiler v4 | Runner v9 re-proves target, frame, argument/option and executes. No `check`, `uncheck`, `setChecked` or ordinal target operation. |
| Resolved assertions | URL, semantic count, unique boolean/string property, native owned-option selected | Fresh compiler v4 | Runner v9 evaluates closed predicates. Zero count is evaluable; missing unique property target is a binding stop, not an assertion false. |

The active extraction wire is [deferred-action-poc-wire.ts](../app/interpretation/deferred-action-poc-wire.ts:6); the action/source contract is [action-goal-v2.ts](../app/domain/action-goal-v2.ts:16), ordinary verification is [verification-goal.ts](../app/domain/verification-goal.ts:8), and native verification is [native-option-verification-goal.ts](../app/domain/native-option-verification-goal.ts:12). Correspondence and early operation choice are in [action-grounding-strategy.ts](../app/domain/action-grounding-strategy.ts:54) and [action-grounding-controller.ts](../app/interpretation/action-grounding-controller.ts:49). Observation, comparison, resolved, and runner vocabularies are in [observation-contracts.ts](../app/domain/observation-contracts.ts:10), [verification-comparison.ts](../app/domain/verification-comparison.ts:6), [goal-directed-compiler.ts](../app/domain/goal-directed-compiler.ts:18), [deferred-action-compiler.ts](../app/domain/deferred-action-compiler.ts:43), [deferred-v9.ts](../app/runner/deferred-v9.ts:186), and [verification-v9.ts](../app/runner/verification-v9.ts:98).

## Step traces and first limiting boundary

Legend: **Y** representable now; **C** conditional on a faithful role/name query and evidence; **N** absent; **?** public outcome does not identify the private cause. Columns mean interpretation / correspondence / grounding / resolved v9 / runner v9. “Grounding” includes the ordinary verification controller, not just action candidate query.

| Case and authored step | I / C / G / R / runner | First limit and information loss |
|---|---|---|
| A navigate root | Y / Y / Y / Y / Y | No semantic gap. |
| A click `Add/Remove Elements` link | Y / Y / Y / Y / Y | Exact link name and click fit the active path, subject to unique fresh binding. |
| A confirm URL | Y / Y / Y / Y / Y | Exact resulting URL is the active PoC special verification path. |
| A click `Add Element` | Y / Y / Y / Y / Y | Generic button click delivery is supported; target must be unique. |
| A verify `Delete` appears | Y / C / C / Y / Y | Ordinary presence can become count > 0. The verification query must preserve `button` and `Delete`; a public `VERIFICATION_UNRESOLVED` does not prove a schema gap. The controller's query/meaning rules, model decision or observation could be the first actual stop. |
| A click `Delete` | Y / Y / C / Y / Y | One matching Delete is actionable. With two identical Deletes, current candidate uniqueness rejects the action unless an authored or browser-proven causal identity can distinguish it. It cannot silently take `.first`. |
| A verify `Delete` absent | Y / C / C / Y / Y | A complete zero-count query projects to `semantic_count = 0`; using a unique property query would incorrectly make absence a binding stop. Temporal `disappears` is admitted during exploration but has no resolved assertion projection. |
| B navigate root | Y / Y / Y / Y / Y | Same approved navigation path as A. |
| B click `Checkboxes` link | Y / Y / Y / Y / Y | Exact named link and click fit the active path, subject to unique fresh binding. |
| B confirm URL | Y / Y / Y / Y / Y | Exact resulting URL fits the PoC special verification path. |
| B check checkbox 1 | N / N / N / N / N | First limit is interpretation: no desired checked-state transition, only `activate` and optional click. `checkbox 1` also needs an ordinal/structural target relationship that current positive role/name/context correspondence cannot prove. Click toggles, so it is not equivalent to idempotent check. |
| B verify checkbox 1 checked | C / C / C / Y / Y | Ordinary `checked=true` exists, but ordinal subject identity is not represented/proven; unique role-only query sees both controls. The public fidelity mismatch alone cannot show which primary/reviewer field disagreed. |
| B uncheck checkbox 2 | N / N / N / N / N | Same missing set-state transition and ordinal identity; click would be state-dependent and could create the wrong state. |
| B verify checkbox 2 unchecked | C / C / C / Y / Y | `checked=false` is in the ordinary assertion language; binding the second checkbox is the gap. |
| C navigate root | Y / Y / Y / Y / Y | Same approved navigation path as A. |
| C click `Dynamic Controls` link | Y / Y / Y / Y / Y | Exact named link and click fit the active path, subject to unique fresh binding. |
| C confirm URL | Y / Y / Y / Y / Y | Exact resulting URL fits the PoC special verification path. |
| C click `Remove` | Y / Y / Y / Y / Y | Generic click supported; asynchronous result is a later observation concern. |
| C verify checkbox absent | Y / C / C / Y / Y | Complete count zero is representable. The implementation may need bounded observation of the settled state; the public unresolved result does not locate the failing request. |
| C click `Add` | Y / Y / Y / Y / Y | Generic click supported. |
| C verify checkbox present again | Y / C / C / Y / Y | Count > 0 is representable; exact temporal `appears` has no deterministic projection. |
| C click `Enable` | Y / Y / Y / Y / Y | Generic click delivery supported. |
| C verify text input enabled | C / C / C / Y / Y | `enabled=true` is admitted and replayable for one uniquely queried textbox. Generic noun `text input` needs a faithful role mapping: an unhinted `textbox` query is rejected because that role word is absent from the clause; adding a role hint at interpretation may make it pass but risks inventing a constraint. |
| C click `Disable` | Y / Y / Y / Y / Y | Generic click delivery supported. |
| C verify text input disabled | C / C / C / Y / Y | `enabled=false` is admitted and replayable under the same unique target proof. |

This table identifies **contract capability**, not proof that each observed run passed an earlier step. The reported A/C stops might arise at query selection, stale/ambiguous observation, target readiness, or model strategy. Private per-step diagnostics would be needed for a forensic cause. Also, asserting a transition specifically requires both a before and after fact; the present resolved set can instead assert the authored resulting state if that preserves the instruction's meaning. If the before/after transition itself is material, compiler v4 rejects the current transition strategy because [assertionFromStrategyV1](../app/domain/goal-directed-compiler.ts:115) returns no assertion for it.

## Browser capability versus contracts

| User operation or assertion | Natural Playwright/MCP mechanic | Current classification |
|---|---|---|
| Button appears/absent; element count | Locator count with bounded polling and complete match domain | Already expressible as count assertion. Grounding/observation reliability is a possible implementation gap, not proven semantic closure. |
| Checkbox checked/unchecked assertion | `isChecked()` | Already expressible for one uniquely grounded checkbox; ordinal identity is `PREMATURE_SEMANTIC_CLOSURE`. |
| Check/uncheck action | `check()`, `uncheck()`, `setChecked()` | `PREMATURE_SEMANTIC_CLOSURE` at interpretation **and** `RESOLVED_RUNTIME_CAPABILITY_GAP`: v9 action union and runner lack a state-setting operation. |
| Enabled/disabled, visible/hidden | `isEnabled()`, `isVisible()` | Already expressible as unique boolean properties; subject discovery/readiness can still stop. |
| Selected native option | Native select/option selected state | Supported by the specialized v2 assertion; arbitrary selection meanings are narrower. |
| Value equality and URL equality | `inputValue()` and page URL | Closed resolved assertions exist; URL has a PoC special path. |
| Two identical Delete controls | Count plus a proved ordinal, container, or creation relationship; perhaps an authored count postcondition | `PREMATURE_SEMANTIC_CLOSURE` for relational/ordinal target intent. If no user or causal distinction exists, uniqueness must stop rather than choose an arbitrary Delete. |
| Material appears/disappears transition | Before and after counts linked to an action | `RESOLVED_RUNTIME_CAPABILITY_GAP`: exploration comparison exists, but compiler projection/runner assertion does not. |

## MCP's actual discretion

For `poc_v1` actions, the controller derives the operation directly from the admitted effect and calls deterministic `pocGroundingCorrespondenceV1` before `runtime.query`; it uses **zero action-strategy model attempts** on this branch ([action-grounding-controller.ts](../app/interpretation/action-grounding-controller.ts:49)). The candidate query can enumerate, prove a role/name/label match, map a native option label to value, and bind a fresh target. It cannot discover a new action effect or choose `check` after seeing a checkbox. The protected browser evidence is substantial, but action mechanics are mostly preselected locator/candidate binding. Ordinary verification is more agentic: a bounded model may request snapshot, count, property, or URL facts and select a reviewed comparison ([verification-strategy.ts](../app/interpretation/verification-strategy.ts:18)); nevertheless the observation grammar, subject correspondence and assertion projection are closed. Native option verification has a dedicated fixed reader. Thus the active path is **mostly locator binding for actions, bounded property discovery for ordinary verification**, not arbitrary UI-operation discovery.

## Premature commitments, ranked

1. **High:** `activate → click`, `enter_text → fill`, `choose → select_option` before browser inspection. It erases desired checked state and custom choice mechanics; an explicit authored operation should remain a constraint, while an implicit mechanism should be selected at grounding.
2. **High:** Action target correspondence reduces the author to positive role, exact name, label context and uniqueness before querying. Ordinals, causal references, negative constraints and many relationships become pending. `checkbox 1` and repeated Delete targets cannot be grounded from their authored meaning.
3. **High:** Selected-option verification is a separate native-only discriminant at interpretation. A generic `selected` intent should be retained while browser ownership and property mechanics are discovered. The existing native proof remains valuable as a grounded realization.
4. **Medium:** Ordinary verification subject role is optional in extraction but effectively required by `queryMatchesGoal` unless the proposed role word appears in the clause. A missing exact role or a phrase such as “text input” can block browser-derived role choice. Scope hints likewise cannot become an unscoped claim.
5. **Medium:** Fixed verification intent union and exact subject shape omit some authored properties/relationships; temporal intent is admitted yet lacks resolved projection. Count/property/URL support means this is not a uniformly closed verification system.
6. **Medium:** The reviewer sees operation and owner-control details in its projection. It should reject invented authored constraints, but should not require a browser implementation choice before inspecting the browser. The Checkbox result is consistent with such a mismatch or a primary omission; the public code does not establish which.

## Smallest generalization and correct boundary

Keep TestSpec as a versioned **semantic intent** artifact. An ActionGoal should carry an authored target description, desired effect/transition (including `set checked=true/false`), literal argument, explicit operation constraints if stated, order/dependency and source provenance. A VerificationGoal should carry subject intent, requested observable state/relation, polarity/comparator/expected value and provenance. The representation can name `activate`, `choose`, `set value`, `set checked`; and `exists`, `absent`, visible/hidden, enabled/disabled, checked/unchecked, selected, value/URL equality and cardinality. Browser roles, locators, native versus custom control, selected option value and executable operation remain unresolved unless the author explicitly supplied them. An authored `click` remains an operation constraint.

Grounding then uses a bounded reviewed capability/query vocabulary to discover a complete candidate set, role, ownership/ordinal or causal relationship, control capability, appropriate reviewed operation and observable property. It records current evidence, uniqueness, freshness, action receipt/effect and exact relation to the authored intent. A fresh compiler reconstructs that relation and emits a **closed Playwright-oriented resolved artifact**: click, check/uncheck (or set checked), selectOption, fill, navigate; count, visible, enabled, checked, selected, value and URL assertions, plus any material temporal guard. Runner v9's existing count/property/URL/native assertions can be reused where they carry the proof; new operation/assertion forms require new versions. No model/MCP operates below the resolved artifact. Two fresh agreeing complete deterministic replays alone produce QA pass/fail. Nonunique, stale, unsupported, unavailable or uncompilable evidence remains non-QA.

The independent reviewer should compare **original instruction → semantic intent**: target descriptions, effect/state, polarity, literals and dependencies. For Checkbox, faithful semantics say “set first checkbox checked” and “set second checkbox unchecked”; a click/toggle or an invented accessible name is not faithful. Browser role/ordinal proof and `check()`/`uncheck()` selection belong to grounding/compiler. The current projection includes the already narrowed operation and native owner-control shape ([deferred-action-poc-normalize.ts](../app/interpretation/deferred-action-poc-normalize.ts:92)); the reviewer prompt is semantically framed, but the input contract invites implementation distinctions ([deferred-action-poc-interpret.ts](../app/interpretation/deferred-action-poc-interpret.ts:12)). The reported `SEMANTIC_FIDELITY_MISMATCH` cannot be assigned to a specific disagreement without its private issues.

## Acceptance cases through the proposed boundary

| Case | Semantic intent | MCP/protected grounding | Resolved replay and assertion |
|---|---|---|---|
| Dropdown | Activate `Dropdown` link; URL equals destination; choose `Option 1`; selected state true | Unique link; unique suitable dropdown and owned option, fresh label→value proof | Navigate, click, URL equality, selectOption, native selected assertion; two fresh agreeing runs. |
| Add/Remove simple | Activate link/Add/Delete; URL equality; Delete exists then absent | Unique named controls, complete Delete counts before/after | Clicks and count > 0 / count = 0 assertions. |
| Add/Remove two identical Delete buttons | Add twice; expect two; remove one; expect one (or preserve any explicit target distinction) | Complete count and, for removal, a proved authored ordinal/creation/container identity. Without one, stop ambiguous. | Guard the uniquely identified Delete, click, assert count 2 then 1; no arbitrary `.first`. |
| Checkboxes | Set checkbox 1 checked; assert true; set checkbox 2 unchecked; assert false | Prove two-control order/identity and starting state; choose state-setting mechanics | Fresh guarded check/uncheck, two unique checked assertions. |
| Dynamic Controls | Remove/Add checkbox and assert absent/present; Enable/Disable input and assert true/false | Fresh complete counts and unique textbox property after each asynchronous transition, bounded waits | Clicks; zero/positive count and enabled true/false assertions, or material transition guards if authored. |

## Migration, at most three atomic tasks

1. **Version semantic intent and admission.** Extend the primary wire/TestSpec and reviewer projection with generic desired state transitions and subject relationships; retain explicit operation only when authored. Update `app/interpretation/deferred-action-poc-wire.ts`, `deferred-action-poc-normalize.ts`, `deferred-action-poc-interpret.ts`, `app/domain/action-goal-v2.ts`, `verification-goal.ts`, `test-spec-v6-v2.ts`, semantic admission. Introduce new wire/prompt/TestSpec/source-contract identities; keep existing v6/v2 and external v1/v2 readers separate. Gate with all five interpreted fixtures, independent fidelity checks and negative invented-constraint/ordinal ambiguity cases.
2. **Generalize protected grounding and proof.** Delay mechanism and property selection until complete browser candidate/relationship/capability evidence exists. Extend `action-grounding-controller.ts`, `action-grounding-strategy.ts`, `action-candidate-grounding.ts`, protected candidate/observation utilities, verification strategy and trace capture. Version strategy/trace and trusted witness formats. Gate uniqueness, freshness, causal/ordinal identity, async state, false versus unresolved, and the five cases without provider/public browser.
3. **Extend fresh compiler and closed runner.** Add resolved state-setting operations and any material transition assertion; reuse count/property/URL/native assertions with stronger guards. Update `deferred-action-compiler.ts`, `deferred-trace-compiler-v4.ts`, `deferred-v9.ts`, `verification-v9.ts`, replay validators/readback. Bump compiler/resolved/runner contract identities where shapes or semantics change; preserve historical routes and external outcome split. Gate two fresh agreeing replays, replay disagreement/non-QA stops, target drift, repeated-control ambiguity, and all five acceptance cases.

**Exact first implementation task:** create the versioned semantic intent/admission contract in task 1 and its five offline interpretation/fidelity fixtures, without changing action grounding, compiler or runner yet. This gives a reviewable authored-intent boundary before selecting browser mechanics.

## Classification

`MODERATE_PREMATURE_SEMANTIC_CLOSURE`

The code is not solely a Dropdown script: general count and boolean property assertions, fresh candidate enumeration, generic click delivery, full trace/compiler/replay authority and non-QA stops already exist. The active PoC still fixes action mechanics and some verification owner semantics before browser evidence, and its closed correspondence cannot preserve ordinary set-state/ordinal intent. A/C public unresolved stops do not establish severe case-specific overfitting because their core resulting-state assertions are representable; B reveals a real semantic and resolved-action gap. This classification rests on the contracts above, not on terminal labels alone.
