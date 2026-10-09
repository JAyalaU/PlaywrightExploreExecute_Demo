# Semantic v7 interpretation stability experiment

> **D1 status: historical evidence only (2026-10-07).** This early TestSpec-v7 interpretation cohort predates final relation canonicalization. The driver was removed; its last result is recorded below (7/10 admitted, five digests). Original provider credential and network access would have been prerequisites. Use the [current experiment index](../../tools/experiments/README.md) for the retained final-boundary driver; do not rerun this generation.

## Result

The audited ten-row sample set contains seven admitted interpretations and three normalization rejections. All ten primary provider calls returned schema-valid structured responses; seven normalized and proceeded through an independent fidelity review, which accepted all seven. Five different canonical semantic digests appeared among the seven admitted TestSpecs. The differences are material target-relation changes, while core action/count/ordinal intent remained stable.

The records are attempt 1 from the first process and attempts 2-10 from a retained continuation. The first process's output stream was not fully captured; it may also have issued additional calls after attempt 1. Those unretained calls are excluded from the ten-row comparison, and the exact total provider-call count cannot be certified. No failed attempt was retried within its row. Prompts, schemas, provider settings, normalization, admission, and fidelity behavior were not changed during either process.

## Configuration and method

The exact authored instruction was held constant:

```text
Go to https://the-internet.herokuapp.com/
Find and activate the link named "Add/Remove Elements".
Verify that the current URL is https://the-internet.herokuapp.com/add_remove_elements/
Activate the "Add Element" button twice.
Verify that exactly two "Delete" buttons exist.
Activate the first "Delete" button.
Verify that exactly one "Delete" button exists.
```

Each audited attempt used a fresh TestSpec ID and the current `createOpenAISemanticIntentModelsV3` adapter plus `interpretSemanticIntentV3` route: semantic-v7 structured extraction, v2 normalization, admission v3, then an independent fidelity review. A reviewer request followed only a successfully normalized extraction. No browser, grounding, compiler, runner, replay, or QA path was invoked.

Provider configuration followed current route defaults: model `gpt-5.6-terra`, reasoning effort `medium`, maximum output 16,384 tokens, primary format `qa_deferred_semantic_intent_primary_v2`, and fidelity format `qa_deferred_semantic_intent_fidelity_v2`. The adapter used the same environment-backed credential source as the local route.

## Ten audited attempts

`relation signature` lists only the target-relation fields that varied. All admitted rows have the same eight ordered step kinds and the same URL, name digests, action effects, count expectations, explicit-mechanic values, and sequential dependencies, as detailed below.

| Attempt | Primary provider | Normalization | Admission | Fidelity | Result / rejection | Canonical semantic digest | Steps | Relation signature |
|---:|---|---|---|---|---|---|---:|---|
| 1 | succeeded | succeeded | passed | passed | admitted | `6eca19803ac0af15c91951ce222a6165477c0e1b527f7a1e9eaf1fef1bbbf0e6` | 8 | Add #1 unspecified; Add #2 same_as_step; Delete count subjects unspecified |
| 2 | succeeded | succeeded | passed | passed | admitted | `8456d69d4d4396d741d6d7ac2bee60930684695c2f23298efbdc28968503e4d8` | 8 | Add #1/#2 unspecified; Delete count subjects unspecified |
| 3 | succeeded | succeeded | passed | passed | admitted | `f07cd65d601cb519d67285dc33fd7c06651ef8fb83aeda4dc9230dc7a443aa8b` | 8 | Add #1/#2 unspecified; Delete count subjects any_matching |
| 4 | succeeded | succeeded | passed | passed | admitted | `8456d69d4d4396d741d6d7ac2bee60930684695c2f23298efbdc28968503e4d8` | 8 | Add #1/#2 unspecified; Delete count subjects unspecified |
| 5 | succeeded | failed | not reached | not reached | rejected: `INVALID_SOURCE_REPRESENTATION` | - | - | normalized projection unavailable |
| 6 | succeeded | succeeded | passed | passed | admitted | `d86c9a9d9dc27b1b8cdae59ad14922975e2c3537b209570227deec8f8d7736fb` | 8 | Add #2 same_as_step; Delete count subjects any_matching |
| 7 | succeeded | succeeded | passed | passed | admitted | `75a830e50cc224978de39c4f35403adac93217181d4a4da9b2a1c9d6780d170c` | 8 | Add #1/#2 any_matching; Delete count subjects unspecified |
| 8 | succeeded | succeeded | passed | passed | admitted | `d86c9a9d9dc27b1b8cdae59ad14922975e2c3537b209570227deec8f8d7736fb` | 8 | Add #2 same_as_step; Delete count subjects any_matching |
| 9 | succeeded | failed | not reached | not reached | rejected: `INVALID_SOURCE_REPRESENTATION` | - | - | normalized projection unavailable |
| 10 | succeeded | failed | not reached | not reached | rejected: `INVALID_SOURCE_REPRESENTATION` | - | - | normalized projection unavailable |

Authenticated admission digests for the seven accepted projections (`sourceDigest / specDigest`):

| Attempt | Admission source digest | Admitted TestSpec digest |
|---:|---|---|
| 1 | `30dbc8cd21078786be69c74caa9a3f34a2a2bb32d4393c34b795ea03fe7a279d` | `9fc493de012c4e6ee0bc0df627f782f8e9886685ba60b742b8c33d34ff37e21b` |
| 2 | `b22fd62e3659a9f6ba205133c1060cd17bad2048f14ede95b1bb0186ffaa401b` | `73da4602ef23dd2879bc2c34c765654103ccc2f9b892951e514094365abe301f` |
| 3 | `bde1c1ba7461fb9c4cee70eb19c9a75f6e984b9d94986eb9af6b50cc385e1e32` | `67be583f7cd9b975663a8c418b52fc271da3e84b8f496414163fe93b4dc9ec9d` |
| 4 | `90d10b17101c60498908708bb54ccd9e2d0c04ac3ef88dbc2d7862358acce353` | `ef888244b1a8ca0a7b328a25fb7e672024c44e1126433a6ee07d26fbb49837e9` |
| 6 | `c2e82547cb90bada97c49772a1539a7678f36dae8cd32be0f4c45bb616a1f5f9` | `001b800afab1732890623d93d2ebc368073ffa0b764dd9b9e440b05176303e20` |
| 7 | `8aa7a46176f101384714fdc928b324301b0f6a41ef59b3a7bafb0d762cd4f869` | `57e15bd0f6f0172502cab895401034fefec74f8c36670b17808207c4712f46cd` |
| 8 | `bcf8039981b78ab8f24611471728623574e19426a7bd88d89da7b6aa834712c1` | `2574593fb9122b6efe4c66ddb5b3f55499083a797a06ba1068a86b603a892eb4` |

For attempts 5, 9, and 10, the adapter returned a structured primary response, but v2 normalization / v7 TestSpec parsing rejected it with the shared stable code `INVALID_SOURCE_REPRESENTATION`. The instrumented boundary is known; the inner validation issue was not retained, so a narrower reason would be speculation. No reviewer call occurred on those rows. There were no provider transport failures, primary structured-response failures, admission-stage rejections after review, or fidelity rejections.

## Admitted semantic projection comparison

The safe projection omits authored prose and generated IDs. Exact-name and context values are represented by presence plus SHA-256 digest; string verification literals are digested. Dependencies and related-step IDs are represented as step positions. Successful rows carry the production admission `sourceDigest` and `specDigest`; a separate canonical digest hashes the ordered semantic projection. Rejected rows have no admitted projection.

| Step | Stable meaning across all seven admissions |
|---:|---|
| 1 | Navigate to `https://the-internet.herokuapp.com/`. |
| 2 | Activate target category `link`, exact-name digest `d33146717b07e160258967bf861c1af3a993079003318edec9b17fcaeaf15cf3`. |
| 3 | URL equals the authored destination; expected-value digest `b9b59b2021d6ebd29986c79acb2f06a30b4365af32380d310264ad7d3d7d4181`. |
| 4-5 | Two ordered activations of target category `button`, exact-name digest `1398b15046a7bf7262b87c46aaab3f0a794f01d523e630898ca28bb297973cbb`. Both have `explicitMechanic: null`. |
| 6 | Target category `button`, exact-name digest `e2d0a54968ead24efc0dffa6ac78fc606dceec34a0f586177a74a54cc2272cf8`; cardinality `equals 2`. |
| 7 | Activate that same named button with ordinal `1` (the authored first target); mechanic remains null. |
| 8 | Same named button target; cardinality `equals 1`. |

The dependencies were sequential in all admissions: step 2 depends on 1, then each later step depends on its immediate predecessor. Root navigation, destination equality, both Add activations, cardinalities 2 and 1, first-Delete ordinal, semantic `activate`, and absence of invented click mechanics were preserved in every admitted sample.

The material differences are target relation constraints:

- The second Add Element action was `same_as_step` in attempts 1, 6, and 8; `unspecified` in attempts 2, 3, and 4; and `any_matching` in attempt 7. Attempt 7 also marked the first Add Element target `any_matching`.
- The Delete cardinality verification targets were `any_matching` in attempts 3, 6, and 8, and `unspecified` in attempts 1, 2, 4, and 7.

These are not merely bookkeeping changes: the v7 contract gives `same_as_step` and `any_matching` distinct target-identity meanings. Pairwise classification is `IDENTICAL_SEMANTICS` within digest groups (attempts 2/4 and 6/8), and `MATERIAL_SEMANTIC_VARIATION` across the other admitted pairs. No difference was classified as equivalent representational variation. There are five unique admitted digests and 19 material pairs out of 21 admitted pairwise comparisons.

## Rates and classification

- Admission success: **7/10 (70%)**.
- Unique semantic digests among admitted attempts: **5**.
- Material semantic variants: **5** distinct admitted meanings; **19/21** admitted pairs differ materially.
- Fidelity rejections: **0**.
- Provider failures: **0**.
- Primary normalization rejections: **3** (`INVALID_SOURCE_REPRESENTATION`).
- Provider transactions represented by the retained ten rows: **17** (10 primary calls and 7 fidelity calls); the overall count may be higher because of the unretained first-process continuation.

Final stability classification: **`MULTIPLE_INTERPRETATION_FAILURE_MODES`**. The admitted primary outputs varied in target relations, and three otherwise structured primary outputs failed normalization. The independent reviewer accepted every admitted output, so these samples do not show a fidelity-gate rejection; they do show that admission did not make semantic output identical across fresh attempts.

Recommended next action: instrument normalization with a bounded closed inner validation category and capture it in a fresh repeated interpretation-only sample before changing prompts. That will show whether the three normalization stops share one mechanical shape and whether the target-relation variation persists.
