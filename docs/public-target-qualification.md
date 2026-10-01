# Public replacement-target qualification record

## Candidate

`https://the-internet.herokuapp.com/challenging_dom`

## Protected survey result

The isolated survey ran on 2026-09-22 using:

- Profile: `challenging-dom-qualification-headless@1`
- Policy: `challenging-dom-qualification-egress@1`
- Profile fingerprint: `be010720891ef2dc68d6e07c4b9b1fa71de1a26e16dc48b1cb86370d52db16d1`
- Evidence: `jobs/public-target-qualification/surveys/2026-09-22T17-59-22-268Z.json`

The page returned HTTP 200, stayed at the requested URL, and had title `The Internet`. The observed UI had one table with ten body rows, ten exact `edit` links, ten exact `delete` links, and row text that pairs distinct row values with repeated controls. This supports a future semantic, row-scoped interaction scenario.

The permitted target host supplied document, image, script, and stylesheet requests successfully. An optional XHR to `298279967.log.optimizely.com` was denied by the proxy; the page remained usable. No policy widening is justified by that denied telemetry request.

The manual survey passed two tests in 3.5 seconds and left no `public-browser-g1-*` containers.

## Release preparation

On 2026-09-22, a protected release-preparation interaction used the same
survey-only profile and policy. In the unique table row containing `Iuvaret1`,
the exact `edit` link resolved to and, when selected, produced:

`https://the-internet.herokuapp.com/challenging_dom#edit`

The main page returned HTTP 200. The optional Optimizely telemetry request was
denied without affecting the interaction. The isolated run passed in 3.7
seconds and left no `public-browser-g1-*` containers.

- Evidence: `jobs/public-target-qualification/release-preparation/2026-09-22T18-09-16-118Z.json`
- Profile fingerprint: `be010720891ef2dc68d6e07c4b9b1fa71de1a26e16dc48b1cb86370d52db16d1`

This confirms the expected scoped interaction for release preparation only. It
does not create production target approval, a real-model/MCP attempt, a
ResolvedTestSpec, or a public acceptance result.

## Production G1 proof

On 2026-09-22, the developer ran the credential-free G1 proof against the
exact production configuration:

- Profile: `challenging-dom-public-headless@1`
- Policy: `challenging-dom-public-egress@1`
- Profile fingerprint: `d3e82850b7aed8ad0825de676b52f983658edb7d0ec3b4bf4852812d1c5b3a42`

All five tests passed in 12.6 seconds. The sanitized allowed-transport result
was `the-internet.herokuapp.com:200`, and the final
`public-browser-g1-*` container listing was empty. The proof covered private
browser control, credential-sentinel exclusion, direct-egress denial,
unavailable-proxy fail-closed behavior, normal/failure/timeout/cancellation
disposal, and absence of residual containers. It used no provider credential,
OpenAI request, MCP exploration, or acceptance assertion.

## Disposition

The candidate is **qualified for and accepted by the reviewed replacement
acceptance task**. The subsequent production launch approval is recorded in
`config/public-challenging-dom.json` and is bound to
`challenging-dom-public-headless@1` by its effective profile fingerprint. The
production G1 proof, credential-free cross-boundary regression, and
operator-supplied credentialed production proof are recorded below. The formal
gate closure is recorded in `docs/public-web-acceptance-plan.md`.

## Credential-free cross-boundary regression

After the M6 scoped-locator correction, the developer manually reran
`npm.cmd run test:public-web-cross-boundary` on 2026-09-22. The Python
unittest completed successfully: **1 test passed in 11.396 seconds**. The
workflow used the test-only injected-model Node child through the Python
caller, then exercised protected MCP exploration, the approved browser
profile, two fresh deterministic replays, and Node-owned report
reconstruction. The final `public-browser-g1-*` container listing was empty.
It did not use the production OpenAI adapters and did not run the credentialed
acceptance workflow.

Sanitized correlation and outcome evidence:

- Profile: `challenging-dom-public-headless@1`
- Profile fingerprint: `d3e82850b7aed8ad0825de676b52f983658edb7d0ec3b4bf4852812d1c5b3a42`
- TestSpec: `local-96e795c2-4750-472d-8d51-6792cd5ec35b`
- Exploration attempt: `explore-0139f321-3f2f-434f-95ca-7a72526ab817`
- Resolved spec: `resolved-ccffc50c-a73e-409e-b85c-f3d35ccd5626`
- Fresh execution runs: `run-b154e675-10db-4979-9189-3a5281020102` and
  `run-7931f106-b8a4-405a-8573-b5d5ea720280`
- Terminal status: `QA_ASSERTION_PASSED`
- Node-owned report: reconstructed successfully

The test-only harness explicitly removes `OPENAI_API_KEY` from the child
environment; no provider request was made. No credential was included in the
task, request, trusted configuration, or evidence. The cross-boundary
regression gate is **closed** and the separate credentialed real-provider
acceptance workflow is unblocked. This result does not establish that final
public acceptance result.

## Credentialed production acceptance proof (operator supplied)

The human operator reports that the final production-path proof passed on
2026-09-22. This record captures the supplied safe summary only; the key,
provider request/response bodies, browser page contents, and report bytes are
not copied here.

- Target and task: the reviewed `challenging_dom` scenario, selecting the
  `edit` link in the row containing `Iuvaret1` and asserting the exact `#edit`
  URL.
- Trusted profile: `challenging-dom-public-headless@1`; profile fingerprint:
  `d3e82850b7aed8ad0825de676b52f983658edb7d0ec3b4bf4852812d1c5b3a42`.
- Model configuration: `gpt-5.6-terra`, reasoning effort `medium`.
- TestSpec: `local-ef3de1e0-8085-4b8a-8d52-dea60af1c325`.
- Exploration attempt: `explore-81a65411-180b-4855-830c-c8f3158853c5`.
- Resolved spec: `resolved-7441d228-6850-48bd-a0c6-06e0a4016fc0`.
- Locator quality: accepted semantic row-scoped locator.
- Fresh execution runs: `run-ba7c38dd-762e-45e3-b4b6-99ae012bea70` and
  `run-48dc1a1d-0753-43b9-b9c4-2aa7e046fd99`.
- Result: exact `assert_url` for
  `https://the-internet.herokuapp.com/challenging_dom#edit` passed in both
  runs; terminal status `QA_ASSERTION_PASSED`; Node-owned report reconstructed.
- Operator-reported command result: one test passed in 16.895 seconds with a
  successful process exit. The `public-browser-g1-*` container listing was
  empty afterward.

This proof establishes the reported production workflow result for the
replacement scenario. The reviewed disposition retires Columbia as an
externally blocked target and names Challenging DOM as the active acceptance
target. The formal public-web gate closure is recorded in
`docs/public-web-acceptance-plan.md`.
