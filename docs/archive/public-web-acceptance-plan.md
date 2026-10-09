# Phase 2 public-web acceptance gate — closure record

## Status

**PASSED** for the reviewed Challenging DOM replacement scenario below. This is the separate public-web acceptance gate from the [Phase 2 roadmap](phase-2-roadmap.md), after P2-1 through P2-3. This record describes one observed run; it does not establish long-term site or locator stability.

The [architecture](architecture.md), [TestSpec contract](test-spec-schema.md), [Phase 2 integration decisions](phase-2-integration-decisions.md), and completed P2-1/P2-2/P2-3 release records remain authoritative. Python invokes and supervises the Node subprocess. Node owns model orchestration, MCP exploration, browser and network policy, deterministic replay, reports, evidence, and cleanup.

## Active acceptance scenario

> Go to `https://the-internet.herokuapp.com/challenging_dom`. In the table row containing `Iuvaret1`, select the `edit` link. Confirm that the URL is exactly `https://the-internet.herokuapp.com/challenging_dom#edit`.

The task requires semantic row scoping among repeated `edit` links. The accepted resolved locator is replayed in two independent fresh headless contexts. Both runs must pass the exact URL assertion and the Node-owned report must reconstruct with matching run and correlation identifiers.

## Completed gates

| Gate or work package | Status | Closure evidence |
|---|---|---|
| G0 — assertion decision | Closed | The replacement task uses existing `click` and exact `assert_url` operations. No assertion extension is needed for this scenario. |
| C — reviewed collection assertion | Complete; retained as a supported contract | The earlier Columbia claim caused implementation of versioned `assert_link_collection` semantics for exactly two distinct named links and exact normalized `href`. That capability remains in [TestSpec schema](test-spec-schema.md); it is not the active public acceptance claim. |
| A — trusted target approval | Closed | `challenging-dom-public-headless@1` / `challenging-dom-public-egress@1`, with approval bound to profile fingerprint `d3e82850b7aed8ad0825de676b52f983658edb7d0ec3b4bf4852812d1c5b3a42`. Approval and pins are recorded in [target qualification](public-target-qualification.md). |
| G1 — isolated browser and network proof | Closed | Exact replacement profile proof passed: private control, no credential sentinel, no host-file exposure, direct-egress denial, allowed proxy transport (`the-internet.herokuapp.com:200`), proxy failure behavior, timeout/cancellation/failure disposal, and no residual containers. The accepted Chromium `--no-sandbox` posture remains constrained by the reviewed container controls. |
| B — protected target survey and release preparation | Closed | Isolated survey found HTTP 200, one table, ten rows, ten `edit` and ten `delete` links. Protected release preparation confirmed the `Iuvaret1` row has one `edit` link and its selected URL is exactly the expected `#edit` URL. Optional Optimizely telemetry remained denied. |
| D — credential-free cross-boundary regression | Closed | Python caller and test-only Node harness passed using the approved profile, MCP exploration, accepted scoped locator, two fresh deterministic replays, `QA_ASSERTION_PASSED`, and reconstructed Node-owned report. The child omitted `OPENAI_API_KEY`. |
| E — credentialed production proof | Closed | Operator ran the real production path with OpenAI and MCP; safe evidence below records accepted resolution and two passing replays. |
| F — release record and closure | Closed by this document | The active scenario, historical Columbia disposition, evidence, and gate result are recorded here and in [target qualification](public-target-qualification.md). |

## Credential-free cross-boundary evidence

The developer-reported `npm.cmd run test:public-web-cross-boundary` run passed on 2026-09-22 in 11.396 seconds. It exercised Python → test-only Node subprocess harness → MCP exploration → protected browser → two fresh deterministic replays → Node-owned report reconstruction.

- Profile: `challenging-dom-public-headless@1`
- Profile fingerprint: `d3e82850b7aed8ad0825de676b52f983658edb7d0ec3b4bf4852812d1c5b3a42`
- TestSpec: `local-96e795c2-4750-472d-8d51-6792cd5ec35b`
- Exploration attempt: `explore-0139f321-3f2f-434f-95ca-7a72526ab817`
- Resolved spec: `resolved-ccffc50c-a73e-409e-b85c-f3d35ccd5626`
- Fresh runs: `run-b154e675-10db-4979-9189-3a5281020102`, `run-7931f106-b8a4-405a-8573-b5d5ea720280`
- Terminal status: `QA_ASSERTION_PASSED`; report reconstructed.

This test used an injected model and explicitly removed `OPENAI_API_KEY` from the child environment. It is offline cross-boundary proof, not the real-provider acceptance result.

## Credentialed production acceptance evidence

The human operator reported a successful `npm run test:public-web-live` run on 2026-09-22: one test passed in 16.895 seconds with a successful process exit. Only the supplied sanitized summary is retained; no key, provider body, page content, or report bytes are recorded.

- Target: `https://the-internet.herokuapp.com/challenging_dom`
- Task: select `edit` in the row containing `Iuvaret1`; assert the exact `#edit` URL.
- Profile: `challenging-dom-public-headless@1`
- Profile fingerprint: `d3e82850b7aed8ad0825de676b52f983658edb7d0ec3b4bf4852812d1c5b3a42`
- Model: `gpt-5.6-terra`, reasoning effort `medium`
- TestSpec: `local-ef3de1e0-8085-4b8a-8d52-dea60af1c325`
- Exploration attempt: `explore-81a65411-180b-4855-830c-c8f3158853c5`
- Resolved spec: `resolved-7441d228-6850-48bd-a0c6-06e0a4016fc0`
- Locator quality: accepted semantic row-scoped locator.
- Fresh runs: `run-ba7c38dd-762e-45e3-b4b6-99ae012bea70`, `run-48dc1a1d-0753-43b9-b9c4-2aa7e046fd99`
- Assertion: exact `https://the-internet.herokuapp.com/challenging_dom#edit` URL passed in both runs; terminal `QA_ASSERTION_PASSED`.
- Node-owned report: reconstructed successfully; operator reported no residual browser container.

Detailed qualification, survey, G1, release-preparation, and cross-boundary records are in [public-target-qualification.md](public-target-qualification.md). The successful live proof demonstrates this task through the supported production path for the observed site state.

## Historical Columbia disposition

The original Columbia candidate is **retired as externally blocked**, not silently redefined. Its protected surveys remain evidence of the blocker:

- The first protected survey returned HTTP 403, reached a Cloudflare challenge URL, and observed zero exact `Frank da Cruz` links.
- After a separately reviewed, versioned diagnostic allowance for `challenges.cloudflare.com`, the v2 survey still returned HTTP 403 and observed zero links. The two-link assertion was therefore unevaluable (`acceptanceClaimEvaluable: false`).
- Survey evidence: `jobs/public-columbia/surveys/2026-09-22T15-56-39-240Z.json` and `jobs/public-columbia/surveys/2026-09-22T17-36-12-938Z.json`.

No further network-policy widening was justified. Columbia did not pass the public-web gate. The closed collection-assertion contract work remains available and documented, but the replacement acceptance proof uses the existing exact URL assertion instead.

## Security and scope

The replacement run used the reviewed versioned target approval and the disposable browser-only container. Task input did not grant network authority. Browser egress remained confined to the authoritative proxy and its pinned destinations; the provider credential remained with trusted Node and was absent from browser/container state and ordinary evidence. The live result does not authorize other hosts or paths.

This gate does not add a service/API, noVNC, a general public-site benchmark, or `.spec.ts` export. One passing public-site task does not establish long-term target availability or locator stability. A future target, profile, policy, or acceptance claim requires its own review and evidence.

## Final disposition

**The Phase 2 public-web acceptance gate is formally PASSED** for the active Challenging DOM scenario. Required approval, G1 isolation, protected survey, credential-free cross-boundary regression, real-provider/MCP production execution, two fresh deterministic `QA_ASSERTION_PASSED` runs, and Node-owned report reconstruction are complete. Columbia remains historical externally blocked evidence and is not the active criterion.
