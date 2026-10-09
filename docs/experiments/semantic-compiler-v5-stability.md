# Semantic compiler v5 stability experiment

> **D1 status: opt-in runnable with an explicit authenticated trace (2026-10-07).** Current compiler v5 / Resolved v10 using a schema-5 local-Windows fixture. The last measured compiler cohort below was stable 10/10. Its original frozen trace path is absent in this checkout. The [relocated driver](../../tools/experiments/semantic/compiler/semantic-compiler-v5-stability-experiment.mjs) requires built `dist/` and `SEMANTIC_GROUNDED_TRACE_ARTIFACT` pointing to a newly prepared complete trace; default preflight authenticates it without a browser, while explicit cohort mode requires Windows Chromium. No D1 compiler cohort ran.

## Definitive fixed-trace compiler cohort (2026-10-07)

Classification: **`COMPILER_STAGE_STABLE`**.

Ten independent compiler-v5 attempts used the exact same authenticated historical source trace. Each attempt reread the artifact through `SemanticGroundedTraceV1Store`, verified HMAC and source/profile/version bindings, checked D1 and recomputed G1, minted a fresh test-only admission and historical trace capability, then used a new schema-5 `local-windows` protected MCP session and bundled Chromium. The experiment wrapper fulfilled the authored root and destination requests from the deterministic local repeated-control fixture before navigation and aborted all other requests. Every attempt received two local fixture responses and recorded zero blocked requests. No provider or public-site request occurred.

Frozen source:

| Item | Verified value |
|---|---|
| Trace ID | `semanticTrace5ce542b7f265671bd3d0a585af0e7bb9` |
| Artifact | `artifacts/semantic-grounding-v1-test-fixture-2026-10-07T00-28-52.867Z-59a84ae1-bfbe-4441-8c77-1d3a892e83ce/semantic-grounded-trace-v1/semanticGroundingTestFixture4828925d3c5243b794ad9396f08cf55d/semanticGroundingAttempt015365fc061a02429b8ba9a3fef893b036.json` |
| TestSpec ID | `semanticGroundingTestFixture4828925d3c5243b794ad9396f08cf55d` |
| Semantic digest D1 | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` |
| Grounding digest G1 | `58042676cb5771cd8d17a6ed7869c825f7b7d5d2f91aba0aa32e27d06e8448f7` |
| Full trace digest | `5ce542b7f265671bd3d0a585af0e7bb97f4fd7d3f38760dba9662b8cef67f8d4` |
| Profile | schema-5 `local-windows`, bundled Playwright Chromium; authenticated profile fingerprint matched on each read |

| # | Compiler attempt ID | Resolved ID | Result | Max current evidence age | Max action duration | Cleanup |
|---:|---|---|---|---:|---:|---|
| 1 | `semantic-compiler-61ca1dc8-a02d-4fbf-b2b6-e7c1c4e2745f` | `semantic-resolved-51f8d969-6bef-441b-ad41-8cb9b3b0a9d5` | compiled | 2 ms | 116 ms | verified |
| 2 | `semantic-compiler-4c4ef0ee-2d9b-44b9-9fb4-06f36771bfc3` | `semantic-resolved-ba9bef91-b63f-4545-acbf-dc3ba16b5bb2` | compiled | 1 ms | 106 ms | verified |
| 3 | `semantic-compiler-0334a91c-aac7-42f0-9b60-c95347f39936` | `semantic-resolved-df985e88-76b8-42a0-af4b-a8252af0a08a` | compiled | 1 ms | 95 ms | verified |
| 4 | `semantic-compiler-66653c1e-6c7a-4353-b71e-26001c59b541` | `semantic-resolved-71a954bb-0574-49dc-a562-b6c139354b9c` | compiled | 1 ms | 101 ms | verified |
| 5 | `semantic-compiler-42c536d1-70ee-46f0-b574-96d444353c06` | `semantic-resolved-8d450bda-231c-4ae4-bd3c-f893d12dc20b` | compiled | 1 ms | 93 ms | verified |
| 6 | `semantic-compiler-1777760c-86f1-455d-a359-e4c112ad2289` | `semantic-resolved-460b2697-9dca-4e3e-b3be-9e9510719929` | compiled | 1 ms | 91 ms | verified |
| 7 | `semantic-compiler-ea271892-aaae-41fc-8220-59b74761db97` | `semantic-resolved-a34acedd-276b-4d97-9b4d-7e785feac067` | compiled | 1 ms | 99 ms | verified |
| 8 | `semantic-compiler-98b94f7a-13f4-443f-a705-d4669705da9b` | `semantic-resolved-d292c304-9cb6-4c54-865b-f25666c32cb5` | compiled | 1 ms | 101 ms | verified |
| 9 | `semantic-compiler-d4c2d3bc-6076-4f21-b830-498b4cac8d05` | `semantic-resolved-b1dd8465-9fe2-417c-b4c3-afcfe5ddd326` | compiled | 1 ms | 114 ms | verified |
| 10 | `semantic-compiler-f7bcbe97-3c7b-44bc-92ba-97e56f77fb98` | `semantic-resolved-ed01f252-5977-4821-86ec-110cac7e0df2` | compiled | 1 ms | 96 ms | verified |

All ten attempts passed the repeated-control invariants: Add #1 and #2 compiled as click operations with one-candidate domains, with no persistent identity relation on Add #2; the Delete count assertions retained complete-set counts 2 and 1; the first Delete retained complete domain size 2, ordinal 1/index 0, and click. Every non-navigation step had source/current correspondence; all compiler-current evidence ages at consumption were 0–2 ms; all pre-dispatch freshness checks, post-action receipt freshness checks, and action seals passed. Source witness times were not refreshed.

- Compiler success: **10/10**; cleanup: **10/10**.
- Provider calls: **0**; public-site calls: **0**; all attempts used two local fixture fulfillments and zero blocked requests.
- Unique canonical ResolvedTestSpec digests: **1** — `fd004160b00ac035f78228e669fa01cd53b59132887efff0a5edb41e1f28e449`.
- Material compiler variance: **no**. Correspondence/freshness failures: **none**. Typed stops: **none**.
- Runner v10, replay pair v2, and QA were not invoked.

Attempt records and compiler diagnostic evidence are under `artifacts/semantic-compiler-v5-stability-2026-10-07T00-45-33.052Z-68b804e3-a281-42ef-bb20-646927dbb9f2/`. The experiment driver is `tools/experiments/semantic/compiler/semantic-compiler-v5-stability-experiment.mjs`.

Recommended next experiment: run the existing replay-pair-v2 stability cohort from one fixed authenticated ResolvedTestSpec v10, using fresh local fixture state for each replay pair.

## Frozen source now available (2026-10-06)

The `INCONCLUSIVE` result below describes the earlier attempted compiler cohort and is unchanged: **zero compiler attempts ran then**. A separate implementation task has since added the immutable, root-local HMAC-SHA256 `semantic-grounded-trace-v1` artifact (storage version `1`). The reader requires the matching trusted semantic admission, authenticates the complete trace and source/profile bindings, validates inline evidence/witness/receipt digests, and reissues an in-process historical trace capability. It does not restore live browser authority or reset the original witness timestamps. Compiler v5 must still open a new protected browser, re-ground, prove source/current correspondence, validate current evidence at point of use, and check action effects.

One **TEST_FIXTURE_ONLY** D1-equivalent semantic fixture underwent one new schema-5 `local-windows` grounding against the deterministic local route. It produced exactly one successful eight-record trace with full repeated-control cardinality/ordinal invariants, two local fixture responses, zero provider/public-site requests, and verified cleanup. Its semantic digest was D1 `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d`; the experiment projection and the authenticated reloaded complete trace both recomputed G1 `58042676cb5771cd8d17a6ed7869c825f7b7d5d2f91aba0aa32e27d06e8448f7`.

| Frozen item | Identity |
|---|---|
| TestSpec ID | `semanticGroundingTestFixture4828925d3c5243b794ad9396f08cf55d` |
| Grounding attempt ID | `semanticGroundingAttempt015365fc061a02429b8ba9a3fef893b036` |
| Trace ID | `semanticTrace5ce542b7f265671bd3d0a585af0e7bb9` |
| Full trace digest | `5ce542b7f265671bd3d0a585af0e7bb97f4fd7d3f38760dba9662b8cef67f8d4` |
| Trace/evidence contracts | `semantic_grounded_trace_v1` / `semantic_grounding_evidence_v1` |
| Profile | schema-5 `local-windows`, bundled Playwright Chromium; fingerprint is authenticated in the private artifact |
| Authenticated artifact | `artifacts/semantic-grounding-v1-test-fixture-2026-10-07T00-28-52.867Z-59a84ae1-bfbe-4441-8c77-1d3a892e83ce/semantic-grounded-trace-v1/semanticGroundingTestFixture4828925d3c5243b794ad9396f08cf55d/semanticGroundingAttempt015365fc061a02429b8ba9a3fef893b036.json` |

An independent Node process rebuilt a fresh **test-only** admission from the fixed fixture source and the stored TestSpec ID, authenticated the artifact through `SemanticGroundedTraceV1Store`, and read all eight records with the same trace digest. The shared test-only source builder is `tools/experiments/semantic/grounding/semantic-grounding-v1-test-fixture-source.mjs`. This provenance is a deterministic fixture matched to the prior live interpretation digest, **not** a newly provider-generated or fidelity-reviewed artifact. The previous compiler cohort was not retried; the next experiment can use this one frozen trace for ten independent fresh compiler attempts.

## Historical blocked cohort (2026-10-06)

Date: 2026-10-06  
Classification: **`INCONCLUSIVE`** — the required fixed authenticated source trace is unavailable, so no compiler attempts were started.

## Source-trace preflight

The completed local-Windows grounding cohort is recorded at `artifacts/semantic-grounding-v1-test-fixture-2026-10-07T00-11-02.581Z-35abe750-2c84-4ed2-8a49-209ee43048c2/`. Its safe `attempt-01.json` identifies a successful test-only grounding run and reports trace ID `semanticTrace9d031334f65752711c8634b8bb761883`; the cohort report records TestSpec ID `semanticGroundingTestFixtureba42a304cc96430291589caa3d5beda7`, semantic digest D1 `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d`, and canonical grounding digest G1 `58042676cb5771cd8d17a6ed7869c825f7b7d5d2f91aba0aa32e27d06e8448f7`.

The safe per-attempt record contains only the trace ID, digests, and bounded semantic step projections. It does not contain the complete `SemanticGroundedTraceV1` records or an authentication envelope for a reusable trace. An inventory of the cohort artifact root found only those attempt projections, preflight/progress/summary records, the exploration diagnostics authority key, and authenticated exploration-diagnostic records. No trace artifact or compiler-v5 artifact exists for this TestSpec in the workspace. The reported trace ID is derived from an in-memory trace digest; it does not authenticate or reconstruct the trace.

The current `SemanticCompilerV5Store` is not a standalone source trace store: `writeCompilationV5` accepts a runtime-issued trace only together with a successful compiler result and persists the trace inside the authenticated resolved-v10 compilation artifact. The experiment cannot use it to retrieve this pre-compiler trace. Compiler diagnostics v2 store bounded projections, not the complete source trace. The grounding driver constructs its trace with `issueSemanticGroundedTraceV1` in memory and writes the bounded attempt projection; it does not persist the issued trace.

| Source item | Available evidence |
|---|---|
| TestSpec ID | `semanticGroundingTestFixtureba42a304cc96430291589caa3d5beda7` |
| Semantic digest D1 | `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` |
| Candidate successful trace ID | `semanticTrace9d031334f65752711c8634b8bb761883` (reported in bounded attempt projection only) |
| Canonical grounding digest G1 | `58042676cb5771cd8d17a6ed7869c825f7b7d5d2f91aba0aa32e27d06e8448f7` |
| Trace/evidence contracts | Code defines `semantic_grounded_trace_v1` and `semantic_grounding_evidence_v1`; the selected run's full trace/version fields cannot be authenticated from retained evidence |
| Execution profile | Cohort report identifies schema-5 `local-windows` / bundled Chromium; selected trace's profile fingerprint is unavailable |
| Full trace and authenticated readback | Not retained; no standalone authenticated trace store is available for this pre-compiler artifact |

Because a full authenticated trace cannot be loaded, no source trace was selected for compilation. No grounded trace was regenerated, no browser/context was opened, and no compiler attempt was made. This is an artifact-retention gap, not a compiler success or failure.

## Compiler attempt accounting

The ten requested cohort slots were all blocked at source-artifact preflight. They are listed to make the denominator explicit; **zero compiler attempts ran**.

| Slot | Compiler attempt ID | Source trace ID / G1 | Browser/context | Compiler result | Resolved ID / digest | First rejection | Cleanup |
|---:|---|---|---|---|---|---|---|
| 1 | Not created | Unavailable as authenticated input | Not started | Not started | None | Source artifact unavailable | N/A |
| 2 | Not created | Unavailable as authenticated input | Not started | Not started | None | Source artifact unavailable | N/A |
| 3 | Not created | Unavailable as authenticated input | Not started | Not started | None | Source artifact unavailable | N/A |
| 4 | Not created | Unavailable as authenticated input | Not started | Not started | None | Source artifact unavailable | N/A |
| 5 | Not created | Unavailable as authenticated input | Not started | Not started | None | Source artifact unavailable | N/A |
| 6 | Not created | Unavailable as authenticated input | Not started | Not started | None | Source artifact unavailable | N/A |
| 7 | Not created | Unavailable as authenticated input | Not started | Not started | None | Source artifact unavailable | N/A |
| 8 | Not created | Unavailable as authenticated input | Not started | Not started | None | Source artifact unavailable | N/A |
| 9 | Not created | Unavailable as authenticated input | Not started | Not started | None | Source artifact unavailable | N/A |
| 10 | Not created | Unavailable as authenticated input | Not started | Not started | None | Source artifact unavailable | N/A |

- Compiler success: **0/10 attempts started**.
- Provider calls: **0**. Public-site calls: **0**.
- Unique canonical resolved digests: **0**; no resolved artifact was produced.
- Material compiler variance and freshness behavior: **not measured**.
- Cleanup: **not applicable**; no compiler browser/context was created.
- Runner v10, replay pair v2, and QA: **not invoked**.

## Conclusion

Classification is `INCONCLUSIVE`. The grounding baseline is supported by its prior 10/10 report, but this workspace retains only bounded projections for that cohort. Existing authenticated compiler storage starts after successful compilation and cannot supply the original trace for this experiment. Do not interpret these zero attempts as compiler instability.

At the time of this blocked cohort, the next step was to persist and authenticate a complete grounded trace. That step is complete as recorded above. The next experiment is ten independent fresh compiler-v5 attempts using the frozen source artifact.
