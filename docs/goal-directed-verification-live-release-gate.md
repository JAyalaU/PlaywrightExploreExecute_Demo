# Historical goal-directed verification live release gate

> **Superseded for current release closeout.** This document records the
> `goal-directed-v1` v4/v3/compiler-v2/v7 route. The current operator proof is
> the trusted `structured-action-v1` v5/v4/compiler-v3/v8 gate in
> [structured-action-identity-live-release-gate.md](structured-action-identity-live-release-gate.md).
> Do not use the criteria below to close the structured-action release.

Status: **ready for operator execution; live proof pending**.

This gate records the first approved real-provider, approved-public-target proof
for the trusted `goal-directed-v1` workflow. It does not authorize a workflow
fallback or release by itself. The existing agentic-v2 release record applies
to `agentic-exploration-v1` and remains separate.

## Automated prerequisites

The WP5 independent automated gate is complete. Its completion record reports:

| Check | Recorded result |
|---|---|
| Full offline Playwright suite | 357 passed, 26 live-gated skips, 0 failed |
| Focused WP5 and compatibility suites | 58 passed, 0 failed |
| Python protocol, host, projection, and UI suites | 29 passed, 0 failed |
| Build and typecheck | Passed |
| Independent assembled security review | Approved to proceed to the approved-public-target proof; focused tests, build, and typecheck passed |

After the first live attempt exposed a goal-directed provider-format allowlist
defect, the Responses transport was corrected. Its first post-fix offline Node
rerun passed 359 tests, 26 opt-in skips, and 0 failures. A later operator
attempt exposed that the released workflow could route a TestSpec v4
VerificationGoal into its v2/v6 exploration path; this now stops before
browser work. After the routing fix, the full offline Node suite passed
**360 tests, 26 opt-in skips, 0 failures**; focused routing/production tests
passed 27/27, build/typecheck passed, and Python protocol/host/projection/UI
compatibility tests passed 42/42.
The live proof must be repeated because the first attempt stopped before
exploration and produced no QA verdict.

The non-provider Add/Remove fixture covers the goal-directed production path,
including TestSpec v4, VerificationGoals, M7 trusted observations, trace v3,
compiler v2/v7, two separate replays, agreeing pass/fail classification,
unsupported compilation, unresolved exploration, provenance checks, and
cleanup. Do not rerun the completed WP5 automated gate for this operator proof
unless repository release policy or a code change requires it. No credentialed
provider workflow has been run as part of automated validation.

The operator proof validates real interpretation/exploration and protected
service behavior that fixtures cannot establish. The architecture and version
boundaries are summarized in [system overview](system-overview.md) and
[WP5B orchestration](goal-directed-production-wp5b.md). The assembled security
review approved proceeding to this live proof; that approval does not substitute
for the proof.

## Operator procedure

### 1. Prepare the local environment

Use PowerShell 7 from the repository root on a single-operator machine with
Node.js 24, Python 3.12 or newer, `npm`, `uv`, and a Docker runtime available
to the current user. Use a dedicated terminal for this run. Install the locked
dependencies and build the current Node entrypoints:

```powershell
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Node dependency installation failed.' }
uv sync
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Node build failed.' }
```

Do not continue if setup or build fails. The completed WP5 automated gate does
not need to be rerun for this operator proof unless repository policy or a code
change requires it. The approval-specific protected-profile proof in step 3
checks the new approval; it is separate from the completed WP5 gate.

### 2. Inspect and approve the exact public target

Create a new local job directory and approval for the canonical root URL. The
approval and artifacts stay under the Git-ignored `jobs/` directory. Do not
commit or share the trusted configuration. Inspection grants no browser
authority; approval rechecks DNS and requires the operator to type the exact
canonical URL. Review the displayed URL, host, default port, and every DNS pin
before confirming. After approval, review the generated policy, profile, and
fingerprint locally. Stop if they differ from the intended target or DNS
changes. Do not edit the generated policy or reuse an approval for another
target.

```powershell
$targetUrl = 'https://the-internet.herokuapp.com/'
$jobRoot = Join-Path $PWD ("jobs\goal-directed-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $jobRoot -Force | Out-Null
$inspectionPath = Join-Path $jobRoot 'inspection.json'
$trustedConfig = Join-Path $jobRoot 'trusted-config.json'
$artifactRoot = Join-Path $jobRoot 'artifacts'

node .\dist\profile\admission-cli.js inspect $targetUrl |
  Set-Content -Encoding utf8 $inspectionPath
if ($LASTEXITCODE -ne 0) { throw 'Public URL inspection failed.' }
Get-Content -Raw -LiteralPath $inspectionPath

node .\dist\profile\admission-cli.js approve `
  $inspectionPath $trustedConfig $artifactRoot
if ($LASTEXITCODE -ne 0) { throw 'Public URL approval failed.' }
Get-Content -Raw -LiteralPath $trustedConfig
```

The approved configuration binds the URL, DNS pins, network policy, execution
profile, and fingerprint. A secondary host or changed DNS answer is a typed
stop, not a reason to broaden the approval during this proof.

### 3. Prove the new approval's protected profile

In a separate PowerShell 7 terminal at the repository root, run the reviewed
approval-specific runtime proof **without a real provider key**. Replace the
path below with the `trusted-config.json` path created in step 2. The sentinel
is deliberately not a credential:

```powershell
$env:PUBLIC_BROWSER_P3F_RUNTIME = '1'
$env:PUBLIC_BROWSER_P3F_CONFIG = (Resolve-Path -LiteralPath 'PATH_TO_TRUSTED_CONFIG').Path
$env:PUBLIC_BROWSER_P3F_EXPECTED_URL = 'https://the-internet.herokuapp.com/'
$env:OPENAI_API_KEY = 'P3_F_NON_SECRET_SENTINEL'
try {
  npx.cmd playwright test tests/public-admission-config-runtime-p3f.spec.ts --workers=1
  if ($LASTEXITCODE -ne 0) { throw 'Approved-profile runtime proof failed.' }
} finally {
  Remove-Item Env:PUBLIC_BROWSER_P3F_RUNTIME -ErrorAction SilentlyContinue
  Remove-Item Env:PUBLIC_BROWSER_P3F_CONFIG -ErrorAction SilentlyContinue
  Remove-Item Env:PUBLIC_BROWSER_P3F_EXPECTED_URL -ErrorAction SilentlyContinue
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
}
```

Require all four tests to pass with no skips and no residual protected browser
containers. This checks the exact approval's proxy/isolation and cleanup. If
the proof fails, stop and record an environment/admission failure; do not run
the credentialed task.

The root-URL approval created on 2026-09-25 for
`https://the-internet.herokuapp.com/` passed this exact-profile proof after
the test's historical `/challenging_dom` expectation was removed: four tests
passed, the approved HTTPS request returned 200, loopback returned 403, and
the residual protected-browser container listing was empty. The approved
profile fingerprint was
`80a681aab2237c2536ed762ea53585a0cc4205dfe95a13bab0f3c0b2608eea9d`.
This is an isolation/admission result, not a goal-directed QA result.

### 4. Launch the goal-directed UI

Return to the dedicated terminal from steps 1–2. Resolve the new config path
and select `goal-directed-v1` through trusted process environment, before the
UI starts. The task text and UI form do not select the workflow. Enter the API
key only at the secure prompt; it must not appear in a command literal, task,
config, artifact, or evidence report. The guarded launcher binds Streamlit to
`127.0.0.1`; use `uv run playwright-demo-ui`, not direct `streamlit run`.

```powershell
$trustedConfig = (Resolve-Path -LiteralPath $trustedConfig).Path
$env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG = $trustedConfig
$env:PLAYWRIGHT_DEMO_WORKFLOW_VERSION = 'goal-directed-v1'
$secureKey = Read-Host 'OpenAI API key' -AsSecureString
try {
  $env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
  if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) { throw 'OpenAI API key is empty.' }
  uv run playwright-demo-ui
} finally {
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG -ErrorAction SilentlyContinue
  Remove-Item Env:PLAYWRIGHT_DEMO_WORKFLOW_VERSION -ErrorAction SilentlyContinue
  $secureKey.Dispose()
  Remove-Variable secureKey -ErrorAction SilentlyContinue
}
```

At `http://127.0.0.1:8501`, enter the approved root URL, paste this task
verbatim, and select **Start test**. Before submitting, confirm the UI says
`Trusted workflow: goal-directed-v1`. If it shows `agentic-exploration-v1`,
`legacy`, or an invalid selection, stop the UI and relaunch from step 4; a task
cannot switch its workflow after launch:

```text
1. Go to https://the-internet.herokuapp.com/.
2. Locate the link that says Add/Remove Elements and click it.
3. Locate the button with the text "Add Element". Confirm it exists.
4. Confirm a button with the text "Delete" does not exist.
5. Click the "Add Element" button.
6. Confirm a button with the text "Delete" exists.
```

### 5. Record the result and verify cleanup

Wait for the terminal result and safe report projection; do not infer a result
from console logs, model text, or a single replay. Record the safe fields and
approved internal confirmations in the evidence tables below. A pass requires the
goal-directed workflow and all linked versions below, two distinct completed
fresh deterministic replays, agreement, and final `QA_ASSERTION_PASSED`. A
single successful exploration, compiler acceptance, or replay is not a pass.

After recording the result, stop the UI normally with Ctrl+C in its terminal.
Then check the protected-browser container listing:

```powershell
docker ps -a --filter "name=public-browser-g1-" --format "{{.Names}} {{.Status}}"
```

For verified normal cleanup the listing must be empty. If the process was
forcibly terminated or the listing is unavailable/nonempty, record cleanup as
unverified and leave the live gate pending.

## Evidence to record

Record only values shown by the safe terminal result/projection or verified
through an approved trusted artifact summary. Use the artifact relationships
to check the chain; do not attach or paste private files. IDs may be recorded
because they are correlation fields in the safe result. Mark an item
`unavailable` rather than deriving it from logs or model text.

### Safe production chain

| Evidence | Operator record |
|---|---|
| Trusted workflow selected | `goal-directed-v1` / observed: ______ |
| TestSpec ID and version | ID: ______ / TestSpec v4 confirmed: yes / no |
| Exploration attempt ID | ______ |
| Successful trace ID and version | ID: ______ / trace v3 confirmed: yes / no |
| Compiler attempt ID and version | ID: ______ / compiler attempt v2 confirmed: yes / no |
| Resolved spec ID and version | ID: ______ / ResolvedTestSpec v7 confirmed: yes / no |
| Replay 1 ID, state, safe result | ID: ______ / state: ______ / result: ______ |
| Replay 2 ID, state, safe result | ID: ______ / state: ______ / result: ______ |
| Final stage and status | stage: ______ / status: ______ |
| Reproducibility | ______ (must be `agreed` to close a QA result) |
| Execution profile reference and fingerprint | ref: ______ / fingerprint: ______ |
| Cleanup | `verified` / `unverified`; residual protected browser containers: empty / present / unavailable |
| Safe projection | available / unavailable |

Confirm that all identifiers link to the same TestSpec, exploration attempt,
trace, compiler attempt, resolved spec, profile/fingerprint, and two replay
records. The final ResultRecordV2 must validate those links, not merely display
unrelated IDs.

### Internal semantic checks

Where reviewed safe artifact summaries expose these facts, record only the
confirmation and the referenced step/record ID. Never copy raw model/provider
reasoning, prompt/response payloads, page snapshots, observation witness bytes,
private strategy journals, raw traces, locators, or unrestricted logs into this
form.

| Check | Expected confirmation |
|---|---|
| Step 4 interpretation | Preserved as a TestSpec v4 `VerificationGoal`; no deterministic assertion operator was assigned during interpretation: yes / no / unavailable |
| M7 absence strategy | Used a trusted complete semantic query/count for button named `Delete`: yes / no / unavailable |
| Pre-click evidence | Trusted complete count was `0`, tied to the pre-click state: yes / no / unavailable |
| Mutation freshness | The pre-click observation was not reused as current after clicking Add Element: yes / no / unavailable |
| Post-click evidence | A fresh trusted complete observation reported one or more Delete buttons: yes / no / unavailable |
| Compiler derivation | Compiler v2 derived the absence/presence assertions from successful strategies: yes / no / unavailable |
| Resolved semantics | v7 contains Delete absence as count `== 0` and post-click presence as count `>= 1`: yes / no / unavailable |
| Replay isolation | Replay 1 and replay 2 each used a fresh protected context, separate from exploration, compiler, and each other: yes / no / unavailable |
| Replay tool boundary | No LLM/MCP ran during either deterministic replay: yes / no / unavailable |
| Workflow isolation | No trace v2/v6 or legacy workflow fallback occurred: yes / no / unavailable |

If a needed internal fact cannot be checked from a reviewed safe summary or
trusted validation result, do not inspect or share raw private evidence to fill
the gap. Mark it unavailable and keep the gate pending until an authorized
safe summary is available.

## Release decision

Close as **pass** only when all of the following are true:

- Interpretation succeeds with TestSpec v4 VerificationGoals, including Step 4
  as a goal rather than a preselected deterministic assertion.
- M7 exploration completes and uses trusted complete observations for the
  pre-click zero count and fresh post-click positive count.
- SuccessfulExplorationTrace v3 is accepted with the ordered path.
- Fresh compiler attempt v2 accepts and emits the linked ResolvedTestSpec v7,
  preserving absence `count == 0` and presence `count >= 1`.
- Replay 1 and replay 2 are distinct, independently completed fresh runs under
  the same approved profile/fingerprint, with no LLM/MCP execution below v7.
- The two deterministic replay outcomes agree and the linked ResultRecordV2
  reports `QA_ASSERTION_PASSED` only after agreement.
- Cleanup is verified and the residual protected-browser container listing is
  empty after normal shutdown.
- The recorded workflow remains `goal-directed-v1` throughout; no cross-version
  fallback or legacy routing occurred.

Any failed stage leaves the live gate **pending/failed at that stage**. Report
the actual stage and status: interpretation, exploration, compilation,
replay/automation, reproducibility, environment, or cleanup. Compilation
unsupported and exploration unresolved produce no QA verdict. One replay or
disagreeing replays produce no authoritative QA result. Never relabel an
automation, environment, cancellation, unsupported, or cleanup stop as a QA
assertion failure or pass.

## Operator closeout

| Closeout field | Record |
|---|---|
| Operator / date (local timezone) | ______ |
| Approved target | `https://the-internet.herokuapp.com/` |
| Workflow version | ______ |
| Terminal stage/status | ______ |
| Reproducibility state | ______ |
| Final ResultRecordV2 status | ______ |
| Cleanup verified and empty | yes / no |
| Safe evidence chain complete | yes / no |
| Internal semantic checks complete | yes / no / unavailable |
| Decision | pass / pending / failed |
| Stage-specific notes (safe facts only) | ______ |

Do not include credentials, raw model output, private observation/witness
material, screenshots, page content, or unrestricted artifacts in the closeout.
