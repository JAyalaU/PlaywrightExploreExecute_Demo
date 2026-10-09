# WP1B ActionGoal v2 interpretation and semantic admission

Implemented the bounded interpretation/admission rework in the [semantic-fidelity addendum](action-goal-semantic-fidelity-architecture.md), using the completed [WP1A v2 source contracts](deferred-action-grounding-wp1a-v2.md). This is an explicit source-only API; no production workflow selection, protected browser, M7, trace, compiler, runner or external released result contract changed.

## AI path and source authority

`interpretDeferredActionTaskV2` in `app/interpretation/deferred-action-v2-interpret.ts` snapshots and validates trusted original source/metadata, invokes the primary Responses adapter, validates its source draft, invokes a separate source-first Responses adapter, validates that draft, and passes both to WP1A's deterministic `admitActionSemanticsV2`. Success returns the trusted frozen semantic admission, its immutable full TestSpec v6/sourceContractVersion 2/ActionGoal v2, and the complete source-obligation handoff. Rejection returns a closed local non-QA stop with restricted original source/drafts/validated decisions. `projectActionSemanticStopV2` emits only bounded generated stop fields and explanation.

The primary format is `qa_deferred_action_interpretation_v5`; the independent format is `qa_deferred_action_source_first_v1`. Their distinct closed envelopes use `steps` versus source-first `clauses`, respectively, and normalize into the completed v2 source contract without rewriting spans, literals or ownership. Required nullable verification fields are normalized into the unchanged VerificationGoal shape. Neither format grants approval or accepts browser facts, executable identity or `approved` fields. The existing `qa_deferred_action_interpretation_v4` and ActionGoal v1 adapter/readers remain separately readable and cannot mint successor admission.

The independent provider receives only the original instruction and the reviewed extraction contract. It receives no primary output, TestSpec metadata, browser state, candidate, conversation history or tool results. Both Responses calls remain stateless (`store: false`, no tools). Independent model/provider configuration may be supplied separately; defaulting to the same provider/model does not claim empirical independence of model mistakes.

The prompt contract copies sections 3 and 4 of the authoritative addendum verbatim into a versioned source resource. A drift test compares that excerpt against the reviewed document, and both complete prompts fit the transport's 8,192-character bound. New action coreference uses endorsed typed backward source links. No new English synonym, preposition, negation, delimiter, role, neutral-word or pronoun parser was introduced. Existing navigation and VerificationGoal validation remain separate.

The provider JSON schemas derive from the v2 Zod schemas. Their discriminated, mutually exclusive unions use provider-supported nested `anyOf`; literal constants use singleton enums; integer exclusive lower bounds become inclusive integer bounds. URI policy remains a local source-validator check. Every provider object is closed with all properties required. Local parsing and mechanical source validation remain authoritative, including bounds, exact occurrences, complete accounting, reciprocal ownership and legal reference graph checks.

## Bounded orchestration and failure outcomes

There is one primary call and one independent call for structurally valid drafts or decisions, with no repair, majority vote, retry, older-format fallback or upgrade. A malformed first output stops after the first call. Defaults are 30 seconds per call, 60 seconds total and 65,536 normalized response characters; options have finite positive bounds. Caller cancellation and deadlines abort the transport and settle even if a mocked transport ignores abort. The independent call uses the remaining total budget. Provider credentials remain in adapter configuration and outside model inputs/source evidence.

The new local stop contract preserves `INVALID_SOURCE_REPRESENTATION`, `SEMANTIC_INTERPRETATION_DISAGREEMENT`, `SEMANTIC_FIDELITY_MISMATCH`, `SEMANTIC_INTERPRETATION_UNRESOLVED`, `AUTHORED_AMBIGUITY`, `UNSUPPORTED_AUTHORED_OPERATION`, `UNSUPPORTED_AUTHORED_CONSTRAINT`, typed provider failures, extraction deadlines, cancellation and environment stops. These are never QA outcomes or `MATERIAL_AMBIGUITY` catch-alls. Malformed model envelopes/schema fields and fabricated source are structural failures. Authored ambiguity requires the same closed reason and exact ordered source evidence in both extractions. Unresolved decisions retain their validated source evidence privately; residual drafts retain complete accounting. Provider bodies and exception messages are never returned.

WP1A's canonical comparison remaps IDs by occurrence/structure and permits harmless obligation ordering while keeping exact source boundaries, bytes, semantic classes, polarity, endpoints and links. Its differing-obligation-count category is exposed as bounded `OBLIGATION_SET_MISMATCH`; it identifies an omission/fidelity disagreement, not proof of which extraction is correct. Same-count ownership/effect/materiality differences remain semantic disagreement. Agreed residual material or unsupported obligations cannot acquire admission.

## Validation evidence

The new mocked Responses/admission suite has **32 normal passing tests**. It covers the seven required accepted cases, all five additional reviewed argument-order/context variants, Unicode, quoted/code-like literal bytes, repeated occurrences, multistage references, primary absorbed Country and neutral Country, missing Country accounting, wrong Email ownership, copied semantic disagreement, fabricated names/roles/literals, unknown executable/approval fields, omitted click/fill demands, residuals, independently endorsed ambiguity, unsupported operations/constraints, forged authority and dropped Country handoff obligations. Provider refusal/error/incomplete/malformed output are tested at both extraction stages; second-call deadline, total-budget exhaustion, cancellation, input snapshot/output bounds and safe projection are tested through actual mocked adapters.

The historical expected-failure gate is now two normal tests: preserved historical v1 defect evidence and a successor rejection after faithful source-first extraction. The focused run has **127 normal passing tests, no expected failures**, including WP1A v2, historical deferred WP1A/WP1B, old-route identity/verification, strict wire, adapter and transport compatibility.

Completed commands:

```text
npx.cmd playwright test tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-goal-wp1a.spec.ts tests/deferred-action-interpretation-v2-wp1b.spec.ts tests/deferred-action-interpretation-wp1b.spec.ts tests/deferred-action-interpretation-wp1-gate.spec.ts tests/structured-action-identity-wp1.spec.ts tests/goal-directed-verification-wp1.spec.ts tests/openai-wire-p2-1a.spec.ts tests/openai-adapters-p2-1c.spec.ts tests/openai-responses-p2-1b.spec.ts --workers=1
npm.cmd run typecheck
npm.cmd run build
```

All passed. No credentialed provider or browser workflow ran. Mock tests establish orchestration, source mechanics, failure isolation and deterministic agreement, not real-model semantic accuracy. An explicit correlated-error fixture admits two identically wrong absorbed-Country interpretations: agreement is an endorsement record, not mathematical English intent proof. Unseen paraphrase/provider evaluation and independent gate review remain necessary; WP2 must still define and independently endorse total closed obligation-to-predicate correspondence before browser execution. No grounding capability or production readiness is claimed by this report.

## Changed files

- `app/interpretation/deferred-action-v2-contract.ts`: versioned verbatim authoritative contract excerpt.
- `app/interpretation/deferred-action-v2-wire.ts`: isolated primary/independent strict wire schemas and normalization.
- `app/interpretation/deferred-action-v2-adapters.ts`: separate stateless Responses adapters.
- `app/interpretation/deferred-action-v2-interpret.ts`: bounded source-first orchestration, admission, private evidence and safe stop projection.
- `app/interpretation/openai-responses.ts`: additive format allowlist/diagnostic stage recognition only.
- `app/interpretation/index.ts`: additive exports.
- `tests/helpers/action-v2-fixtures.ts`, `tests/deferred-action-interpretation-v2-wp1b.spec.ts`, `tests/deferred-action-interpretation-wp1-gate.spec.ts`: focused fixtures and normal regressions.

DEFERRED_ACTION_GROUNDING_WP1B_V2_COMPLETE
