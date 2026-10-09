# Semantic-v7 final interpretation stability

> **D1 status: opt-in runnable driver (2026-10-07).** Current TestSpec-v7 interpretation, relation canonicalization, fidelity and admission. The last known result below is 10/10 admitted with one digest. The [relocated driver](../../tools/experiments/semantic/interpretation/semantic-v7-final-stability.mjs) requires `SEMANTIC_V7_INTERPRETATION_STABILITY=1`, `OPENAI_API_KEY`, built `dist/`, and explicit provider access. No D1 cohort was run.

Date: 2026-10-06  
Scope: primary structured extraction, wire and primitive validation, deterministic source-derived relation canonicalization, canonical semantic validation, independent fidelity review, and trusted admission. No browser, grounding, compiler, runner, replay, or QA stage ran.

## Cohort result

Exactly ten fresh sample attempts ran with the exact authored instruction specified for this measurement. Each used a new primary/reviewer adapter pair with the current built semantic-v7 path and the unchanged configured model, settings, schemas, and prompts. Primary and reviewer used separate stateless provider requests, for 20 successful provider transactions total. Each bounded record was atomically retained before the next sample. No provider output text or reasoning was retained.

| Attempt | Primary transport | Structured primary | Structural normalization | Relation canonicalization | Canonical validation | Fidelity | Admission | Final | Steps | Canonical digest |
|---:|---|---|---|---|---|---|---|---|---:|---|
| 1 | succeeded | succeeded | succeeded | succeeded | succeeded | passed | passed | admitted | 8 | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` |
| 2 | succeeded | succeeded | succeeded | succeeded | succeeded | passed | passed | admitted | 8 | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` |
| 3 | succeeded | succeeded | succeeded | succeeded | succeeded | passed | passed | admitted | 8 | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` |
| 4 | succeeded | succeeded | succeeded | succeeded | succeeded | passed | passed | admitted | 8 | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` |
| 5 | succeeded | succeeded | succeeded | succeeded | succeeded | passed | passed | admitted | 8 | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` |
| 6 | succeeded | succeeded | succeeded | succeeded | succeeded | passed | passed | admitted | 8 | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` |
| 7 | succeeded | succeeded | succeeded | succeeded | succeeded | passed | passed | admitted | 8 | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` |
| 8 | succeeded | succeeded | succeeded | succeeded | succeeded | passed | passed | admitted | 8 | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` |
| 9 | succeeded | succeeded | succeeded | succeeded | succeeded | passed | passed | admitted | 8 | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` |
| 10 | succeeded | succeeded | succeeded | succeeded | succeeded | passed | passed | admitted | 8 | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` |

Admission was **10/10**. There was **1 unique canonical semantic digest**, zero material admitted semantic variants, zero provider failures, and zero fidelity rejections. No rejection diagnostics occurred.

## Required semantic checks

All 11 checks passed for every admitted attempt:

1. The root URL is `https://the-internet.herokuapp.com/`.
2. Add/Remove Elements is an activation intent.
3. Destination URL verification is equality against `https://the-internet.herokuapp.com/add_remove_elements/`.
4. Exactly two Add Element activation actions are represented.
5. Both repeated Add targets use canonical `unspecified` relation with no related step.
6. Delete complete-set cardinality 2 is preserved with canonical `unspecified` relation and no ordinal.
7. The first Delete target retains ordinal 1.
8. First Delete remains semantic `activate`.
9. Delete complete-set cardinality 1 is preserved with canonical `unspecified` relation and no ordinal.
10. No browser mechanic is promoted to authored intent; explicit mechanic is null for every action.
11. No model-only relation candidate survives where authored semantics canonicalize it away.

The bounded projection hashes exact target names and non-URL literals. It retains the two approved authored URLs as literals. Every attempt has eight ordered steps and the same dependency/order and target semantics.

## Three-generation comparison

| Measure | Before canonicalization | After canonicalization, before ordering fix | After ordering fix |
|---|---:|---:|---:|
| Admitted | 7/10 | 6/10 | **10/10** |
| Unique admitted digests | 5 | 1 | **1** |
| Material admitted variants | yes | no | **no** |
| Normalization/semantic rejections | 3 opaque | 4 classified | **0** |
| Provider failures | 0 | 0 | **0** |
| Fidelity rejections | 0 | 0 | **0** |

The earlier four failures paired a model `any_matching` candidate with the authored first ordinal and stopped before relation canonicalization. In this cohort, all ten passed structural normalization, relation canonicalization, canonical semantic validation, fidelity, and admission. The source-derived ordinal remains explicit while the model candidate does not survive as a contradictory relation.

## Classification and next action

**Classification: `INTERPRETATION_BOUNDARY_STABLE`.** This bounded cohort meets the stated threshold: ten admissions, one canonical digest, all authored checks preserved, and no provider, fidelity, or admission instability.

**Recommended next action:** retain this ten-sample measurement as the post-fix interpretation baseline and proceed to the separately controlled grounding/replay stability measurements when those are requested.

## Retained bounded records

The ten atomic, safe attempt records are under `artifacts/semantic-v7-final-stability-2026-10-06T21-45-55.481Z-61e2917e-bc33-45a2-bd78-01a5b8399e63/attempt-NN.json`. The experiment-only driver is `tools/experiments/semantic/interpretation/semantic-v7-final-stability.mjs`. Records contain stage statuses, closed diagnostics, semantic digests, and bounded semantic projections/checks; they omit unrestricted primary and reviewer text.
