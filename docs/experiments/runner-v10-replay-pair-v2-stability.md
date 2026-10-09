# Runner v10 / replay-pair v2 fixed-input stability

> **D1 status: preparation/readback tools are opt-in runnable; replay cohort remains unrun (2026-10-07).** Current compiler-v5/Resolved-v10 fixture preparation uses a native schema-5 local browser; the verifier is readback-only. The last known preparation accepted one artifact and verified R1, while the replay-pair cohort below did not start. Original frozen paths are absent here. The [experiment index](../../tools/experiments/README.md) gives the relocated tools, built-`dist/` prerequisite, and explicit authenticated trace/resolved artifact inputs. No D1 replay or provider/public-site run occurred.

D1 bounded verification: a newly frozen provider-free G1 trace passed compiler preflight; one fresh compiler-v5 preparation accepted Resolved v10, verified cleanup and authenticated readback, and recomputed the same R1. The readback-only verifier independently passed its repeated-control checks. The experiments use the fresh authenticated trace identity and compare the admission record's spec hash to another authenticated admission record, rather than confusing it with the canonical semantic projection digest. Neither runner nor replay pair was invoked.

## Frozen ResolvedTestSpec-v10 fixture preparation (2026-10-07)

One fresh compiler-v5 attempt was run from the existing authenticated historical trace, solely to prepare a replay fixture. The trace reader verified semantic digest D1 `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d` and grounding digest G1 `58042676cb5771cd8d17a6ed7869c825f7b7d5d2f91aba0aa32e27d06e8448f7`. Compilation used the schema-5 `local-windows` profile and deterministic local repeated-control fixture; no provider or public-site traffic occurred. Compiler v5 returned accepted and cleanup was verified.

The complete result was persisted by the existing `SemanticCompilerV5Store` (storage version 5, `semantic-compiler-v5-resolved-v10` namespace), then independently read through `readResolvedV10` after dropping the original in-memory compilation and admission references. Authentication, trace/source binding, profile fingerprint, compiler version, full resolved-v10 schema, repeated-control invariants, and fresh `TrustedSemanticResolvedReadbackV10` runner-input authority passed. Recomputed canonical R1 exactly matches `fd004160b00ac035f78228e669fa01cd53b59132887efff0a5edb41e1f28e449`.

| Frozen item | Verified value |
|---|---|
| Source trace | `semanticTrace5ce542b7f265671bd3d0a585af0e7bb9` |
| ResolvedTestSpec ID | `semantic-resolved-402c9c14-1eb0-4e75-b473-4a1fe7c58c9e` |
| Compiler attempt ID | `semantic-compiler-c43467bb-0759-4e97-bb6a-f6c14587930f` |
| Resolved artifact | `artifacts/semantic-resolved-v10-replay-fixture-2026-10-07T00-57-37.584Z-09dcfc5c-8342-4779-8d3a-2e27d76ebf34/semantic-compiler-v5-resolved-v10/semanticGroundingTestFixture4828925d3c5243b794ad9396f08cf55d/semantic-compiler-c43467bb-0759-4e97-bb6a-f6c14587930f.json` |
| Profile | schema-5 `local-windows`, `semantic-stability-experiment` v1; fingerprint authenticated and matched |
| Expected / recomputed R1 | `fd004160b00ac035f78228e669fa01cd53b59132887efff0a5edb41e1f28e449` / same |
| Readback runner input | Fresh trusted capability recreated; runner not invoked |

The first preparation wrapper exited after the store write because its post-write reporting code cleared the writer return value before inspecting it. The compiler attempt and verified cleanup had already completed, and the authenticated artifact was present. A separate reader-only verifier then authenticated the persisted record and confirmed R1 and invariants; no second compiler attempt was made. The helper bookkeeping was corrected for future use. Replay, runner execution, and QA have not started. This fixture is ready for the separate replay-pair stability cohort.

## Phase 0 result (2026-10-07)

Classification: **`INCONCLUSIVE`**. The replay cohort did not start. Phase 0 found no complete authenticated ResolvedTestSpec v10 artifact retained by the compiler-v5 stability cohort, so **0 replay pairs and 0 individual replay runs** were attempted.

The cohort report and attempt records retain resolved IDs and a bounded canonical projection digest only. The compiler experiment driver (`tools/experiments/semantic/compiler/semantic-compiler-v5-stability-experiment.mjs`) computes the projection in memory and writes safe attempt summaries plus compiler diagnostics. It does not call `SemanticCompilerV5Store.writeCompilationV5`. An inventory of the compiler cohort artifact root found only `attempt-01.json` through `attempt-10.json`, `summary.json`, and the compiler-diagnostics store; no `semantic-compiler-v5-resolved-v10` authenticated artifact namespace/file exists there. The summaries cannot be used to reconstruct a resolved artifact.

The repository does provide `SemanticCompilerV5Store` with authenticated `readResolvedV10(...)` readback. It validates the complete resolved-v10 record together with its compiler record and historical grounded trace, checks profile/source/compiler bindings against the supplied trusted semantic admission, and returns a new trusted readback boundary. That supported mechanism was not used to retain the compiler cohort's successful outputs. No replay input was loaded or minted.

The authoritative cohort records give canonical resolved digest R1 as `fd004160b00ac035f78228e669fa01cd53b59132887efff0a5edb41e1f28e449`. The requested expected digest ends in `...e449f7`, which does not match the retained cohort value. Because there is no authenticated artifact, R1 could not be independently recomputed or verified for replay use; the bounded report value is not a substitute.

| Pair slot | Resolved artifact/authentication | Replay 1 | Replay 2 | Agreement / QA | Cleanup |
|---:|---|---|---|---|---|
| 1 | unavailable; preflight stopped | not started | not started | not evaluated | N/A |
| 2 | unavailable; preflight stopped | not started | not started | not evaluated | N/A |
| 3 | unavailable; preflight stopped | not started | not started | not evaluated | N/A |
| 4 | unavailable; preflight stopped | not started | not started | not evaluated | N/A |
| 5 | unavailable; preflight stopped | not started | not started | not evaluated | N/A |
| 6 | unavailable; preflight stopped | not started | not started | not evaluated | N/A |
| 7 | unavailable; preflight stopped | not started | not started | not evaluated | N/A |
| 8 | unavailable; preflight stopped | not started | not started | not evaluated | N/A |
| 9 | unavailable; preflight stopped | not started | not started | not evaluated | N/A |
| 10 | unavailable; preflight stopped | not started | not started | not evaluated | N/A |

- Authenticated fixed resolved artifact available: **no**. ResolvedSpec ID/path for a reusable authenticated artifact: **none**.
- Replay pairs started: **0/10**; individual run success: **0/20 started**.
- Replay-pair agreement and QA pass rates: **not measured**.
- Cleanup: **not applicable**; no replay browser/session was created.
- Provider calls: **0**; public-site calls: **0**.
- Unique canonical execution-result digests: **0**; execution variance: **not measured**.
- Runner, replay-pair, and QA behavior were not exercised.

**Next action:** use the existing authenticated `SemanticCompilerV5Store.writeCompilationV5` boundary for one successful compiler-v5 result, retain its complete artifact, and verify the resolved digest against an agreed canonical R1. Then run the fixed-input replay cohort from that trusted reader. Do not reconstruct the artifact from projections or reports.
