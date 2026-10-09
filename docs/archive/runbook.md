# MVP operator and developer runbook

This runbook describes the implemented M1–M8-B system and the optional viewing
boundary from M8-C. It is intended for developers integrating the library and
operators running the browser workflow in a controlled environment. Phase 3
also provides a separate local Streamlit PoC; see the [Phase 3 operator guide](phase-3-operator-guide.md).

The repository exposes a TypeScript library, a local developer command, and a
loopback-only Streamlit UI. It does not expose a hosted service. Library callers
provide a validated profile catalog, an artifact store, and the bounded
interpretation/step models used by M7.

## 1. Prerequisites and setup

Use Node.js 24 and install the locked dependencies:

```text
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run build
```

The root package is ESM TypeScript. The deterministic browser substrate is the
root `@playwright/test` package. The pinned MCP adapter is used only during the
exploration phase; it does not participate in deterministic replay.

Before running a target, provide a private artifact directory. The
`LocalArtifactStore` rejects an exposed root on permission-aware hosts. Windows
deployments must enforce the equivalent ACL at the deployment boundary.

Do not place the artifact root under a public static directory. Metadata is
redacted, while screenshots, traces, and videos are restricted binary evidence
and require explicit capture approval.

## 2. Configure an execution profile

Create a `ProfileCatalog` entry with an immutable profile ID and version. The
profile selects the browser, viewport, locale, timeout policy, feature-affecting
settings, network-policy reference, and, when needed, a protected auth-state
reference. Add a matching `NetworkPolicy` with exact host, port, and approved
address rules.

The same profile reference and effective fingerprint must be used for MCP
exploration, locator validation, and both deterministic replays. A material
change requires a new profile version and a new exploration/validation cycle.

```ts
const catalog = new ProfileCatalog([{
  id: 'desktop',
  version: '1',
  browser: 'chromium',
  viewport: { width: 1280, height: 800 },
  locale: 'en-US',
  timeoutPolicy: {
    actionMs: 5_000,
    navigationMs: 5_000,
    waits: { default: 3_000 },
  },
  networkPolicyRef: { id: 'local-app', version: '1' },
}], [{
  id: 'local-app',
  version: '1',
  destinations: [{
    host: '127.0.0.1',
    ports: [4173],
    addresses: ['127.0.0.1'],
  }],
}]);

const factory = new ProtectedContextFactory(catalog);
```

All browser traffic passes through the protected egress boundary, including
iframes, redirects, subresources, fetch/XHR, WebSockets, and downloads. A
missing profile or unenforceable policy stops session creation. Non-loopback
destinations also require an injected `ExternalTargetGate` approval before the
browser or protected auth state is loaded. There is no direct-network fallback.

If the profile includes `authStateRef`, supply an `AuthStateProvider`. The
profile and ordinary artifacts retain only the protected ID/version; cookies,
storage state, and credentials are not persisted as ordinary evidence.

## 3. Run the workflow

The normal workflow is:

1. M7 interprets the user request into a schema-valid `TestSpec`.
2. M6 explores through the protected MCP session and records snapshots, tool
   calls, generated locator provenance, and ordered discovered prerequisites.
3. Every generated locator passes parser, identity, uniqueness, observed-target,
   and durability checks.
4. M4 executes the accepted `ResolvedTestSpec` in fresh protected contexts
   without an LLM or MCP call.
5. M5 stores the immutable attempt, resolved spec, runs, outcomes, and evidence.

At the library boundary, `handoffTask(factory, store, request,
interpretationModel, stepDecisionModel, options)` connects these phases. The
two replay runs receive distinct execution-run IDs and use fresh contexts. A
caller should close any directly opened `ProtectedBrowserSession` in a
`finally` block; the handoff and replay adapters own cleanup for their sessions.

The `EvidenceCapturePolicy` is opt-in:

```ts
const evidencePolicy = {
  finalScreenshot: false,
  failureScreenshot: false,
  failureTrace: false,
  failureVideo: false,
  sensitiveBinaryApproved: false,
};
```

Enabling any binary capture requires `sensitiveBinaryApproved: true`. Failure
traces and videos are retained only for failed runs when enabled. Use the
smallest policy that answers the operational question.

## 4. Read outcomes and evidence

Use `readStoredJobReport(store, testSpecId)` to reconstruct the result without
opening a browser. The report links:

`TestSpec → interpretation → exploration attempt → resolved execution steps → deterministic runs → evidence`

Each record retains the execution profile fingerprint and immutable IDs. The
report includes per-step outcomes and evidence references, so a result can be
explained without rerunning exploration.

Interpret result categories separately:

| Result | Meaning | Operator action |
|---|---|---|
| `OPERATION_SUCCEEDED` | An action or synchronization completed. | Continue or inspect the next step. |
| `QA_ASSERTION_PASSED` | The product satisfied an evaluated assertion. | Report the QA result as passed. |
| `QA_ASSERTION_FAILED` | The assertion ran and the product did not satisfy it, including positive assertions with `NO_MATCH`. | Treat as a product/QA failure; inspect expected and actual values. |
| `LOCATOR_BINDING_FAILED` | The runner could not reliably bind or evaluate a target, including action `NO_MATCH`, ambiguity, malformed forms, or frame failure. | Start a new explicit exploration attempt after reviewing the UI change. |
| `MCP_EXPLORATION_FAILED` / `TARGET_RESOLUTION_FAILED` | Exploration could not reach or identify the requested target. | Inspect attempt snapshots, policy, and tool evidence. |
| `LOCATOR_QUALITY_FAILED` | A locator executed or parsed but was not durable enough to persist. | Improve the application's semantic identity or review the new exploration evidence. |
| `BROWSER_EXECUTION_FAILED` | The browser or protected environment failed. | Inspect profile, policy, lifecycle, and restricted evidence. |
| `NOT_RUN` | A dependent step was not executed after an earlier failure. | Fix the first failure; do not interpret this as a separate QA result. |

Read raw screenshot, trace, or video content only through the deployment-owned
`RestrictedEvidenceAccess` boundary. The artifact store refuses restricted
binary reads without authorization. Call `pruneExpired()` as an explicit
operational maintenance action; the initial retention setting is seven days.

## 5. Locator changes and regeneration

The deterministic runner never repairs or regenerates a locator. If an
accepted locator becomes stale, the run records `LOCATOR_BINDING_FAILED` with
the relevant binding reason and dependent steps become `NOT_RUN`.

Regeneration is an explicit new MCP exploration attempt:

1. Preserve the failed run, attempt, and evidence.
2. Verify the selected profile version and network policy still describe the
   intended environment.
3. Start a fresh protected exploration session with the same user intent and
   permitted context.
4. Generate and quality-check new locators, including every prerequisite.
5. Persist a new resolved-spec revision only after all gates pass.
6. Replay it twice in fresh contexts and compare the resulting typed report.

Never edit a stored locator in place, use an ephemeral MCP reference as a
persisted selector, or silently invoke MCP from deterministic replay. A new
attempt keeps the previous artifacts available for comparison and audit.

## 6. Optional browser viewing

The current implementation supports profile-controlled Chromium execution in
both headless and headed modes through the protected Playwright session. It has
no built-in noVNC server or viewer endpoint. Headed execution is observational
with unverified input provenance and is never autonomous-eligible; a separate
fresh headless run is the authoritative autonomous path.

If a deployment adds noVNC later, it must attach as an observation layer to the
already isolated browser session created by `ProtectedContextFactory`. It must
not create a second browser, change the execution profile, bypass the protected
network boundary, expose credentials or unrestricted host access, or become a
dependency of MCP resolution or deterministic replay. Closing or omitting the
viewer must leave the same test steps, outcomes, and evidence semantics.

Human interaction through an eventual viewer must be recorded separately from
autonomous evidence. noVNC is not a product UI, selector-repair mechanism, or
required execution path.

## 7. Troubleshooting

### Session creation is denied

Check the profile ID/version, referenced network policy, browser installation,
and whether the destination is non-loopback. External destinations require an
`ExternalTargetGate`; missing approval is an intentional safety stop.

### Navigation or embedded traffic is denied

Check every host, port, and resolved address in the policy. A permitted top
level page does not implicitly permit its iframes, redirects, API calls,
WebSockets, or downloads. The browser has no direct fallback.

### A target cannot be replayed

Distinguish `LOCATOR_BINDING_FAILED` from `QA_ASSERTION_FAILED`. Inspect the
stored generated locator, match count, observed identity, profile fingerprint,
and prerequisite outcomes. Regenerate only through a new exploration attempt.

### Evidence cannot be opened

Metadata is redacted by design. Restricted binary evidence requires the
deployment-owned authorization gate, and expired jobs must be pruned through
the explicit retention operation.

### MCP capability or cleanup failure

Check the recorded MCP tool inventory and pinned versions in the exploration
attempt. Re-run the MCP integration tests after changing Playwright or MCP.
The protected session and temporary MCP output directory must be closed and
removed even when exploration fails.

## 8. Release and regression checks

Before accepting a change to the MVP runtime, run:

```text
npm run typecheck
npm test
npm run build
```

The M8 regression suite covers the complete operation vocabulary, prerequisites,
frame locators, profile mismatch, network denial, Scenario 8 quality rejection,
stale locators, artifact controls, and evidence reconstruction. These checks
must continue to pass before a release. The headless suite is also the viewer
independence check: noVNC is absent from the runner, profile factory, resolver,
and evidence contracts.

### Phase 2 OpenAI provider release gate

The ordinary test suite is credential-free. The P2-1 real-provider proof is a
separate, opt-in local-fixture test. Set its credentials in the invoking shell,
never in a TestSpec, artifact root, or checked-in file:

```powershell
$env:OPENAI_API_KEY = '<your API key>'
$env:P2_1_OPENAI_LIVE = '1'
npm run test:p2-1-live
```

The test uses the default `gpt-5.6-terra` model at `medium` reasoning effort,
with the Responses API Structured Outputs path, `store: false`, and no model
tools. It proves an end-to-end task against a private local fixture: model
interpretation, bounded MCP resolution of a menu prerequisite, locator-quality
acceptance, two fresh protected replays, and immutable evidence IDs. The test
is skipped unless the explicit gate is set; a skipped run is **not** a verified
provider release gate.

Provider access, latency, rate limits, usage cost, and nondeterministic model
behavior remain external dependencies. A successful local proof does not
establish public-web support, headed observation, Python hosting, or Playwright
source export; those are separate Phase 2 work.

### Phase 2 local developer command

Build the project, start a local site on port 4173, and create a trusted JSON
configuration file outside the task input. For example, save this as
`jobs/trusted-local.json` (the `jobs/` directory is ignored by Git):

```json
{
  "profiles": [
    {
      "id": "desktop-headless", "version": "2", "profileSchemaVersion": "2",
      "presentationMode": "headless", "browser": "chromium",
      "viewport": { "width": 1280, "height": 800 }, "locale": "en-US",
      "timeoutPolicy": { "actionMs": 5000, "navigationMs": 5000, "waits": { "default": 3000 } },
      "networkPolicyRef": { "id": "local-site", "version": "1" }
    },
    {
      "id": "desktop-headed", "version": "2", "profileSchemaVersion": "2",
      "presentationMode": "headed", "browser": "chromium",
      "viewport": { "width": 1280, "height": 800 }, "locale": "en-US",
      "timeoutPolicy": { "actionMs": 5000, "navigationMs": 5000, "waits": { "default": 3000 } },
      "networkPolicyRef": { "id": "local-site", "version": "1" }
    }
  ],
  "networkPolicies": [{
    "id": "local-site", "version": "1",
    "destinations": [{ "host": "127.0.0.1", "ports": [4173], "addresses": ["127.0.0.1"] }]
  }],
  "evidencePolicy": {
    "finalScreenshot": false, "failureScreenshot": false,
    "failureTrace": false, "failureVideo": false,
    "sensitiveBinaryApproved": false
  },
  "artifactRoot": "jobs/local-demo", "retentionDays": 7
}
```

Run the same task with either explicitly versioned profile:

```powershell
npm run build
$env:OPENAI_API_KEY = '<your API key>'
npm run local -- --config jobs/trusted-local.json --profile desktop-headed@2 --mode headed --url http://127.0.0.1:4173/ --task 'Select Save.'
npm run local -- --config jobs/trusted-local.json --profile desktop-headless@2 --mode headless --url http://127.0.0.1:4173/ --task 'Select Save.'
```

`--mode` checks the selected profile; it never changes browser launch mode.
The URL must fit the trusted policy. The local command has no external-target
approval provider, so non-loopback targets remain denied. It prints typed
statuses, IDs, observational provenance, and the stored job directory without
printing task text, page content, or evidence bytes. A headed run is always
`autonomousEligible=false`; a separate fresh headless run supplies autonomous
proof. Exit codes are 0 for successful replay, 1 for a QA assertion failure,
2 for a typed automation/configuration stop, 64 for command misuse, and 130
for cancellation. The command is human-facing; it is not the P2-3 subprocess
protocol.

### Phase 2 local release gate

P2-2E covers credential-free regression tests and one opt-in credentialed
headed proof. The ordinary checks remain:

```powershell
npm run typecheck
npm test
npm run build
```

The credentialed proof is run manually because it needs a display and a real
OpenAI key held by the operator:

```powershell
$env:OPENAI_API_KEY = '<your API key>'
$env:P2_2_HEADED_LIVE = '1'
$env:P2_2_KEEP_ARTIFACTS = '1'  # optional; retain the temporary artifact root
npm run test:p2-2-live
```

Do not put the key in a trusted JSON file, TestSpec, artifact directory, or
source file. A skipped test is not a release result. The live proof must use
the local command, show a protected headed workflow, report typed success,
and retain observational provenance with `autonomousEligible=false`. Its
stored report must contain the exploration attempt, resolved spec, and two
fresh execution-run records with accepted locators and passing QA outcomes.

The P2-2E manual run supplied for this repository passed all three scenarios
in 25.2 seconds with a successful process exit. The result confirms the
headed/headless semantics and the real OpenAI headed local-command proof;
credentials and raw evidence are not recorded in this documentation. If
artifacts are retained, use only the safe IDs and fingerprint from the test
attachment when correlating a report. Do not paste snapshots, provider
responses, screenshots, traces, videos, cookies, or keys into tickets or
documentation.

P2-2 does not establish public-web support, Python hosting, noVNC viewing, or
`.spec.ts` export. Those remain deferred Phase 2 work.

### Phase 2 Python host integration

P2-3 provides a thin Python host API around the built Node subprocess entry. It
does not add a service, HTTP endpoint, second runner, or Python implementation
of TestSpec, Playwright, MCP, network policy, locator binding, or QA
classification. Python owns process invocation, bounded supervision, and
validation of the returned envelope. Node remains the owner of the workflow and
Node-owned artifacts.

Use Python 3.12 or newer (the repository declares `requires-python = ">=3.12"`)
and build the Node entry:

```powershell
npm ci
npm run build
```

The Python caller is imported from `src/playwright_demo`. It is an API for a
host application; the scaffold's `playwright-demo` console entry is not the
machine protocol. A minimal call is:

```python
from playwright_demo import call_node

result = call_node(
    {
        "protocolVersion": "1",
        "request": {
            "taskText": "Select Save.",
            "targetUrl": "http://127.0.0.1:4173/",
            "executionProfileRef": {"id": "desktop-headless", "version": "2"},
        },
    },
    node_entry="dist/subprocess/cli.js",
    config_path="jobs/trusted-local.json",
)
```

The executable, Node entry, trusted configuration path, environment, and host
deadline are host-controlled inputs. The JSON request contains only task text,
an absolute HTTP(S) target URL, and a profile reference. It cannot choose a
model, credentials, browser mode, timeout, network policy, artifact root, or
injected implementation. The target URL must already be allowed by the trusted
profile's browser-wide network policy.

The child accepts one UTF-8 JSON request on stdin and emits exactly one protocol
v1 JSON response on stdout. Logs and prompts must not be written to stdout.
Python drains stdout and stderr concurrently, bounds retained diagnostics, and
validates both the response and its exit code. The versioned result is one of:

- `success`: both deterministic replays completed without QA or automation failure.
- `typed_stop` with `stopKind: qa_failure`: an assertion was evaluated and failed.
- `typed_stop` with `stopKind: automation_stop`: interpretation, exploration,
  locator, browser, or another typed automation stop occurred.
- `bridge_error`: Node could not produce a trustworthy workflow result, such as
  invalid configuration, denied destination, or cancellation.

If no trustworthy Node response exists, Python returns `process_failure` for
launch, malformed/missing/multiple response, output-limit, unexpected-exit,
cancellation, or deadline failures. A forced termination always reports
`cleanup: "unverified"`; a destination or configuration rejection before work
starts reports `cleanup: "not_started"`. Python keeps only a bounded sanitized
stderr summary and does not reinterpret it as a QA result.

The response includes safe correlation data such as the TestSpec ID, profile
reference and fingerprint, exploration/resolved/run IDs, and report
availability. The report reference points to Node-owned protected artifacts; it
does not grant Python access to screenshots, traces, videos, page text,
storage state, provider responses, or evidence bytes. Credentials must remain in
the child environment and outside requests, TestSpecs, reports, and ordinary
evidence.

Headed responses remain observational with unverified input provenance and
`autonomousEligible: false`. A fresh headless run is the authoritative
autonomous proof path. Detected input observations remain evidence and never
become replay steps.

### P2-3 cross-process release gate

The credential-free gate uses a test-only child harness with the same protocol
adapter and trusted model-injection seam. It does not add a production mock
provider switch. The production proof uses the real Node entry and an
operator-held `OPENAI_API_KEY`:

```powershell
$env:OPENAI_API_KEY = '<your API key>'
$env:P2_3_LIVE = '1'
npm run test:p2-3-live
```

The key is never placed in JSON, source, artifacts, or documentation. The final
recorded P2-3D proof passed four Python-to-Node tests in 41.861 seconds with a
successful process exit. It included safe TestSpec/profile/exploration/resolved
spec/execution-run correlation data, an available report reference, and a
report-reconstructed `hasDiscoveredPrerequisite: true` assertion for the
Account-menu task. The credential-free matrix also passed, including typed QA
and automation outcomes, headed provenance, cancellation, invalid requests,
profile lookup, and destination denial with `cleanup: "not_started"`.

P2-3 does not establish public-web acceptance, HTTP/service hosting, noVNC, or
`.spec.ts` export. Those remain separate deferred work. The intermittent headed
`ECONNRESET` from P2-2 remains a non-blocking stability follow-up unless it
reproduces in this gate or corrupts protocol results/evidence.

## Source behavior

This runbook is based on the implemented contracts and modules in:

- [`app/profile/context.ts`](../app/profile/context.ts)
- [`app/profile/README.md`](../../app/profile/README.md)
- [`app/exploration/mcp.ts`](../../app/exploration/mcp.ts)
- [`app/exploration/README.md`](../../app/exploration/README.md)
- [`app/interpretation/handoff.ts`](../app/interpretation/handoff.ts)
- [`app/evidence/store.ts`](../app/evidence/store.ts)
- [`app/evidence/capture.ts`](../app/evidence/capture.ts)
- [`app/evidence/report.ts`](../app/evidence/report.ts)
- [`app/evidence/README.md`](../../app/evidence/README.md)
- [`tests/system-regression-m8a.spec.ts`](../tests/system-regression-m8a.spec.ts)
- [`tests/operational-controls-m8b.spec.ts`](../tests/operational-controls-m8b.spec.ts)

The documented noVNC boundary is architectural guidance; no viewer adapter is
implemented in this repository.

## Phase 3 local Streamlit PoC

Phase 3 adds a guarded, loopback-only, single-operator UI over the existing
Python-to-Node workflow. For setup, public URL approval, credential handling,
typed results, projection limits, cleanup, and the recorded live proof, see the
[Phase 3 operator guide](phase-3-operator-guide.md). The detailed guide is based
on the implemented launcher and host wiring; it does not change the Phase 2
execution or evidence contracts.
