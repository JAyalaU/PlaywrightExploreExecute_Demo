# Semantic grounding v1 stability experiment

> **D1 status: opt-in runnable provider-free fixture and provider-assisted driver (2026-10-07).** Current semantic-grounding-v1 on native schema-5 local Windows. The last measured provider-free local cohort below was stable 10/10. The [fixture driver](../../tools/experiments/semantic/grounding/semantic-grounding-v1-test-fixture-stability.mjs) needs built `dist/` and Windows Chromium for `smoke`/`freeze`/`cohort`; `SEMANTIC_GROUNDING_TEST_FIXTURE_PREFLIGHT_ONLY=1` checks only the deterministic source. The separate [provider-assisted driver](../../tools/experiments/semantic/grounding/semantic-grounding-v1-stability-experiment.mjs) additionally requires its opt-in gate and provider credentials. No D1 cohort was run; the earlier Docker section below is historical only.

D1 bounded verification: one `SEMANTIC_GROUNDING_TEST_FIXTURE_MODE=freeze` attempt succeeded, authenticated its complete grounded trace, returned G1, intercepted two local fixture requests, blocked zero requests, made zero provider/public-site calls, and closed cleanly. It produced a new trace identity as expected; no historical trace was regenerated silently.

Date: 2026-10-06  
Latest classification: **`GROUNDING_STAGE_STABLE`** for the local-Windows, deterministic test-only cohort.

## Local-Windows correction and measured cohort

The driver `tools/experiments/semantic/grounding/semantic-grounding-v1-test-fixture-stability.mjs` had read `PLAYWRIGHT_DEMO_BROWSER_BACKEND` through `parseTrustedBrowserBackend`; when unset, that function selects `docker-isolated`, and the driver built a schema-3 Docker profile. The corrected driver explicitly selects `local-windows`, validates a schema-5 `LocalWindowsExecutionProfileSchema` with `browserRuntime: playwright-chromium-windows`, resolves it through `ProfileCatalog`, checks the factory backend and effective profile, then calls the existing `ProtectedContextFactory` through `McpExplorationSession.open`. That factory launches bundled Playwright Chromium on Windows. No Docker path, fallback, direct Playwright session, provider, or public-site request was used. The in-process fixture route fulfilled exactly the authored root and destination URL paths and aborted everything else.

The unchanged eight-step `TEST_FIXTURE_ONLY` fixture matched semantic digest D1, `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d`. This is canonical projection equality to the earlier interpretation cohort; it is not a newly provider-extracted, fidelity-reviewed, production-admitted artifact. Each attempt minted fresh test-only in-memory admission authority. The driver now requires an explicit `smoke` or `cohort` mode; one smoke attempt was run and checked before the ten-attempt cohort.

| Measurement | Attempts | Grounded traces | Cleanup verified | Fixture responses | Provider calls | Unique grounding digests |
|---|---:|---:|---:|---:|---:|---:|
| Smoke | 1 | 1 | 1 | 2 | 0 | 1 |
| Cohort | 10 | 10 | 10 | 20 | 0 | 1 |

Smoke TestSpec ID: `semanticGroundingTestFixtureae02e8c5a192492cb589f82b8d460d66`. Cohort TestSpec ID: `semanticGroundingTestFixtureba42a304cc96430291589caa3d5beda7`; all ten cohort attempts used that same fixed semantic fixture and fresh protected sessions. Every cohort attempt produced the same canonical grounding digest, `58042676cb5771cd8d17a6ed7869c825f7b7d5d2f91aba0aa32e27d06e8448f7`.

| Cohort attempt | Grounding | Add 1 / Add 2 | Delete count 2 | First Delete | Delete count 1 | Cleanup | Digest |
|---:|---|---|---|---|---|---|---|
| 1 | Success | Pass / pass | Pass | Pass | Pass | Pass | Same |
| 2 | Success | Pass / pass | Pass | Pass | Pass | Pass | Same |
| 3 | Success | Pass / pass | Pass | Pass | Pass | Pass | Same |
| 4 | Success | Pass / pass | Pass | Pass | Pass | Pass | Same |
| 5 | Success | Pass / pass | Pass | Pass | Pass | Pass | Same |
| 6 | Success | Pass / pass | Pass | Pass | Pass | Pass | Same |
| 7 | Success | Pass / pass | Pass | Pass | Pass | Pass | Same |
| 8 | Success | Pass / pass | Pass | Pass | Pass | Pass | Same |
| 9 | Success | Pass / pass | Pass | Pass | Pass | Pass | Same |
| 10 | Success | Pass / pass | Pass | Pass | Pass | Pass | Same |

For every successful attempt, both Add actions had one candidate, reviewed `click`, and successful receipts; the second Add required no persistent element identity. Delete-count verifications used complete candidate domains with observed counts 2 and 1. First Delete used the current complete two-candidate domain, authored ordinal 1, selected index 0, successful ordinal proof, and successful click. All ten attempts had two local fixture responses, zero blocked or public requests, and successful MCP/protected browser cleanup. No material grounding decision variance or closed failure occurred. Smoke artifact root: `artifacts/semantic-grounding-v1-test-fixture-2026-10-07T00-10-56.023Z-fb7aac5c-0206-40b9-b1ae-5b51875ad6fe/`; cohort root: `artifacts/semantic-grounding-v1-test-fixture-2026-10-07T00-11-02.581Z-35abe750-2c84-4ed2-8a49-209ee43048c2/`.

Validation: script syntax, build, and typecheck passed; relevant local-Windows/backend/semantic-grounding tests passed 29/29; `npm test` passed 188/188. The broader focused run passed 44 tests but stopped on the separate deferred live-view baseline test with `ENVIRONMENT_FAILED`; that single test repeated the same stop in isolation, before its viewer scenario. It does not exercise this stability driver. Compiler, runner, replay, and QA were not run by the measurement.

The earlier Docker diagnosis and 0/10 cohort below are historical results from the stale driver, not current local-Windows grounding evidence.

## Historical test-only deterministic fixture cohort (stale Docker driver)

The earlier provider-free cohort used an explicitly `TEST_FIXTURE_ONLY` semantic-v7 fixture, built with the repeated-control acceptance-test step pattern and passed through the production structural normalizer, relation canonicalizer, and semantic digest function. It contains exactly eight steps: root navigation, Add/Remove link activation, destination URL equality, two Add activations, complete Delete counts of two and one, and first Delete activation. The repeated Add targets and complete-set count subjects have `unspecified` relations; first Delete has ordinal `1`, relation `unspecified`, and desired effect `activate`.

The recomputed canonical semantic digest matched D1 exactly: `154178faf5a1705a692c61464671e64ed1cedf478db90aeccdcb3c7cc821da7d`. This establishes equality of the canonical semantic projection to the previously stable 10/10 production interpretation cohort. It does **not** represent a live provider extraction, fidelity review, or production admitted artifact. The experiment reused the in-memory `admitSemanticIntentV3` fixture pattern already used by `tests/semantic-grounding-v1.spec.ts`, minted a fresh test-only capability per attempt, and did not call `AdmittedSemanticTestSpecV7Store`.

| Attempt | TestSpec ID | Fresh test-only capability | Protected browser/context | Grounding result | First closed stop | Cleanup | Grounding digest |
|---:|---|---|---|---|---|---|---|
| 1 | `semanticGroundingTestFixture758e99b1a1b24a479d05393ba2b03b05` | Yes | Failed before initialization | Not reached | `UNKNOWN_EXPLORATION_FAILURE` at `mcp_session_started` | Initialization failure path; completion unverified | None |
| 2 | same | Yes | Failed before initialization | Not reached | `UNKNOWN_EXPLORATION_FAILURE` at `mcp_session_started` | Initialization failure path; completion unverified | None |
| 3 | same | Yes | Failed before initialization | Not reached | `UNKNOWN_EXPLORATION_FAILURE` at `mcp_session_started` | Initialization failure path; completion unverified | None |
| 4 | same | Yes | Failed before initialization | Not reached | `UNKNOWN_EXPLORATION_FAILURE` at `mcp_session_started` | Initialization failure path; completion unverified | None |
| 5 | same | Yes | Failed before initialization | Not reached | `UNKNOWN_EXPLORATION_FAILURE` at `mcp_session_started` | Initialization failure path; completion unverified | None |
| 6 | same | Yes | Failed before initialization | Not reached | `UNKNOWN_EXPLORATION_FAILURE` at `mcp_session_started` | Initialization failure path; completion unverified | None |
| 7 | same | Yes | Failed before initialization | Not reached | `UNKNOWN_EXPLORATION_FAILURE` at `mcp_session_started` | Initialization failure path; completion unverified | None |
| 8 | same | Yes | Failed before initialization | Not reached | `UNKNOWN_EXPLORATION_FAILURE` at `mcp_session_started` | Initialization failure path; completion unverified | None |
| 9 | same | Yes | Failed before initialization | Not reached | `UNKNOWN_EXPLORATION_FAILURE` at `mcp_session_started` | Initialization failure path; completion unverified | None |
| 10 | same | Yes | Failed before initialization | Not reached | `UNKNOWN_EXPLORATION_FAILURE` at `mcp_session_started` | Initialization failure path; completion unverified | None |

Authenticated `SemanticExplorationDiagnosticsV1Store` readback returned the same closed failure for all ten distinct exploration attempt IDs. Each record reports browser/context/page as unknown, no page count or URL, and navigation `not_started`; no successful trace ID was issued. No browser context was returned by `McpExplorationSession.open`, so semantic grounding itself ran **0/10**. The attempts made zero provider calls and the local-only fixture route received zero requests. No retries were made.

- Grounding success rate: **0/10**; all ten stopped before grounding initialization.
- Provider calls: **0**.
- Unique canonical grounding digests: **0** (no grounded traces).
- Material grounding-decision variance: **not measurable**.
- Repeated Add/cardinality/ordinal invariants: **not exercised**.
- Cleanup: **0/10 independently verified**; failure occurred within protected MCP session creation before a session handle was returned.
- Artifact root: `artifacts/semantic-grounding-v1-test-fixture-2026-10-06T23-43-02.547Z-1cdb2ffe-f24c-4f8b-9dd4-14257b591d11/`.

Classification is `INCONCLUSIVE`: the canonical semantic fixture passed D1, but the protected MCP session did not initialize and the retained closed category does not identify whether the blocker is browser launch or MCP setup. The next experiment should resolve that local protected-session initialization failure, then rerun the same fixture with ten fresh sessions.

### Protected session initialization diagnosis (historical; superseded)

The first failed operation is `McpExplorationSession.open(...)`, immediately after the driver records `mcp_session_started`. That milestone means **open was requested**, not that MCP transport connected. `open` first calls `ProtectedContextFactory.open`; with the driver's default `docker-isolated` backend and schema-3 `browserIsolation: docker` profile, the factory enters `IsolatedBrowser.open` and issues `docker run` before creating an MCP server, client, transport, or browser context. The historical attempt records retain `UNKNOWN_EXPLORATION_FAILURE` but their exception-label sanitizer replaced lowercase letters with underscores, so the historical inner exception is not recoverable from those records.

A single local, navigation-free reproduction with the same driver profile and `McpExplorationSession.open` recorded only `browser_launch_started`, then the closed `AggregateError` class `Isolated browser startup and cleanup failed`. No `browser_launch_completed` or `context_create_started` event occurred. In the same restricted execution environment, a read-only `docker info` failed with Docker API permission denied; the identical read-only command outside that restriction returned server version 29.8.0. This supports a Docker-control access failure at the browser launch boundary, with failed startup cleanup verification wrapping the first error. It does **not** prove the exact nested exception for each historical attempt. A later read-only Docker listing showed no `public-browser-g1-` container left from the reproduction.

| Boundary | Stability driver | Nearest semantic-grounding acceptance fixture | Protected Docker integration proof |
|---|---|---|---|
| Browser backend/profile | Default `docker-isolated`; schema 3, headless, Docker isolation; profile resolved and fingerprint checked | Legacy profile without `browserIsolation`; factory launches local Playwright Chromium despite the default backend | Explicit schema-3 Docker profile; runtime case is opt-in with `PUBLIC_BROWSER_G1_RUNTIME=1` |
| Browser launch | Docker `run`, private control bridge, then protected context | Local `chromium.launch`, then context | Same Docker-isolated factory path as driver |
| MCP protocol | `McpExplorationSession.open` after browser launch: in-process `createConnection`, linked `InMemoryTransport`, initialize, list/check tools | Same MCP API and in-memory transport | Same MCP API after protected Docker launch |
| Tools/profile | `core` plus `testing`; reviewed tool inventory; headless profile timeout 3 s action/5 s navigation | Same MCP capabilities; local fixture timeout 1.5 s/3 s | Same capabilities; separate approved profile timeouts |
| Fixture/target | Authored HTTPS URL retained; two in-process `context.route` fulfills installed **after** session open; all other requests aborted | Loopback HTTP server started before open; navigated only after open | Loopback server started before open; protected proxy route, opt-in runtime |
| Trust/config | Test-only admitted semantic fixture, profile schema 3, `fixture-network` policy, no viewer, no auth provider | Test-only admission, legacy profile and loopback policy, no viewer/auth provider | Docker isolation and explicit runtime enablement |
| Artifacts/teardown | Per-cohort artifact/evidence root; `session.close()` only if open returns; diagnostic records written for all failures | No per-cohort evidence store; `session.close()` and fixture server close after open | Explicit container disposal checks |

The driver has no HTTP fixture server or bound port to start: both fixture HTML bodies are ready before the loop, and the route is installed only after session open. Zero route responses therefore follow from browser startup failure, not a fixture listener failure. Artifact-root, evidence-root, model, and live-view settings do not participate in the failing `docker run` call. No MCP handshake, capability negotiation, page creation, or grounding operation was reached.

**Primary classification: `LOCAL_BROWSER_BACKEND_INITIALIZATION_DEFECT`.** The driver selects the production-style Docker-isolated profile, whereas the ordinary acceptance fixture succeeds with a legacy local-browser profile. The failure observed here is Docker API access in the restricted process, not a demonstrated MCP protocol defect. Cleanup observability is a separate issue: `McpExplorationSession.open` owns cleanup only after `ProtectedContextFactory.open` returns; `IsolatedBrowser.open` attempts its own disposal on startup failure, but the aggregate reports that verification failed. The driver has no session handle and records cleanup `not_started`, so the ten historical cleanups cannot be certified, although the separate local probe left no listed container.

**Smallest correction to apply later:** run this driver through the same trusted Docker-enabled process/launch environment used by the protected Docker runtime proof and production isolated-browser workflow, retaining its schema-3 profile and `McpExplorationSession.open` path. Gate the ten-attempt cohort on one read-only Docker-access preflight in that environment. Do not switch to the legacy local profile or bypass MCP; no grounding outcome was measured in this diagnosis.

The driver is `tools/experiments/semantic/grounding/semantic-grounding-v1-test-fixture-stability.mjs`. It installs routes that fulfill only the exact two authored URL paths and abort every other request; no request is continued to the public Internet. Compiler, resolved, runner, replay, and QA stages were not invoked.

## Earlier provider-based fixture preparation (historical)

The sections below retain the earlier production provider-preparation attempts and must not be read as results of the test-only cohort.

## Fixture preparation

The latest one-shot fixture-preparation attempt used the current `interpretSemanticIntentWithEvidenceV3` boundary and made exactly one provider request. The primary call stopped with the typed `PROVIDER_ERROR` category before a completed structured response was available. Fidelity was not called. Since this was a provider execution failure rather than completed invalid output, no primary-output diagnostic was required or expected.

| Preparation gate | Result |
|---|---|
| Interpretation attempts | 1 |
| Provider requests | 1 primary; 0 fidelity reviewer |
| Primary provider execution | Failed: `PROVIDER_ERROR` |
| Primary-output diagnostic | Not required; no completed invalid structured response was classified |
| Diagnostic required / authenticated read | No / not applicable |
| Structural normalization / relation canonicalization / canonical validation | Not reached |
| Fidelity / trusted admission | Not reached |
| TestSpec ID | `semantic-grounding-fixture-1791329289148-72eeec6de1e049e69bb7238e7fd108a2` |
| Required semantic digest | Not produced |
| Eight semantic steps | Not produced |
| Admitted artifact path | None; admitted-artifact writer not called |
| Authenticated reload and fresh capability | No |
| Safe attempt record | `artifacts/semantic-grounding-fixture-1791329289148-72eeec6de1e049e69bb7238e7fd108a2-preparation/fixture-preparation.json` |

No retry was made. No browser or grounding stage started. A previous one-shot attempt stopped with `PROVIDER_OUTPUT_INVALID` before the shared-boundary wiring correction; it remains a separate historical result and is not reclassified from this attempt. The retained safe attempt record contains only closed stage/count/status fields and no provider response or reasoning.

## Grounding measurement

Preparation failed a required gate, so this attempt stopped without opening a browser or starting grounding attempts. No target URL was requested. No compiler v5, resolved v10, runner v10, replay pair v2, or QA stage ran.

| Attempt | Fixed TestSpec | Artifact authentication | Fresh admission | Browser/context | Grounding / trace | Cleanup | Canonical digest |
|---:|---|---|---|---|---|---|---|
| 1 | Not prepared | Not reached | Not reached | Not started | Not started | N/A | N/A |
| 2 | Not prepared | Not reached | Not reached | Not started | Not started | N/A | N/A |
| 3 | Not prepared | Not reached | Not reached | Not started | Not started | N/A | N/A |
| 4 | Not prepared | Not reached | Not reached | Not started | Not started | N/A | N/A |
| 5 | Not prepared | Not reached | Not reached | Not started | Not started | N/A | N/A |
| 6 | Not prepared | Not reached | Not reached | Not started | Not started | N/A | N/A |
| 7 | Not prepared | Not reached | Not reached | Not started | Not started | N/A | N/A |
| 8 | Not prepared | Not reached | Not reached | Not started | Not started | N/A | N/A |
| 9 | Not prepared | Not reached | Not reached | Not started | Not started | N/A | N/A |
| 10 | Not prepared | Not reached | Not reached | Not started | Not started | N/A | N/A |

- Grounding success rate: **not measurable (0 attempts started; 10 planned)**.
- Provider calls during grounding: **0**.
- Unique canonical grounding digests: **0**.
- Material grounding decision variance: **not measurable**.
- Cleanup: no browser/context existed to clean up.
- Ordinal and cardinality checks: not run.
- Failure breakdown: latest preparation stopped at primary `PROVIDER_ERROR`; ten grounding attempts not started. Earlier primary `PROVIDER_OUTPUT_INVALID` results are historical and predate the shared diagnostic boundary.

## Local fixture and isolation boundary

The current protected session exposes its Playwright `BrowserContext`, so a test-only context route can preserve the admitted public URL literals while serving deterministic local fixture HTML. The experiment harness maps only the exact root and `/add_remove_elements/` navigation URLs to in-process `route.fulfill` responses and aborts every other request; it never continues or fetches a request. That route was not installed or exercised because fixture preparation failed before artifact persistence.

The local fixture projection was prepared to check two unique Add candidates and click receipts, complete Delete count two, first Delete ordinal/index zero against the complete two-candidate domain, successful Delete click, and a fresh complete count of one. None of these checks ran, so this report makes no claim about grounding reliability, local browser stability, or public-site variability.

## Experiment harness and recommendation

The experiment-only driver is `tools/experiments/semantic/grounding/semantic-grounding-v1-stability-experiment.mjs`. Its one interpretation attempt enforces the required digest and step-count gates before artifact writing, then is designed to reload the same authenticated artifact for each fresh context. No production code was changed.

Recommended next action: investigate the typed provider error through operator-side provider status/configuration before authorizing another one-shot fixture preparation. This attempt provides no grounding reliability evidence; no retry was made.
