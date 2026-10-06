# Windows-native successful-run performance profile

## Scope and evidence

Read-only analysis of the successful gated `deferred-action-v1` / `poc_v1` Windows-native run: TestSpec `local-d0263408-f3c8-48cc-8116-ef2e97d2d25b`, exploration `exploration-82ba2bd7-f2dd-4459-8acf-799c3849b757`, trace `trace-62e7c46e-87bc-490b-b52e-6cfc7c11541c`, compiler `compiler-8bb47b29-afae-4f97-8f4d-49620ae7ff4e`, resolved spec `resolved-eedc5076-6bec-4c99-90ed-304c1f7ac7b8`, and runs `run-d0d67717-b8e8-4960-8ffd-14ba7557b920` and `run-6b644df5-c9aa-41c2-88b4-a583ae5a59f0`. Both runs completed true, agreement was `agreed`, the terminal was `QA_ASSERTION_PASSED`, and cleanup was verified. No workflow, provider, or public-site call was made for this analysis.

Sources are the six retained job artifacts under `jobs/structured-action-20260930-220304-1cba42dfafc0461492cfe9745ba14bfa/artifacts/` (startup, browser and verification diagnostics, successful trace, compiler/resolved record, and replay pair); the current deferred production, compiler v4, runner v9, candidate grounding, and viewer code; and [current status](current-status.md). The artifacts are restricted; this report contains only timings and bounded conclusions. Wall timestamps are UTC. Durations from paired timestamps are exact to the stored millisecond; an **envelope** includes more than the named operation. Diagnostic `elapsedMs` is rounded. The browser diagnostic monotonic clock has no persisted wall-time origin, so it is used for durations, not to manufacture absolute timestamps.

## Whole-workflow result

**True UI/request-to-terminal end-to-end duration is not retained.** The exact retained browser-onward span, from exploration `session_open` start at `04:10:36.409` to replay-pair finish at `04:12:51.934`, is **135.525 s**. It is a lower bound on the full workflow. The four recorded phase durations sum to 135.198 s; interphase/persistence gaps total 0.327 s. The provider phase precedes this span, and final projection/host delivery follows it.

The first browser-phase viewer event occurred at `performance.now() = 5.893 s` in the same Node process that performs interpretation before browser work. Thus **all pre-browser process work combined**, including primary provider call, fidelity review, normalization, admission, and process initialization, was under 5.893 s. This is an upper bound, not a provider measurement. Primary, fidelity, and their exact sum cannot be recovered; successful interpretation timing remained in private in-memory accounting and was not persisted for this run. Exploration also may call models for grounding/verification. Its entire time outside the measured root navigation and destination DCL wait is only **1.648 s**, which bounds those later model calls together with all other exploration work. The compiler and replays make no model calls. Consequently all provider work combined is below **7.541 s** on these conservative bounds, too small to explain the dominant delay; the exact share is unknown. The whole Node path through replay-pair finish was between 135.525 and approximately 141.418 s under the same-process monotonic-clock assumption, excluding unmeasured post-pair work. Neither endpoint is an exact UI end-to-end duration.

| Measure | Retained value | Confidence/limit |
|---|---:|---|
| Primary interpretation | Unknown | No successful timing record persisted |
| Fidelity review | Unknown | No successful timing record persisted |
| Primary + fidelity interpretation provider total | Unknown; **<5.893 s** including all pre-browser work | Strict upper bound from same-process monotonic event; later exploration model calls are not in this bound |
| Exploration, session-open start to trace finish | **65.012 s** | Exact recorded timestamps; phase cleanup after trace is outside this interval |
| Compiler | **1.940 s** | Exact attempt timestamps, verified cleanup |
| Replay 1 | **61.527 s** | Exact run timestamps, verified cleanup |
| Replay 2 | **6.719 s** | Exact run timestamps, verified cleanup |
| Browser-process/session startup, four owners | Exploration **0.162 s** measured; total unknown | Other three starts have no isolated timestamp |
| Root navigation/readiness plus two destination DCL waits | **130.304 s** in measured navigation/pre-click envelopes and exact waits | Envelopes include startup/target proof; do not equate all of this with network time |
| Physical click/select invocations, four owners | **0.510 s** total | Excludes grounding, locator proof, assertions and readiness |
| Diagnostic-only grounding browser probes | **0.066 s** summed | Sequential, awaited exploration probes; small direct avoidable cost |
| Viewer successful JPEG captures | **4 frames, 0.151 s** summed capture time | Asynchronous and not established as critical-path latency |

The five largest visible contributors are exploration root navigation **33.336 s**, replay 1 pre-click/root-readiness envelope **30.777 s**, replay 1 `/dropdown` DCL wait **30.105 s**, exploration `/dropdown` DCL wait **30.028 s**, and replay 2 pre-click/root-readiness envelope **6.058 s**. The pre-click replay envelopes include session startup, root navigation, state and target proof; the exact root-only portion is not retained. These five nonoverlapping intervals total **130.304 s**, about **96.1%** of the browser-onward span. In particular, the two genuine 30-second committed-document waits are public-site latency observed at a required correctness boundary, not application overhead.

## Phase reconstruction

### Exploration

| Boundary | Duration or envelope | Evidence and interpretation |
|---|---:|---|
| Fresh session/browser open | **0.162 s** | Startup diagnostic `session_open` |
| Root navigation to DOMContentLoaded | **33.336 s** | Startup `root_navigation`; root response was 2xx, zero redirects, and committed |
| First observation/protected state | **0.007 / 0.010 s**, overlapping | Startup diagnostics; do not add both |
| First Dropdown grounding decision | **0.270 s** | Startup diagnostic; first action preparation was observed immediately after |
| Click invocation | **0.134 s** | Action witness `04:11:10.316` to `04:11:10.450` |
| Resulting-URL verification | **0.019 s** controller, **0.007 s** observation | Verification diagnostic; URL read follows click |
| `/dropdown` committed-document DCL wait | **30.028 s** | Browser diagnostic says `readinessWaitRequired=true`, success in same document generation |
| Post-DCL state/select grounding | At most about **0.45 s** from click return plus wait to select invocation | Includes state acquisition, candidate query (about 0.093 s), fresh proof and orchestration; boundaries overlap and cannot be split exactly |
| Select invocation | **0.006 s** | Action witness `04:11:40.926` to `04:11:40.932` |
| Selected-option verification | **0.253 s** controller, with **0.123 s** observation attempt | Verification diagnostic; do not add nested spans |
| Remaining trace assembly/finish | About **0.25 s** after selected-option observation at `04:11:41.169` to trace finish `04:11:41.421` | Includes finalization; isolated trace-store/cleanup time not retained |

The successful trace begins after root readiness, at `04:11:09.920`, and finishes at `04:11:41.421` (**31.501 s**); almost all of that interval is the destination DCL wait.

### Fresh compiler

Compiler attempt `04:11:41.609`–`04:11:43.549` (**1.940 s**), with verified cleanup. Session startup, root navigation, adopted navigation state, and initial proof are bundled in the **1.195 s** from attempt start to observed adopted navigation at `04:11:42.804`; they cannot be individually timed. First click preparation was observed at `04:11:42.863`, and click invocation took **0.111 s** (`42.925`–`43.036`). The URL observation took **0 ms rounded**. Select preparation was observed at `43.149`; select invocation took **0.002 s** (`43.255`–`43.257`). The native selected-option observation took **0.071 s** (`43.312`–`43.383`). The final **0.166 s** to attempt finish includes validation/close/record work. The destination was ready when DOM-dependent reads ran; no positive compiler DCL wait is retained. There is no evidence for a separate 30-second compiler wait in this run.

### Replay 1 and replay 2

| Boundary | Replay 1 | Replay 2 | Interpretation |
|---|---:|---:|---|
| Total, including cleanup | **61.527 s** | **6.719 s** | Both completed true with verified cleanup |
| Start through first click invocation | **30.777 s** | **6.058 s** | Fresh browser startup, root navigation/DCL, adopted navigation state and first target freshness proof bundled |
| Click invocation | **0.122 s** | **0.118 s** | Stored `invokedAt`/`returnedAt` |
| Resulting-URL assertion | Not separately timed | Not separately timed | Runs show assertion passed; URL-only verification can precede destination DCL |
| `rich_after_url` state acquisition | **30.134 s** | **0.068 s** | Browser diagnostics; includes DCL wait and frame/state reads |
| Committed-document DCL portion | **30.105 s** | **0.034 s** | Nested inside `rich_after_url`, not additive |
| Non-wait rich-state work | About **0.029 s** | About **0.034 s** | Difference of rounded nested diagnostics |
| Select locator/freshness proof | Not isolated; between rich state and invocation | Not isolated; between rich state and invocation | Runner code repeats unique fresh proof before dispatch |
| Select invocation | **0.009 s** | **0.008 s** | Stored action timestamps |
| Selected-option assertion and cleanup | Not separately timed | Not separately timed | Both assertions passed; final run timestamp includes close and verified cleanup |

Replay 1's slow root and destination were not reproduced in replay 2: the latter reached its first click in 6.058 s and needed only 34 ms of destination DCL waiting. This variability is evidence of target timing variation, not a reason to relax readiness or replay agreement.

## Repeated work, diagnostics, and viewer

1. **Root navigations:** exactly **four physical root navigations**, one in exploration, compiler, and each fresh replay. All four authored first-navigation records have `bootstrapAdopted=true`; there is no second root request due to the already-adopted authored step. The retained root bootstrap is still necessary to establish each fresh owner's starting state. The adopted step performs additional state/provenance checks, but their isolated cost is not retained and no large duplicate navigation remains.
2. **Destination readiness:** `/dropdown` is independently reached by **four fresh owners** and must independently reach DOMContentLoaded four times under the current contract. Exploration and replay 1 had measured waits of 30.028 and 30.105 s; compiler had no positive retained wait, and replay 2 waited 0.034 s. Reusing another owner's readiness would break same-document freshness.
3. **Compiler duplication:** the compiler repeats navigation, click, URL observation, selection, selected-option check, and unique target grounding in a separate browser. This is deliberate resolved-spec correctness proof across contexts. The entire compiler cost was only 1.940 s in this run. Removing its fresh browser work or copying exploration locators would weaken the current compiler authority boundary; there is no evidence of a large correctness-preserving compiler deletion.
4. **Browser startup:** four fresh sessions are required by the present exploration/compiler/two-replay structure. Only exploration's open is isolated at 0.162 s. The other open costs are embedded in phase intervals, so a four-session startup total is **unknown**. The compiler's full 1.940 s caps its startup, and replay start-to-first-click envelopes cap startup plus root/proof, but neither is a startup measurement.
5. **Synchronous/awaited diagnostics:** exploration candidate enumeration calls optional `#enumerationProbe` reads in `app/exploration/action-candidate-grounding.ts`. The two `native_select_inventory` probes consumed 15 and 34 ms; three `role_pre_name` probes consumed 6, 5 and 2 ms; one `role_post_name` probe consumed 4 ms: **66 ms** of extra, sequential awaited browser queries. They are diagnostic-only and do not authorize targets. The underlying authoritative candidate queries themselves took about 125 and 93 ms and are correctness work. Runner diagnostic wrappers mostly time existing operations (`rich_after_url`, frame content, state, ownership); their 30-second entries are underlying readiness waits, not added diagnostic delay. Viewer/diagnostic emission uses synchronous local in-memory callbacks; no retained evidence establishes a significant serialization cost.
6. **Viewer:** view was enabled. The retained browser diagnostics show **179 capture attempts**: 175 transient skips during `about:blank`/navigation and four successful JPEGs (two exploration, one compiler, zero replay 1, one replay 2). There were **zero `capture_timeout` events** and no terminal capture failure in this successful run. The four successful captures took 86, 18, 0 and 47 ms by phase, **151 ms** total; skipped attempts were rounded to 0 ms each. The capture timer launches `void #captureFrame(...)` at the 750 ms cadence, and execution does not await a frame. Viewer phase notices are synchronous local calls, with no measurable separate span. Browser resource contention is possible but unmeasured; the record does **not** support attributing any of the 30-second DCL waits to viewer work.

## Cost classification

These labels describe cause/necessity and overlap; do not sum them as disjoint budget lines.

| Cost | Classification | Evidence / confidence |
|---|---|---|
| Root and destination network/document readiness | `EXTERNAL_TARGET_LATENCY`; DCL gate also `REQUIRED_CORRECTNESS_COST` | High for 33.336 s exploration root and 60.133 s combined long destination waits; medium for replay pre-click envelopes because they include our startup/proof |
| Fresh compiler, two fresh replays, and agreement | `REQUIRED_REPRODUCIBILITY_COST` | High; accepted compiler and agreeing independent completed records |
| Unique fresh target proof and same-document DCL check | `REQUIRED_CORRECTNESS_COST` | High from current code/contracts and live waits |
| Interphase/persistence gaps | `ORCHESTRATION_OVERHEAD` | **0.327 s** measured between recorded phases; exact internal constituents unknown |
| Optional enumeration probes | `DIAGNOSTIC_OVERHEAD`, `OPTIMIZATION_CANDIDATE` | **0.066 s** measured sequential awaited reads; high confidence |
| Viewer JPEG/skip loop | `DIAGNOSTIC_OVERHEAD` | Four successful captures total 0.151 s of asynchronous work; critical-path effect unmeasured |
| Provider work | Unknown split; no supported optimization classification | Initial interpretation is below 5.893 s; all provider work including exploration calls is below 7.541 s by conservative residual bound |

At least **93.469 s** is directly measured root navigation plus the two long DCL waits. The replay pre-click envelopes add another **36.835 s**, mostly root readiness but with our startup/proof mixed in. The observed avoidable critical-path cost with a precise measurement is **66 ms** of diagnostic-only probes, plus an unallocated fraction of 0.327 s interphase gaps. There is no evidence of a correctness-preserving tens-of-seconds saving in this successful run. Before/after performance claims must use the same public target and phase instrumentation; the target's observed variability means a single-run wall-clock comparison would be weak evidence. Such a validation would require a separately authorized public workflow and is outside this read-only analysis.

## Ranked optimization candidates

| Rank | Candidate and exact cost targeted | Affected path | Correctness risk / fallback | Expected impact | Before demo? |
|---|---|---|---|---|---|
| 1 | Put **66 ms** of optional enumeration count probes behind a private diagnostic opt-in (or reuse already obtained counts without new browser calls). | `ActionCandidateGroundingSessionV1.#enumerate` / `#enumerationProbe` | Low QA risk: probes do not decide candidates. Reduced routine forensics is the tradeoff; keep an opt-in to restore counts. Check normal unique target, missing target failure, and compiler/replay integration offline. | **Small** | **No**; it cannot move a roughly 135-second browser span materially. |
| 2 | Avoid repeated protected state reads around an already-adopted root step, **cost not isolated** and bounded by small non-navigation portions of the four phases. | Exploration trace assembly, compiler v4 adopted navigate branch, runner v9 adopted navigate branch | Medium: must retain ordered state/provenance and mutation detection. Fall back to existing reads on any continuity uncertainty. | **Small / unproven** | **No** without targeted timings and proof fixtures. |
| 3 | Reduce viewer capture/browser resource contention, **critical-path cost not established**; at most 151 ms successful capture work is recorded and asynchronous. | Windows deferred viewer timer/CDP capture | Low to medium: frames may disappear or lag; maintain phase isolation and no QA authority. Use view-on/off A/B before changing. | **Small / unproven** | **No**. |

**Recommended next atomic implementation task:** make the six diagnostic-only inventory/pre-name/post-name count probes in `ActionCandidateGroundingSessionV1.#enumerate` privately opt-in, defaulting off, while retaining authoritative enumeration and fresh target proof. Add one offline normal-path unique Dropdown test, one no-candidate failure test, and one full local five-step compiler/two-replay integration test with the flag off; confirm QA classification and cleanup match the current path. Re-enable the flag as a fallback during investigations. Expected saved time on this workload is **about 66 ms**, so this is low priority and should **not delay the demo**. A more ambitious latency change is not justified by the retained evidence. Separately, retaining a bounded successful-run provider/phase timing summary would close the present end-to-end measurement gap, but it does not itself reduce wall-clock time.
