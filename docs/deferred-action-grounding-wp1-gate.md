# Deferred action grounding WP1 independent interpretation gate

**Historical gate record:** The ActionGoal v2 WP1B rework now has a [separate completion report](deferred-action-grounding-wp1b-v2.md). The former expected-failure test has become a normal successor rejection through two mocked source extractions, plus a normal historical v1 defect-evidence test. The findings below remain the original v1 evidence; they are not a new independent v2 gate or provider proof.

**Result:** The v6 source contract and separate mocked interpretation adapter pass the principal reviewed cases, but the gate found an accepted target/argument conflation and ordinary source-grammar false rejections. WP1 **needs fixes before the interpretation gate passes**. No production behavior was changed and no credentialed provider or browser workflow was run.

## Scope and evidence

Reviewed the deferred action grounding architecture decision, WP1A/WP1B completion reports, and the v6 ActionGoal schema/fidelity validator, v6 TestSpec validator, deferred wire format, deferred interpretation prompt/adapter, and the WP1A/WP1B plus historical interpretation tests. The current structured-action v5 and goal-directed v4 interpretation suites were included to check route isolation and historical behavior.

The mocked-provider tests call the actual deferred Responses adapter and transport. They supply already-structured JSON as the provider response, so they prove strict wire normalization, source fidelity and result mapping. They do **not** prove that a real model will segment or interpret these requests correctly.

## Results

- **Automated tests:** 69 core tests passed; one separate gate regression is an expected failure that reproduces the accepted intent defect. Playwright reports 70 passed because the gate test is marked `test.fail` pending correction.
- **Typecheck:** passed.
- **Build:** passed.
- **Credentialed provider/browser workflow:** not run.
- **Architecture examples:** the mocked adapter path covers Click the Save button, Click Save, Select Option 1, Choose Option 1 from the Country dropdown, Open the only dropdown and choose Option 2, Fill the username field with Jorge, Enter Jorge in the only text field, and Open the menu and choose Settings. The independent adapter regression added here also covers Click the button next to Email with an explicit button role and relationship, preserving Email only as the relationship anchor.

## Contract checks

`Select Option 1.` is accepted by `parseTestSpecV6` through the actual mocked adapter as `effect: choose`, argument purpose `choice` and authored text `Option 1`, with empty `targetConstraints` and no `explicitOperation`. It contains no accessible name, role, option value, target locator or native/custom control fact. This preserves target/argument separation and leaves the browser mechanism open.

The supported fixtures preserve explicit Click/click and Fill/fill constraints; role, name and context omissions are rejected as `INVALID_TEST_SPEC`. Selector, option-value, frame-title and v5 action-step fields are rejected by the strict v6 wire. A same-request possibility of one or many browser matches reaches the same valid source-goal shape: interpretation receives no browser state, and the prompt assigns actual cardinality and native/custom questions to protected grounding.

Authored ambiguity is represented by a closed ambiguity response and maps to `AMBIGUOUS_INSTRUCTION`; contradictory target constraints and fidelity failures reject. Browser-level multiplicity is not part of the data supplied to interpretation. The prompt explicitly prohibits classifying unknown browser identity or one-versus-many page matches as authored ambiguity. Because the mock supplies the response directly, these tests do not establish real-model compliance with that prompt instruction; no provider proof was authorized.

The deferred adapter has its own `qa_deferred_action_interpretation_v4` format and `interpretDeferredActionTask` entry point. The historical `interpretTask` rejects a v6-format response as malformed rather than accepting or retrying it under v5. Focused historical suites passed. TestSpec v2/v3/v4/v5 readers remain separately tested and do not convert v5 actions into ActionGoals.

## Findings

### Confirmed source-grammar false rejections

The model does not have unrestricted linguistic freedom at fidelity validation. `actionGoalFidelity` checks the authored effect span against a finite cue list, and its choice-argument boundary recognizes only `from` and `in`.

Two faithful structured interpretations were probed against the built v6 validator:

| Request and faithful source interpretation | Observed result | Evidence |
|---|---|---|
| `Tap Save.` → `activate`, effect span `Tap`, authored name `Save` | Rejected as `EFFECT_NOT_AUTHORED` | The activate cue regex lists click/open/press/activate/follow, but not tap. |
| `Choose Option 1 at the Country dropdown.` → `choose`, argument `Option 1`, context `at the Country dropdown`, name `Country`, role `dropdown` | Rejected as `ARGUMENT_TARGET_CONFLATION` | Context validation accepts `at`, but the choice argument boundary regex only recognizes `from` or `in`. |

These are fail-closed grammar limitations, not accepted intent loss. They mean a new ordinary verb or preposition can require validator changes even when the model supplies exact source spans and a semantically faithful ActionGoal. `Choose Option 1 from ...` passes. The risks are user-visible unsupported/invalid-source stops and pressure to keep growing phrase-specific lexical rules. They do not weaken browser safety.

### Accepted target/argument conflation

The delimiter gap also permits the inverse failure: target wording can be silently accepted as part of the literal choice argument. Through the actual mocked Responses adapter, the following structured output is **accepted**:

```text
Source: Choose Option 1 at the Country dropdown.
effect: choose
argument: "Option 1 at the Country dropdown"
targetConstraints: []
```

The actual accepted TestSpec has source step span `{start: 0, end: 40}`, effect span `{start: 0, end: 6}`, argument span `{start: 7, end: 39}`, and `targetConstraints: []`. The output owns the complete source clause and every source span, so ordinary clause-coverage checks pass. Because `at` is not recognized as a choice-target boundary, the validator does not require the `Country dropdown` wording to appear as target/context constraints. This is a confirmed intent-fidelity defect: the option and the control description are conflated, leaving later grounding no authored control constraint. It is more serious than the conservative false rejection above because malformed interpretation is accepted as a valid goal.

The adapter probe also confirms `Enter Jorge into username field.` can be represented faithfully with argument `Jorge`, target name `username` and role `field`; it is accepted. The defect is specific to the choice delimiter handling, not all uses of `into`.

### Relation anchor distinction

The WP1A source-contract example for `Click the button next to Email.` includes both relationship `next to Email` and target `name: Email`. A separate correct representation with `role: button` and relationship `next to Email`, and no target name, passes through the mocked WP1B adapter and is covered by the added regression. This gate did not establish that a real model will choose the latter representation. The WP1A fixture should not be treated as proof that Email names the button; it is the relation anchor in this wording.

### Ambiguity proof limit

The prompt and accepted source shape defer browser multiplicity, but the adapter accepts a provider-declared ambiguity response based on its allowed reason code without independently proving that the ambiguity is present in the authored clause. This is model judgment by design. Mock tests confirm the typed mapping for authored ambiguity and that an unrecognized browser-specific code is rejected; they cannot prove the real model will not misuse a generic allowed code such as `UNCLEAR_AUTHORED_CLAUSES` for a page-dependent concern.

## WP2 readiness

Trusted grounding design work may proceed, but WP2 integration should **not** proceed until the accepted target/argument conflation is closed. Keep the ordinary paraphrase false rejections visible as additional WP1 limitations: grounding coverage cannot imply that interpretation preserves those requests. No browser-grounding defect was evaluated here.

## Reproduction

Focused command:

```text
npx.cmd playwright test tests/deferred-action-goal-wp1a.spec.ts tests/deferred-action-interpretation-wp1b.spec.ts tests/deferred-action-interpretation-wp1-gate.spec.ts tests/structured-action-identity-wp1.spec.ts tests/goal-directed-verification-wp1.spec.ts tests/openai-wire-p2-1a.spec.ts tests/openai-adapters-p2-1c.spec.ts tests/openai-responses-p2-1b.spec.ts --workers=1
npm.cmd run typecheck
npm.cmd run build
```

The core focused suite initially had 68 passing tests. This gate added one deterministic mocked-adapter relationship case, bringing the core count to 69. A separate durable expected-failure test in `tests/deferred-action-interpretation-wp1-gate.spec.ts` asserts that the conflated `at` interpretation must reject; it currently receives accepted v6 and is marked `test.fail` so the test runner stays green while reporting the defect. Temporary actual-adapter probes also confirmed faithful `Enter ... into ...` acceptance; that probe file was removed. The `Tap` and correctly structured `at` cases were checked against built `parseTestSpecV6` and failed closed as recorded above.
