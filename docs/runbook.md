# MVP operator and developer runbook

This runbook describes the implemented M1–M8-B system and the optional viewing
boundary from M8-C. It is intended for developers integrating the library and
operators running the browser workflow in a controlled environment.

The repository currently exposes a TypeScript library, not a command-line
service or product UI. Callers provide a validated profile catalog, an artifact
store, and the bounded interpretation/step models used by M7.

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

The current implementation runs Chromium headlessly and has no built-in noVNC
server or viewer endpoint. Headless execution is the supported path and is
independent of any viewer.

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

## Source behavior

This runbook is based on the implemented contracts and modules in:

- [`app/profile/context.ts`](../app/profile/context.ts)
- [`app/profile/README.md`](../app/profile/README.md)
- [`app/exploration/mcp.ts`](../app/exploration/mcp.ts)
- [`app/exploration/README.md`](../app/exploration/README.md)
- [`app/interpretation/handoff.ts`](../app/interpretation/handoff.ts)
- [`app/evidence/store.ts`](../app/evidence/store.ts)
- [`app/evidence/capture.ts`](../app/evidence/capture.ts)
- [`app/evidence/report.ts`](../app/evidence/report.ts)
- [`app/evidence/README.md`](../app/evidence/README.md)
- [`tests/system-regression-m8a.spec.ts`](../tests/system-regression-m8a.spec.ts)
- [`tests/operational-controls-m8b.spec.ts`](../tests/operational-controls-m8b.spec.ts)

The documented noVNC boundary is architectural guidance; no viewer adapter is
implemented in this repository.
