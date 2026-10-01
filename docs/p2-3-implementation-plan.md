# P2-3 implementation plan: thin Python-host integration

## Purpose and fixed boundary

P2-3 lets a primarily Python host submit one natural-language UI task to the existing Node workflow and receive a typed result with immutable correlation IDs and safe artifact references. The approved [architecture](architecture.md), [TestSpec contract](test-spec-schema.md), [Phase 2 roadmap](phase-2-roadmap.md), and [integration decisions](phase-2-integration-decisions.md) govern this plan. The completed P2-1 adapters and P2-2 local workflow are prerequisites. The Node production package remains the only owner of validation, model orchestration, MCP exploration, browser/network policy, locator acceptance, replay, evidence, and cleanup.

Use a subprocess with JSON over stdin/stdout. Python owns process invocation, bounded supervision, and interpretation of the returned envelope. It does not create a TestSpec, choose a locator, access Playwright/MCP, read protected artifacts, or translate an engine result into a new QA status. Keep trusted configuration and provider credentials out of the task request. The P2-2 human-facing command is not the machine protocol: its line-oriented summary and exit codes may inform mapping, but P2-3 calls `runLocalWorkflow` through a dedicated Node entry point.

P2-3 does not include the later public-web acceptance gate, noVNC or remote browsing, `.spec.ts` export, a service/API, a job queue, or a second execution engine. Headed runs retain P2-2's observational, unverified provenance and `autonomousEligible: false`; a separate fresh headless run remains the autonomous proof path.

## Repository baseline and decisions to fix first

- `app/local/contracts.ts` already validates the untrusted `LocalWorkflowRequest` (`taskText`, `targetUrl`, `executionProfileRef`) separately from `TrustedLocalConfiguration`; `app/local/workflow.ts` composes the real adapters and `handoffTask`, uses the protected factory, and returns `LocalWorkflowOutcome`.
- `app/local/command.ts` and `app/local/cli.ts` print human-readable lines. They must not be treated as a JSON protocol. The root Node package is TypeScript/Node 24 ESM. `pyproject.toml`, `uv.lock`, and `src/playwright_demo/__init__.py` are an unused Python 3.12 starter; their prior status as non-production Node scaffolding does not prevent a thin P2-3 Python caller.
- The P2-2 local headed proof is recorded as passed in [its release note](p2-2-provider-release-gate.md). The older [P2-1 release note](p2-1-provider-release-gate.md) still says unverified in this checkout; reconcile that historical record separately if required, without making its wording a new P2-3 implementation dependency.

**P2-3A is the protocol decision gate.** Before either implementation side is written, record one versioned, closed request/result/error envelope, its field bounds, framing, exit semantics, and artifact-reference rules. Prefer one request and exactly one JSON result per child process: one bounded JSON document on stdin, one bounded JSON document on stdout, diagnostics on stderr. Python must distinguish a valid Node typed stop or QA failure from a malformed/missing response, unexpected exit code, launch failure, cancellation, and deadline expiry; an expected nonzero QA exit code does not turn a valid QA result into a process failure. Choose exact field names and byte/deadline limits in A; these are integration details, not changes to TestSpec or result vocabularies. The request is based on `LocalWorkflowRequest`, with no credential, network policy, artifact root, evidence policy, or arbitrary browser settings. Node loads trusted configuration from a host-controlled launch parameter, never from task text; the profile reference in the request is checked against that configuration. The OpenAI key remains external to JSON, for example in the child process environment.

The production subprocess entry uses the real P2-1 OpenAI adapters. Credential-free cross-process release tests use a test-only child harness built around the same P2-3B protocol adapter and the existing trusted `runLocalWorkflow` model-injection seam. The harness replaces only model responses; it still exercises the Node workflow, protected browser boundary, deterministic replay, and evidence path. It is never selected by a production request or trusted configuration. A manual credentialed proof must invoke the production entry.

## Work packages

### P2-3A — Versioned subprocess protocol

**Owner:** TypeScript contract specialist, with Python-host contract review before the gate closes.

**Scope:** Define the closed wire request and discriminated success/typed-stop/bridge-error result. Include protocol version, safe terminal phase/status/reason, profile reference and fingerprint when available, presentation/provenance status, TestSpec/attempt/resolved/run IDs when available, and an artifact/report reference only when available. Preserve the distinction between Node workflow errors, typed engine stops, and QA assertion failures. Define a separate Python host outcome for child-process/protocol failures when no trustworthy Node result exists; forced termination must make cleanup status explicitly unverified. Specify one-request framing, size bounds, validation, stdout purity, stderr redaction, and exit-code relationship. Treat paths as references to Node-owned protected artifacts, not as a grant to read their contents. Validate unknown fields and incompatible versions before engine work.

**Depends on / consumes:** Phase 2 integration decision; `LocalWorkflowRequestSchema`, `LocalWorkflowOutcomeSchema`, `LocalWorkflowError`, `ResultRecordSchema`, P2-2 observation and profile contracts. No browser or provider call is needed.

**Exit criteria:** Documented examples cover successful QA replay, QA assertion failure, interpretation/resolution stop, local configuration or destination denial, protocol/process failure, and forced termination with unverified cleanup. Closed schema tests reject extra authority fields, malformed/oversized input, incompatible versions, invalid ID relationships, raw evidence, and credentials. Python and Node owners can implement from the same recorded schema without guessing absent-field semantics.

**Deferred:** Node process entry, Python execution, browser integration, public targets.

### P2-3B — Node subprocess entry

**Owner:** Node specialist.

**Scope:** Implement the dedicated bounded stdin/stdout adapter to P2-3A with a trusted internal workflow dependency seam. The production entry binds that adapter to `runLocalWorkflow` with the real P2-1 OpenAI adapters only; untrusted request JSON cannot select a model implementation. Load trusted local configuration through a launch-only parameter using the existing P2-2 validator. Resolve credentials from the established external mechanism. Call the workflow once; project its result into the safe protocol envelope without dumping the full TestSpec, page text, provider body, or restricted evidence. Keep stdout parseable as exactly one result even for typed stops; route sanitized diagnostics to stderr. Propagate cancellation and deadline/termination into the workflow and protected-session cleanup. Preserve the selected profile's network policy and headed provenance. A launch/protocol error must not masquerade as a QA assertion failure. Expose the adapter to a separate test-only child harness in D; do not put a mock-provider switch in the production entry.

**Depends on / consumes:** P2-3A; P2-2 `runLocalWorkflow`, trusted config parsing, P2-1 adapters, M3 protected contexts, M5 artifact report, M7 handoff. Reuse existing logic rather than copying `runLocalCommand` or `handoffTask`.

**Exit criteria:** Adapter and process tests prove exactly one valid stdout document for controlled results and errors; malformed, oversized, duplicate, or extra-authority requests fail before browser work; stdout remains pure; no key, raw page content, restricted evidence, or arbitrary provider error body reaches either channel. Graceful cancellation and termination close active resources; forced process termination is reported as a process failure with cleanup unverified. Both headed and headless profiles preserve their existing fingerprint/provenance semantics. Offline B tests may inject existing seams; the production executable always binds real adapters. Credential-free cross-process interpretation, QA, and browser outcome coverage is D's test-only harness gate, not a claim about the production executable without credentials.

**Deferred:** Python supervision, user-facing console UX, public-web validation, service endpoint.

### P2-3C — Thin Python caller

**Owner:** Python integration specialist.

**Scope:** Replace or extend only the minimal Python starter needed for a reusable host-facing call. Launch the built Node entry with a host-controlled executable/configuration path and inherited or explicitly supplied protected environment; write one P2-3A request; enforce a host deadline and bounded stdout/stderr; drain stdout and stderr concurrently with separate limits so neither pipe can block the child; parse and validate the versioned response; expose the typed envelope to the host. Handle launch failure, malformed/missing/multiple response, child crash, cancellation, and timeout as host/process failures distinct from QA and typed Node stops. Terminate the child and reap it on cancellation or timeout. After forced termination, report cleanup as unverified and inspect for remaining browser descendants where the host can do so reliably. Do not copy TestSpec, profile-policy, Playwright, or result-classification logic into Python.

**Depends on / consumes:** P2-3A; Python 3.12 scaffold in `src/playwright_demo/`; built Node entry contract from B for integration. Its parser and process-supervision tests can proceed beside B against fixture subprocesses after A closes.

**Exit criteria:** Python tests prove one valid exchange, typed QA failure versus automation stop, envelope/version rejection, concurrent bounded stdout/stderr draining under output pressure, missing Node, and cancellation/deadline supervision. Graceful exits are reaped; forced exits retain an explicit unverified-cleanup status and perform descendant inspection where feasible. No Python dependency on browser/MCP libraries or a second network-policy definition is introduced. Provider credentials are never serialized into the request or returned envelope.

**Deferred:** Python web framework, service/API, scheduler, database, artifacts copied into Python, public-web run.

### P2-3D — Cross-process integration and release gate

**Owner:** Test automation specialist, with Node and Python owners reviewing failures at their boundary.

**Scope:** Add a test-only subprocess harness that invokes the same P2-3B stdin/stdout protocol adapter with the existing trusted injected-model seam in `runLocalWorkflow`. Through the Python caller and that harness, run deterministic credential-free cross-process cases on controlled local targets/configuration: typed interpretation stop, QA assertion failure versus browser/runtime failure, immutable IDs, artifact-reference availability, cancellation/cleanup, headed observational provenance, and an independently runnable authoritative headless path. Also cover profile lookup, denied destination, and invalid request at the protocol/production boundary where no provider call is required. The harness must not bypass protected MCP exploration, locator acceptance, deterministic replay, evidence, or Node-owned policy, and must not be selectable through ordinary request JSON or the production entry. Separately, run one controlled real-provider proof through the Python caller spawning the production Node entry; keep it opt-in and operator-held if the test environment lacks `OPENAI_API_KEY`. A skipped or injected-model run does not close that live proof.

**Depends on / consumes:** B and C; completed P2-1/P2-2 gates, the P2-3B protocol adapter, `runLocalWorkflow`'s trusted model-injection seam, existing local fixture and evidence/report readers. The controlled live proof uses the production entry and real adapters; no production mock-provider switch is added.

**Exit criteria:** Node typecheck/build/tests and Python tests pass. The test-only harness proves the credential-free cross-process outcome matrix through the shared protocol adapter and real engine boundaries, with exactly one typed result and a reconstructable Node-owned report when available. Tests verify that the production entry cannot select injected models from request or configuration. The separate opt-in live proof uses the production entry, records only safe model/profile/correlation data, and demonstrates a real task through interpretation, protected MCP exploration, accepted locators/prerequisites, and two fresh replays. If credentials or display are unavailable, record the live gate as unverified and leave P2-3 open. An intermittent headed `ECONNRESET` is a non-blocking P2-2 stability follow-up unless it reproduces in this gate or corrupts the subprocess result/evidence; then isolate and fix it before claiming P2-3 complete.

**Deferred:** Public-web/Columbia acceptance, noVNC, `.spec.ts` export, production hosting.

### P2-3E — Host-facing documentation and closure

**Owner:** Technical writer after D has observed results.

**Scope:** Document Python prerequisites and the actual host call, Node build/configuration, protocol/version behavior, typed result interpretation, trusted config versus task data, process cancellation, artifact ownership, headed provenance, safe diagnostics, and the exact controlled release-proof status. Update the Python starter description in README/runbook to reflect its new thin-caller role; retain Node as the production engine.

**Depends on / consumes:** D's observed commands/results, A's contract, B/C implementation.

**Exit criteria:** A developer can run the supported Python-to-Node flow from documentation without inventing flags or environment variables. The documented JSON and statuses validate against A and match actual output. No key, restricted artifact byte, or speculative public-web result is published.

**Deferred:** Public-web site instructions until its separate Phase 2 acceptance gate; service/API/noVNC/export documentation.

## Dependency order and critical path

```text
P2-3A protocol decision gate
          /              \
P2-3B Node entry     P2-3C Python caller/parser
          \              /
       P2-3D cross-process gate
                 |
       P2-3E documentation
```

The critical path is A → completion of both B and C → D → E. B and C can proceed in separate fresh specialist sessions after A freezes the wire contract; C's live integration waits for B's built entry. D owns the test-only harness after B exposes the shared adapter; its offline matrix depends on both B and C, and its manual proof depends on the production entry and operator-held credentials. Controlled-fixture setup and operator-held provider preparation can proceed in parallel but cannot substitute for D. Each package has one owner and a reviewable handoff artifact: A's schema/examples, B's shared adapter and production entry, C's caller, D's offline harness and live proof record, and E's operator instructions. A protocol change after B/C start requires both owners to review the version and migration impact before either side claims its exit gate.

## Risks and escalation gates

| Risk / early signal | Control and escalation |
|---|---|
| Human P2-2 command output is reused as a protocol; extra stdout breaks parsing | A specifies a dedicated JSON entry. B's process tests fail on any non-envelope stdout. |
| A Python option silently grants network or changes browser mode | Request schema rejects those fields; Node resolves only trusted profile/policy. Stop B/C integration if Python must carry policy authority. |
| Child timeout leaves Chromium/MCP/proxy descendants or partial result looks like QA failure | B aborts/cleans; C supervises and reaps while draining both output pipes; forced termination reports cleanup unverified and checks descendants when feasible. D tests cancellation and classifies process failure separately. Escalate lifecycle gaps to Node/host owners before release. |
| Raw task/page/provider/credential data enters stdout, stderr, or artifact references grant unrestricted access | B redacts/project safe fields; C bounds diagnostics; D inspects channels and report references. Stop release on leakage. |
| Credentialed live proof is unavailable or provider behavior varies | Keep offline contract/process gates green; mark D's live proof unverified and do not claim P2-3 complete. |
| Injected models leak into production or offline tests claim a real-provider pass | B binds production to real adapters; D uses a separate test-only harness sharing the protocol adapter, tests that request/configuration cannot select models, and records the manual production proof separately. Stop release on a boundary leak. |
| Intermittent headed `ECONNRESET` becomes repeatable across the bridge | Keep it a tracked non-blocking follow-up until it affects D; then collect process, profile, and run IDs and resolve before closure. |

## P2-3 completion and next boundary

P2-3 is complete when a Python host can invoke the built Node engine once per typed request, receive one validated, safe response that distinguishes QA, automation, and process outcomes, follow immutable IDs to Node-owned evidence, and supervise cleanup. The Node workflow must still enforce the selected versioned profile, browser-wide network policy, model/MCP limits, locator gate, and two fresh deterministic replays. The controlled real-provider integration proof and documentation must be recorded as passed; a skipped credentialed proof is not completion. Headed results remain observational and headless results remain the autonomous proof path.

Only after this gate should the separately planned public-web acceptance run use the Python-facing path. P2-4 remains optional and independent.

**Recommended first implementation task:** P2-3A. Fix the small versioned wire contract and examples, including error and process-failure boundaries, before Node and Python implement opposite sides independently.
