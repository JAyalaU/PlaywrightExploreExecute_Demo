# P2-3 cross-process release gate

This record captures P2-3D release-gate evidence for the thin Python host
integration. It contains correlation metadata only; credentials, provider
responses, page content, screenshots, traces, videos, cookies, and artifact
bytes are intentionally excluded.

## Credential-free coverage

The offline release matrix runs the test-only Node child harness through the
same v1 protocol adapter used by the production entry and the Python
`call_node` host API. It uses the existing trusted model-injection seam only in
the test harness. The production entry remains real-provider-only.

The matrix passed these boundaries:

- successful headless workflow with a discovered Account-menu prerequisite and
  two distinct deterministic replay IDs;
- typed ambiguous-task interpretation stop through the Python caller;
- typed QA assertion failure distinguished from automation failure;
- headed observational provenance with `autonomousEligible: false`;
- Python cancellation with forced cleanup reported as `unverified`;
- invalid request and unavailable profile handling;
- denied destination reported as `DESTINATION_DENIED` with
  `cleanup: "not_started"`;
- rejection of model-selection fields from the untrusted request; and
- bounded protocol and process lifecycle handling.

The test also opens a response-referenced Node-owned report through a
test-only Node report reader and reconstructs only a safe correlation summary
(profile fingerprint, attempt/resolved/run IDs, and prerequisite presence).
It neither transmits report contents over the P2-3 protocol nor grants the
Python host artifact access.

The release command is:

```powershell
npm run test:p2-3-offline
```

## Credentialed production proof

The operator-run production proof used the real Node subprocess entry through
the Python caller:

```powershell
$env:OPENAI_API_KEY = '<your API key>'
$env:P2_3_LIVE = '1'
npm run test:p2-3-live
```

The previous live proof passed **4 tests in 36.433 seconds**, with a successful
process exit. It used a Save-only fixture and therefore did **not** demonstrate
discovered-prerequisite handling. It is retained as historical provider-path
evidence only.
The safe output included:

```json
{
  "testSpecId": "local-a96aacfb-7028-46b6-830b-fef39e243a2d",
  "profileFingerprint": "7308ac0d4f282f84c02752224d8f568907f4f16539f53c19949f8b548ea46cfd",
  "explorationAttemptId": "explore-497c77e9-5ac0-4414-b595-6ac631d2e2af",
  "resolvedSpecId": "resolved-fd0a2137-1c9e-480a-8d92-955ef915f8c9",
  "executionRunIds": [
    "run-970fcfdb-735a-4d56-9185-769677f07023",
    "run-367716d2-a474-46af-899d-4175ff130f15"
  ],
  "report": { "kind": "available", "testSpecId": "local-a96aacfb-7028-46b6-830b-fef39e243a2d" }
}
```

The historical proof exercised the Python-to-Node protocol, real provider path,
protected MCP exploration, accepted locator handling, deterministic replay, and
Node-owned evidence correlation. The API key was supplied by the operator and
is not recorded here.

### Corrected prerequisite proof — passed

The corrected controlled fixture requires exploration to open the **Account
menu** before selecting **Admin** and asserting that the Selection status is
`Admin selected`. The credential-free release case reconstructs the Node-owned
report and requires that it records a discovered prerequisite; the credentialed
production proof exercises the same prerequisite-dependent task through the
real provider path.

An earlier Account-menu production proof passed in 43.079 seconds, but the
credentialed test did not yet reconstruct the report. It remains historical
provider-path evidence. After adding the live report-reconstruction assertion,
the operator ran the final production-entry proof successfully on 2026-09-21:

- command: `npm run test:p2-3-live`
- result: **4 tests passed in 41.861 seconds** with a successful process exit
- fixture coverage: Account-menu discovered prerequisite, real provider,
  protected MCP exploration, accepted locator, two fresh deterministic replays,
  and reconstruction of the available Node-owned report

The safe correlation output was:

```json
{
  "testSpecId": "local-80c65649-ae1a-4a55-a08a-adf508ba3860",
  "profileFingerprint": "06fb28397acb4ab82d478ff177ce82306864a689e8e419718709f0ab8aa0a748",
  "explorationAttemptId": "explore-511e59a7-ded8-4dc9-aa10-bed90432cb7c",
  "resolvedSpecId": "resolved-153397e4-522e-4a1a-aae8-8eeff0d1567c",
  "executionRunIds": [
    "run-fd063f03-d717-4a48-ba23-4619c1dad8db",
    "run-2465f2a2-0cd4-4457-a649-7fbb7ed62c48"
  ],
  "report": { "kind": "available", "testSpecId": "local-80c65649-ae1a-4a55-a08a-adf508ba3860" },
  "hasDiscoveredPrerequisite": true
}
```

The live test reconstructed the Node-owned report and asserted
`hasDiscoveredPrerequisite: true`; it does not transmit report contents through
the protocol. The operator supplied the API key outside the protocol. This
record contains no credential, provider body, page content, or protected
artifact bytes.

## Operational interpretation

Python owns process invocation, deadline/cancellation supervision, bounded
stdout/stderr handling, and protocol validation. Node owns request validation,
model orchestration, MCP exploration, browser/network policy, locator quality,
deterministic replay, evidence, and cleanup.

The request contains only task text, target URL, and a trusted profile
reference. Configuration and credentials are launch-side inputs. The target URL
cannot widen network policy. A result's report reference identifies a
Node-owned protected report; it is not a filesystem permission or a copy of
evidence.

Headed results are observational with unverified input provenance and are never
autonomous-eligible. A separate fresh headless run is the autonomous proof
path. Forced host termination reports cleanup as unverified; validation or
destination failures before workflow start report cleanup as not started.

## Scope boundary

P2-3 does not include public-web acceptance, HTTP/service hosting, noVNC,
`.spec.ts` export, or production hosting. These remain deferred. The known
intermittent headed `ECONNRESET` from P2-2 remains a non-blocking stability
follow-up unless it reproduces in this gate or corrupts protocol results or
evidence.
