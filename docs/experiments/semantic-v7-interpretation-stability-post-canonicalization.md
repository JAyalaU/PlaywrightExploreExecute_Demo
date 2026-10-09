# Semantic v7 post-canonicalization interpretation stability

> **D1 status: historical evidence only (2026-10-07).** This intermediate TestSpec-v7 interpretation boundary was superseded by the final canonicalization cohort. The driver was removed; the last known sample below had six admissions and four normalization rejections. It required provider credentials and network access. The [current experiment index](../../tools/experiments/README.md) lists the retained final-boundary tool.

Date: 2026-10-06  
Scope: interpretation only; no browser, grounding, compiler, runner, replay, or QA stage.

## Valid escalated cohort

Exactly ten fresh provider attempts ran with escalated network permission. Each attempt used the exact authored text and a fresh primary/reviewer adapter pair. Each bounded result was atomically retained before the next attempt. All ten primary structured responses succeeded. No transport diagnostics were emitted; six attempts proceeded through fidelity and admission. No provider text or reasoning was retained.

| Attempt | Primary | Normalization | Canonicalization | Admission | Fidelity | Result | Closed normalization diagnostic | Canonical digest | Steps |
|---:|---|---|---|---|---|---|---|---|---:|
| 1 | succeeded | failed | not reached | not reached | not reached | rejected | `spec_cross_step / CONFLICTING_TARGET_IDENTITY / step 6 / ordinal` | — | — |
| 2 | succeeded | failed | not reached | not reached | not reached | rejected | `spec_cross_step / CONFLICTING_TARGET_IDENTITY / step 6 / ordinal` | — | — |
| 3 | succeeded | succeeded | succeeded | passed | passed | admitted | — | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` | 8 |
| 4 | succeeded | succeeded | succeeded | passed | passed | admitted | — | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` | 8 |
| 5 | succeeded | succeeded | succeeded | passed | passed | admitted | — | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` | 8 |
| 6 | succeeded | succeeded | succeeded | passed | passed | admitted | — | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` | 8 |
| 7 | succeeded | succeeded | succeeded | passed | passed | admitted | — | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` | 8 |
| 8 | succeeded | failed | not reached | not reached | not reached | rejected | `spec_cross_step / CONFLICTING_TARGET_IDENTITY / step 6 / ordinal` | — | — |
| 9 | succeeded | succeeded | succeeded | passed | passed | admitted | — | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` | 8 |
| 10 | succeeded | failed | not reached | not reached | not reached | rejected | `spec_cross_step / CONFLICTING_TARGET_IDENTITY / step 6 / ordinal` | — | — |

Admission was **6/10**. There was **1 unique admitted canonical digest** and **no material admitted semantic variance** among the six admitted TestSpecs. Fidelity passed 6/6 reached reviews; there were no provider failures or fidelity rejections.

### Admitted meaning check

All six admitted projections match on the following authored meaning:

1. Root navigation is `https://the-internet.herokuapp.com/`.
2. The Add/Remove Elements link activation is step 2, with semantic `activate` and no explicit browser mechanic.
3. The URL verification equals `https://the-internet.herokuapp.com/add_remove_elements/`.
4. “Add Element twice” is represented by two ordered activation actions.
5. Both Add targets have relation `unspecified` and no related step.
6. The complete-set Delete cardinality assertion expects exactly 2 and has canonical relation `unspecified`.
7. The Delete action retains ordinal `1` (semantic first) and the Delete button target.
8. The final complete-set Delete cardinality assertion expects exactly 1 and has canonical relation `unspecified`.
9. Steps remain in the authored order with sequential dependencies.
10. Both activations remain semantic `activate`; neither becomes an invented click mechanic.

Exact target names are retained as SHA-256 digests in the safe projection. The digests match the authored names `Add/Remove Elements`, `Add Element`, and `Delete`; the URLs are retained exactly under the approved-literal policy.

## Rejection analysis

Attempts 1, 2, 8, and 10 rejected at `spec_cross_step`, predicate `CONFLICTING_TARGET_IDENTITY`, zero-based step index 6, field family `ordinal`. The current validator emits this predicate for an explicit ordinal paired with model relation `any_matching`. The raw relation wire was not retained, so only the closed diagnostic is reported. This failure occurs during structural normalization before deterministic relation canonicalization can map the model candidate to the authored first-Delete intent.

The public result remains `INVALID_SOURCE_REPRESENTATION`. These are four specific normalization rejections, not provider or fidelity failures.

## Before and after

| Measurement | Before canonicalization | Valid post-canonicalization cohort |
|---|---:|---:|
| Retained attempts | 10 | 10 |
| Primary structured responses | 10 | 10 |
| Admitted TestSpecs | 7 | 6 |
| Unique admitted semantic digests | 5 | 1 |
| Normalization rejections | 3, inner reason unavailable | 4, all `CONFLICTING_TARGET_IDENTITY` |
| Provider failures | 0 | 0 |
| Fidelity rejections | 0 | 0 |

The earlier ten sandboxed attempts are excluded from this comparison: all failed before receiving a primary result and were not valid semantic samples. The valid cohort demonstrates one stable admitted semantic digest while exposing a remaining normalization boundary rejection.

## Classification and next action

**Classification: `SEMANTICS_STABLE_NORMALIZATION_REJECTIONS_REMAIN`.** Canonical admitted meaning was stable across all admitted samples; four model outputs did not reach canonicalization because structural validation rejected the ordinal/relation combination first.

**Recommended next action:** adjust the interpretation-boundary ordering so source-derived canonicalization can resolve a model relation candidate against an authored ordinal before the cross-step `any_matching`/ordinal conflict check, while keeping unsupported contradictory relations closed. Then cover this exact boundary with deterministic fixtures before another provider cohort.

## Retained artifacts

The valid cohort is under `artifacts/semantic-v7-post-canonicalization-stability-escalated-2026-10-06/attempt-NN.json`. Each record was written atomically before the next attempt. The experiment driver is `scripts/semantic-v7-post-canonicalization-stability.mjs`. Only the existing OpenAI adapter's bounded `source`, `httpStatus`, `transportCode`, and `code` diagnostics were added; the successful cohort had no diagnostic events.
