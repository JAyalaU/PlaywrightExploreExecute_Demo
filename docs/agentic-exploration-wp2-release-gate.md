# WP2 agentic-exploration release gate

## Scope and current status

This gate proves the explicit `agentic-exploration-v1` controller through WP1,
WP2A current-state binding, WP2B trace assembly/persistence, and WP2C bounded
decisions. It stops at the exploration/compiler boundary. It does not invoke a
trace compiler, create `ResolvedTestSpec v6`, or run deterministic replay. The
legacy workflow and stakeholder UI remain on their existing path.

`npm run test:agentic-exploration-wp2` builds the Node implementation and runs
the WP1, WP2A, WP2B, WP2C, and release-spec suites serially. The new local
Status Codes fixture covers all seven authored goals with a protected MCP
browser and a deterministic decision model. Existing WP2C scenarios cover
the numeric `200` action without replay-locator authorization, duplicate Save
controls, inspect/retry, failed-branch separation, wrong consequences, stale
rebinding, safe unchanged-state retry, fresh-session recovery, unverifiable
recovery denial, cancellation, false assertions, and hard budget bounds.

The fixture asserts the exact seven-record authored path, action bindings and
post-action state changes, all three URL predicates, model select/evaluate
calls for each targeted click, immutable trace readback, no branch leakage,
and no compiler attempt or v6 artifact. It is a regression gate; it does not
substitute for a real-provider public-site run.

## Operator-run real-provider proof

The current assembled Streamlit host still selects the legacy workflow. Do not
change production cutover for this gate. A deliberately opt-in test-only
adapter in `tests/agentic-exploration-wp2-release.spec.ts` connects the real
OpenAI Responses API to the existing agentic decision interface, while the
browser remains in the approved protected compartment. It sends only the
closed decision schema and bounded current authored goal/snapshot context,
uses `store: false` and no provider tools, validates the returned decision
through `AgenticDecisionV3Schema`, and prints no prompt, model output, MCP
payload, snapshot, or page text. The test does not expose or persist the API
key. Do not use it with an unreviewed or headed profile.

### Create a fresh headless approval

Run in PowerShell at the repository root. Review the inspected URL, host, port,
and DNS pins printed by the approval command, then type the full canonical URL
when asked. The exact host-only policy permits the three Status Codes paths
while the proxy continues to deny other hosts.

```powershell
npm.cmd run build
$targetUrl = 'https://the-internet.herokuapp.com/'
$jobRoot = Join-Path $PWD ("jobs\agentic-exploration-wp2-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$artifactRoot = Join-Path $jobRoot 'artifacts'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
$inspection = Join-Path $jobRoot 'headless-inspection.json'
$trustedConfig = Join-Path $jobRoot 'headless-trusted-config.json'

node .\dist\profile\admission-cli.js inspect $targetUrl |
  Set-Content -Encoding utf8 $inspection
if ($LASTEXITCODE -ne 0) { throw 'Public target inspection failed.' }
node .\dist\profile\admission-cli.js approve `
  $inspection $trustedConfig $artifactRoot
if ($LASTEXITCODE -ne 0) { throw 'Headless public target approval failed.' }
```

Confirm the generated approval is admission v1 for exactly
`https://the-internet.herokuapp.com/`, profile presentation is headless, the
profile fingerprint matches the approval, and the policy contains only
`the-internet.herokuapp.com:443` with the reviewed pins. Do not edit the
generated trust file to broaden its destinations.

### Run the protected live proof

Set only the operator's approved config and artifact directory. Enter the API
key with `Read-Host -AsSecureString`; the key is held in the current process
environment only for the test command and removed in `finally`.

```powershell
$env:AGENTIC_EXPLORATION_STATUS_CODES_LIVE = '1'
$env:AGENTIC_EXPLORATION_STATUS_CODES_CONFIG = $trustedConfig
$env:AGENTIC_EXPLORATION_STATUS_CODES_ARTIFACT_ROOT = $artifactRoot
$secureKey = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) { throw 'OpenAI API key is empty.' }
try {
  npm.cmd run test:agentic-exploration-wp2
} finally {
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:AGENTIC_EXPLORATION_STATUS_CODES_LIVE -ErrorAction SilentlyContinue
  Remove-Item Env:AGENTIC_EXPLORATION_STATUS_CODES_CONFIG -ErrorAction SilentlyContinue
  Remove-Item Env:AGENTIC_EXPLORATION_STATUS_CODES_ARTIFACT_ROOT -ErrorAction SilentlyContinue
  $secureKey.Dispose()
  Remove-Variable secureKey -ErrorAction SilentlyContinue
}
```

The real-provider proof submits the reviewed seven-step Status Codes scenario:

1. Navigate to `https://the-internet.herokuapp.com/`.
2. Click the `Status Codes` link.
3. Observe exact `/status_codes` URL.
4. Click the `200` link using its current MCP ref and WP2A binding, without
   replay locator generation or quality assessment.
5. Observe exact `/status_codes/200` URL.
6. Click the `here` link in the return sentence using a fresh current binding.
7. Observe exact `/status_codes` URL.

The test constructs these URLs with the URL parser from the canonical site root.
It asserts the exact three expected URLs before any provider call. Earlier live
traces created with a double slash in the expected paths are invalid release
evidence; rerun the proof with a fresh TestSpec after this correction.

The test requires seven authored goals in order, successful post-action
observation/evaluation, all three URL observations passing, and immutable
`SuccessfulExplorationTrace v1` readback. Its single safe evidence line reports
the TestSpec, attempt, trace, profile/fingerprint, goal and record counts,
assertion results, numeric-link binding success, trace store key, and explicit
false values for compilation, v6 creation, and deterministic replay. The
private artifact is stored under:

`<artifactRoot>/<testSpecId>/agentic-explorations/<explorationAttemptId>.json`

The live trace may also contain closed `state_observed` records when the public
page changes between authored operations. Those records preserve the observed
state chain without asserting that the change is replayable. The seven authored
records must still appear exactly once and in order; a future compiler must
resolve any passive transition or reject the trace.

If exploration stops, the test prints `AGENTIC_EXPLORATION_STOP_SAFE_EVIDENCE`
before failing. This bounded line contains only the typed stop/status, profile
fingerprint, authored step IDs, closed decision kinds/verdicts, and observed
effect codes. It excludes page text, URLs, MCP references, provider output, and
the API key. Return this line for diagnosis; a stopped run is not a passed WP2
live proof.

Do not share the stored trace itself, API key, request/response payloads,
provider output, raw MCP calls, page text, snapshots, screenshots, or unrelated
job artifacts. Share only the safe evidence line and the final container check.

After the run, confirm the browser is disposed and no G1 browser container
remains:

```powershell
docker ps -a --filter "name=public-browser-g1-" --format "{{.Names}} {{.Status}}"
```

The listing must be empty. A successful run proves agentic exploration and
trace persistence only. Compiler implementation must still independently
derive/verify a closed deterministic path; no QA result is established by this
gate.

## Completed WP2 release proof

On 2026-09-24 the operator ran the exact approved headless Status Codes profile
through the opt-in real-provider test. The complete gate passed 36/36 tests.
The safe proof identified TestSpec
`test-agentic-status-codes-44482e6a-d588-479a-bae6-40e1bff997de`, attempt
`explore-7b9a3dfe-e6da-4f9f-b70c-ea3c0c11de05`, and immutable trace
`trace-2045201c-0b11-48db-a914-67dd0817d9d7` under profile fingerprint
`80a681aab2237c2536ed762ea53585a0cc4205dfe95a13bab0f3c0b2608eea9d`.
Readback confirmed seven authored records in order, one protected
`state_observed` transition, three current-state action bindings, and three
passed URL observations. The `200` link was bound and acted on before any
replay locator was required. Cleanup was verified and the residual G1
container listing was empty. No compiler attempt, ResolvedTestSpec v6, or
deterministic replay occurred. **The WP2 agentic-exploration gate is complete;**
the trace compiler remains the next separate work package.
