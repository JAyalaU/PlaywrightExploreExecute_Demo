# WP1A ActionGoal v2 source and admission contract

Implemented the source-contract and deterministic-validation portion of the [semantic-fidelity addendum](action-goal-semantic-fidelity-architecture.md). No model extraction/orchestration, browser grounding, trace/compiler/runner integration, provider format, external outcome mapping or production cutover was added.

## Boundary and compatibility

- `app/domain/action-goal-v2.ts`: closed `ActionGoalV2Schema`, typed obligations and mechanical clause validation.
- `app/domain/test-spec-v6-v2.ts`: isolated `TestSpecV6V2Schema` and `parseTestSpecV6V2` draft reader. It retains `schemaVersion: "6"` and requires `sourceContractVersion: "2"` plus `goalVersion: "2"` on actions. Neither historical reader nor adapter accepts this shape.
- `app/domain/action-semantic-admission.ts`: pure deterministic agreement/admission over two already-produced source extractions, trusted metadata, immutable admission record and complete obligation-handoff linkage.
- `app/domain/index.ts`: additive exports only.
- `tests/deferred-action-goal-v2-wp1a.spec.ts`: focused contract/adversarial regressions.

Existing `action-goal.ts`, `test-spec-v6.ts`, historical provider wire and interpretation adapter remain unchanged. ActionGoal v1 stays separately readable with its historical lexical validation and defect evidence. No artifact is silently converted. The new action validator has no English effect, role, preposition, delimiter, connective or negation parsing. Navigation preserves the existing absolute URL and authored navigation policy; VerificationGoal preserves its existing independent fidelity rules.

## Source contract

Every action clause is partitioned into ordered, nonoverlapping, exact source segments, including whitespace and punctuation. Material segments have reciprocal obligation references; neutral annotations and unresolved residuals are explicit. Instruction accounting similarly partitions the full original instruction into exact ordered step clauses and neutral/unresolved gaps. Gap wording has no lexical whitelist. Neutral classification remains a semantic claim requiring matching extraction, not a deterministic statement that the words lack meaning.

Obligations cover effect, demanded operation, unsupported mechanism, literal argument, role/name/context/uniqueness constraint, relationship, prerequisite, resolved reference and contrast. Relationship subject is the action target; a separately source-grounded anchor has its own identifier. Target constraints may not reuse an anchor's source segments as target ownership. Literal data is inert, including code-like text. No selectors, current refs, computed browser facts, DOM values or executable fields are accepted.

Provenance uses ordered segment references and therefore supports separated source spans without overlapping the physical partition. Exact authored text is the concatenation of referenced segment bytes; normalization does not trim literals, change case, infer delimiters or merge boundaries. UTF-16 offsets may not split surrogate pairs. Digests hash canonical JSON string representations, preserving distinct lone surrogate code units. Backward prerequisites may refer to earlier steps; resolved target/argument references require earlier action goals and an actual argument for argument references. Unknown, forward and self references reject. Effect/argument/operation cardinality and compatibility, reciprocal ownership, source bounds and normalized positive/negative constraint contradictions reject mechanically.

## Admission and handoff

`parseTestSpecV6V2` produces a structurally valid **draft**, including residual drafts. It does not grant admission.

`admitActionSemanticsV2` requires both drafts to match trusted source, TestSpec identity, profile reference and start state. Canonical agreement remaps step, segment, anchor and obligation identifiers by exact source occurrence and structure. Obligation and owner set ordering is harmless; changed boundaries, literal occurrence, ownership, materiality, effect, mechanism, endpoints, polarity and reference linkage are not guessed equivalent. Any unresolved clause or instruction material stops admission. Unsupported authored mechanisms and initially unsupported negative/contrast obligations remain inspectable drafts and stop admission.

The frozen trusted admission includes the accepted full TestSpec and an immutable record linking source, trusted metadata, both extraction digests, accepted accounting/obligations, accepted TestSpec and extraction/prompt contract versions. A private symbol and runtime WeakSet establish in-process authority. Parsing a record, supplying a boolean, copying the object or reproducing its digests cannot forge that authority. `validateSemanticAdmissionReadbackV2` additionally compares serialized record/source readback against an existing trusted admission; it does not mint authority from storage alone.

The handoff linkage requires the admission/source/TestSpec/accounting digests and every accepted action obligation ID in source order. Missing Country, duplicated/changed obligations or altered linkage reject. Consumers must receive the trusted admission containing the full immutable source alongside this linkage. This is a source-accounting interface only: WP2 still must define total closed predicate/operation/argument/reference realizations, independent semantic correspondence endorsement, mapping digest and trusted runtime witnesses. Handoff coverage alone does not prove a mapping is strong enough or a browser predicate is true.

Internal source/admission error codes remain separate from QA outcomes and released external result contracts. Malformed data maps to `INVALID_SOURCE_REPRESENTATION`; differing extraction obligation counts use `SEMANTIC_FIDELITY_MISMATCH`, while other strict differences use `SEMANTIC_INTERPRETATION_DISAGREEMENT`. This count distinction describes a mechanical disagreement category, not proof of which extraction is faithful. Residuals use `SEMANTIC_INTERPRETATION_UNRESOLVED`; unsupported mechanisms/constraints use `UNSUPPORTED_AUTHORED_OPERATION` / `UNSUPPORTED_AUTHORED_CONSTRAINT`. WP1B must review precise provider failure and sanitized outcome mapping separately.

## Validation evidence

The new suite has **24 normal passing tests**. It covers all seven required ordinary-source examples as already-structured fixtures, target-before-argument ordering, quoted whitespace/code-like literal data, Unicode/repeated occurrences, exact source/accounting drift, residual preservation, malformed graph/provenance/closed fields, source/profile/start-state tampering, copied-but-wrong Email ownership, omitted mechanism, absorbed/neutral Country disagreement, ID/order remapping, forged admission, readback drift and obligation-handoff loss. Existing navigation/verification behavior and historical v1/v4/v5 isolation are exercised.

Commands completed successfully:

```text
npx.cmd playwright test tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-goal-wp1a.spec.ts tests/deferred-action-interpretation-wp1b.spec.ts tests/deferred-action-interpretation-wp1-gate.spec.ts tests/structured-action-identity-wp1.spec.ts tests/goal-directed-verification-wp1.spec.ts --workers=1
npm.cmd run typecheck
npm.cmd run build
```

Playwright reports **72 passed**: 71 normal passing tests and the unchanged historical adapter gate's one expected failure. The new v2 absorbed-Country rejection is a normal passing regression. Leaving the old expected-failure adapter test intact preserves the historical route's confirmed defect; the future WP1B independent adapter gate remains outstanding.

These fixtures validate mechanics and agreement, not independent model quality or real-provider paraphrase handling. One explicit correlated-error fixture demonstrates that two identically wrong absorbed-Country extractions can agree: admission is a semantic endorsement record, never mathematical English intent proof. Source-first independent context, provider deadline/refusal handling, persistent authority issuance across process restarts, eventual reviewed predicate correspondence and actual browser/compiler/replay proof remain future authorized work. No provider or browser workflow ran.

DEFERRED_ACTION_GROUNDING_WP1A_V2_COMPLETE
