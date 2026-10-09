# Semantic v7 interpretation boundary stability audit

## Scope and evidence limit

This is a read-only audit of the ten retained interpretation results in [the stability experiment](semantic-v7-interpretation-stability.md), the current semantic-v7 contracts, and the experiment's bounded JSONL. No provider, browser, grounding, compiler, replay, or QA work ran for this audit. The JSONL contains attempts 2–10; attempt 1 is available through the prior bounded report. Raw primary provider wire was **not retained** for any attempt. For admitted rows, `normalizeSemanticIntentV3` copies `wire.response.steps` into the v7 parser without changing `relation`, so the normalized relation also identifies the validated primary relation **by code-path inference**, not by direct wire inspection. For rejected rows the experiment stored no primary projection.

The input was exactly the seven-line repeated-control instruction in the stability report. All seven admitted projections had eight ordered steps: root navigation; link activation; destination URL equality; two Add activations; Delete count 2; first Delete activation; Delete count 1. Names and URL/literal digests, the first ordinal, cardinalities, effects, mechanics, and sequential dependencies agreed. Five admitted semantic digests resulted from relation differences.

## Per-attempt bounded comparison

`A4/A5` are the two Add action targets; `V6/V8` are the Delete count subjects. The first-Delete action `A7` was `unspecified` plus ordinal 1 in every admitted projection. `U` means `unspecified`, `S4` means `same_as_step` related to step 4, and `M` means `any_matching`. The “primary” column below is inferred for accepted rows as explained above. No raw primary step projection or precise inner predicate exists for failed rows.

| Attempt | Primary relation A4/A5/V6/A7/V8 | Normalized relation A4/A5/V6/A7/V8 | Normalization | Admission | Fidelity | Semantic digest / closed reason |
|---:|---|---|---|---|---|---|
| 1 | U/S4/U/U/U (inferred) | U/S4/U/U/U | passed | passed | passed | `6eca19803ac0af15c91951ce222a6165477c0e1b527f7a1e9eaf1fef1bbbf0e6` |
| 2 | U/U/U/U/U (inferred) | U/U/U/U/U | passed | passed | passed | `8456d69d4d4396d741d6d7ac2bee60930684695c2f23298efbdc28968503e4d8` |
| 3 | U/U/M/U/M (inferred) | U/U/M/U/M | passed | passed | passed | `f07cd65d601cb519d67285dc33fd7c06651ef8fb83aeda4dc9230dc7a443aa8b` |
| 4 | U/U/U/U/U (inferred) | U/U/U/U/U | passed | passed | passed | `8456d69d4d4396d741d6d7ac2bee60930684695c2f23298efbdc28968503e4d8` |
| 5 | unavailable | unavailable | failed | not reached | not reached | `INVALID_SOURCE_REPRESENTATION`; inner predicate unavailable |
| 6 | U/S4/M/U/M (inferred) | U/S4/M/U/M | passed | passed | passed | `d86c9a9d9dc27b1b8cdae59ad14922975e2c3537b209570227deec8f8d7736fb` |
| 7 | M/M/U/U/U (inferred) | M/M/U/U/U | passed | passed | passed | `75a830e50cc224978de39c4f35403adac93217181d4a4da9b2a1c9d6780d170c` |
| 8 | U/S4/M/U/M (inferred) | U/S4/M/U/M | passed | passed | passed | `d86c9a9d9dc27b1b8cdae59ad14922975e2c3537b209570227deec8f8d7736fb` |
| 9 | unavailable | unavailable | failed | not reached | not reached | `INVALID_SOURCE_REPRESENTATION`; inner predicate unavailable |
| 10 | unavailable | unavailable | failed | not reached | not reached | `INVALID_SOURCE_REPRESENTATION`; inner predicate unavailable |

All ten primary adapter calls returned schema-valid structured responses. The 7/10 normalized results passed independent fidelity and admission. No provider transport or fidelity rejection was observed. The prior experiment reports a first-process capture gap, so its ten retained rows must not be treated as a certified total count of all provider transactions.

For the other action/verification fields in every admitted projection, link activation `A2` has `relation: unspecified`; URL verification `V3` has a null subject and therefore no relation; `A7` has `relation: unspecified` with authored ordinal 1. The navigation step has no target relation. Failed rows retain none of these per-step fields. Attempt 1's values are available only through the prior report, while attempts 2–10 were inspected in JSONL.

## Authored meaning and relation authority

“Activate the ‘Add Element’ button twice” gives one named target *description* and a repetition count of two. V7 has no repetition-count field, so two ordered `activate` steps are its current faithful representation. The sentence does not assert that the identical live DOM node must survive between activations. A v7 `same_as_step` is stronger: protected grounding looks up the prior selected runtime identity and requires that same identity in the new candidate set. `any_matching` suggests authored permission to choose arbitrarily among repeated matching controls, which this sentence also does not state. For this input, both Add steps should canonically have `relation: unspecified`, `relatedStepId: null`, with the shared exact name and order intact. This preserves a uniquely identified button while declining to invent cross-action identity. It does not relax ambiguity: current grounding rejects multiple candidates without ordinal or supported relation even when the enum is `any_matching`.

“Exactly two/one ‘Delete’ buttons exist” asks for the cardinality of the **complete matching set**, not a selected button. Protected observation already counts the complete candidate domain with no selected index. `any_matching` and `unspecified` make no difference to that count, and neither is separately authored; `unspecified` is the canonical v7 encoding. The following “first ‘Delete’ button” does state a candidate-order relationship and must keep ordinal 1, proved from a complete current domain. These current v7 encodings are materially different for Add because `same_as_step` creates a live-identity obligation, even though the source supports only the less restrictive canonical meaning. The two count-subject encodings are representational duplicates for this complete-set assertion.

Relation is not universally a browser-query artifact. “One of the Delete buttons” can express authored arbitrary-member permission; the existing repeated-control fixture records `any_matching` and still stops on an ambiguous runtime candidate set. “The control created by the previous Add” can express a `created_by_step` causal claim, and a selected-option assertion can refer to a previous choose action through `same_as_step`. Those authored relationships should stay explicit. DOM order, live identity, native option ownership, and creation proof are browser facts that only protected grounding may establish. For this test, model-selected `any_matching` on Add/count and `same_as_step` on the second Add convert a browser choice or plausible narrative into source authority.

The current authority path is:

1. The primary model selects the target `relation`, `relatedStepId`, ordinal, action/observable, and dependencies within `SemanticTargetIntentV3Schema`; the strict provider wire validates field types and enums. Its prompt instructs `any_matching` for authored permission and asks for relationship preservation, but does not mechanically derive a relation from the source.
2. `normalizeSemanticIntentV3` validates the source/wire and copies model steps unchanged into TestSpec v7. It does **no relation canonicalization**. `parseSemanticIntentTestSpecV3` checks reference consistency, prior-step existence, and ordinal/`any_matching` conflict; it does not establish that a relation was authored.
3. Admission v3 validates the spec and source identity, demands a faithful reviewer verdict, and hashes the accepted artifact. It does not choose or canonicalize relation meaning.
4. The fidelity reviewer receives the original instruction and `semanticIntentFidelityProjectionV3`, including the complete target/subject objects with `relation`, `relatedStepId`, and ordinal. Its prompt explicitly asks it to check relationships. Nevertheless it marked all seven variant projections faithful. The projection is sufficient to *display* the difference, so this is not field omission. The reviewer made permissive judgments for these samples; the deterministic literal guard checks URLs/choices/entered values, not relation support. A model verdict cannot by itself prove that a runtime-identity or arbitrary-member claim is source-grounded.
5. Grounding later proves an authored `same_as_step` or `created_by_step` against fresh browser evidence; it does not repair source semantics. Complete-set count does not consume a selected-candidate relationship.

Thus fidelity had a source/meaning enforcement gap for `same_as_step` on Add; for the Delete counts it accepted two encodings of one effective meaning. This does not establish a universal fidelity failure rate. The v7 schema currently grants the primary model more relation authority than the authored source warrants, and structural admission does not narrow it.

## The three normalization rejections

`interpretSemanticIntentV3` catches **all** errors from `normalizeSemanticIntentV3` and returns `INVALID_SOURCE_REPRESENTATION` without a subcode. The experiment wrapper makes the same broad catch, writes `normalization: failed`, and never persists the validated primary wire or an inner validation category. That is the exact point at which the historical predicate is lost; attempts 5, 9, and 10 cannot be assigned to a particular relation rule.

Within that boundary the possible closed predicates are:

| Boundary | Specific possible rejection |
|---|---|
| Trusted source parse | malformed `testSpecId`, instruction, profile reference, or start URL |
| Primary wire reparse | extraction shape, step schema/type/enum/required-field/URL bounds |
| V7 spec schema | fixed version/source fields, step shape and field constraints |
| V7 cross-step checks | `DUPLICATE_STEP_ID`; `INVALID_STEP_DEPENDENCY`; `INVALID_TARGET_RELATION` (relation/related ID consistency or non-prior reference); `CONFLICTING_TARGET_IDENTITY` (ordinal plus `any_matching`); `INVALID_ACTION_EFFECT_ARGUMENT`; `INVALID_VERIFICATION_PREDICATE` |

The fixed trusted source parsed in seven neighboring samples and the adapter had already parsed each completed primary response against the strict wire, making a V7-spec or cross-step rejection the stronger **boundary-level inference**. The retained data do not distinguish its schema checks from the six custom checks, and relation volatility alone does not justify ranking a specific custom predicate above the others. A future closed diagnostic should retain phase (`source`, `wire`, `spec_schema`, `spec_cross_step`), one of the six cross-step codes or a bounded schema field category, and step position/field family without storing response text. It should preserve the public rejection code and avoid exposing private provider payloads.

## Five-case compatibility thought experiment

| Case | Canonicalization constraint |
|---|---|
| Dropdown | Retain explicit chosen option and selected-state reference to the prior choose action where authored; do not erase genuine `same_as_step` ownership. |
| Simple Add/Remove | Named unique Add/Delete targets remain `unspecified`; exists/absent checks are complete-set observations. |
| Repeated Add / first Delete | Expand “twice” to two ordered activations with `unspecified` target identity; count subjects canonicalize to `unspecified`; preserve first Delete ordinal 1. An explicit “one of” or “created by” instruction needs its separate relation. |
| Checkboxes | Preserve first/second ordinals and true/false checked-state effects; no arbitrary-member relation. |
| Dynamic Controls | Preserve Remove/Add/Enable/Disable order and resulting absence/presence/enabled state; count-like existence remains a set observation, and no runtime control identity is invented. |

This is a read-only compatibility analysis of the existing fixtures/contracts, not a rerun. Broadly removing relation values would break the authored “one of”, created-control, and selected-option cases.

## Classification and one implementation task

**Primary classification: `MODEL_HAS_TOO_MUCH_RELATION_AUTHORITY`.** Secondary contributors are multiple accepted encodings for complete-set counts, the independent reviewer's permissive relation decisions in these samples, and a normalization diagnostic gap. The exact causes of three failed primary projections remain unknown; this evidence does not establish that the normalizer is too strict.

Implement one bounded **semantic-v7 relation canonicalization and closed diagnostic** change at the interpretation boundary. Before fidelity/admission, normalize complete-set cardinality subjects to `unspecified` with no related step; normalize two actions derived from the same authored “activate [named target] twice” clause to two ordered, identically described actions with `unspecified` relation, while retaining explicit authored ordinal, “one of”, same-target, and created-by claims. Restrict that rule to source-accounted, unambiguous forms; if clause ownership or an explicit relationship conflicts, reject as unresolved rather than silently erase a material relation. Keep the production TestSpec/wire identities versioned as required by the contract, and do not alter browser proof rules. In the same task, retain bounded phase/predicate/step-position diagnostics for normalization failures. Validate the five interpretation fixtures plus negative authored-relation and malformed-spec cases offline before any new provider evaluation. Do not tune the prompts or retry the whole workflow as a substitute for this boundary correction.
