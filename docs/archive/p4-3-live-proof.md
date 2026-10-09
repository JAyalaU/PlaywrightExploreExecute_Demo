# P4-3 headed-viewer release proof

Status: **credential-free protected release coverage passed; manual real-provider
Streamlit proof remains required**. This record follows the P4-3 exit criteria in
the [Phase 4 plan](phase-4-implementation-plan.md) and the reviewed
[P4-G2 contract](p4-g2-headed-viewer.md). Headed observation and the independent
headless autonomy proof are separate executions.

## Operator observation during the first live attempt

The operator reported that the headed and separate headless workflows completed,
but the embedded headed browser view stayed gray for most of the run. The live
image did not retain a sequence that could be reviewed after the run. The
headed viewer observation criterion is therefore **not yet verified**, even if
the typed QA result succeeded. The headless run does not substitute for that
viewer proof.

A focused UI correction registers an in-progress viewer connection before the
asynchronous noVNC module import, so the 500 ms Streamlit fragment refresh
cannot spend the same single-use viewer capability again. The viewer now has
its own refresh fragment in a container before the URL/task form; new timeline
events cannot move it down the page. The isolated headed CDP connection applies
a fixed 750 ms Playwright `slowMo` for observable browser actions. It does not
change the fresh headless path, require a task-controlled setting, or extend
the viewer channel. Short sessions also ended quickly, so an approved headed viewer session allows
3 seconds for connection before browser work and holds its final page for
4 seconds before normal disposal. Both waits are bounded and cancellation
interrupts them. The credential-free protected headed gateway and
three-owner/cancellation regressions passed after this change, with no residual
browser container.

A later full-frame pixel regression reproduced the gray/striped display even
on a stationary red test page. Chromium's own screenshot was complete, and the
RFB server sent complete red frames. The pinned Ubuntu noVNC 1.3.0 raw decoder
incorrectly wrote the alpha channel without the receive-buffer offset. The
headed image now applies the exact one-line correction present in noVNC 1.4.0
to its copied noVNC assets; the image build fails if the pinned source differs.
The corrected protected viewer test verifies red pixels at six positions across
the canvas, plus gateway denial and disposal. The P4-3A image tests and full
P4-3B runtime suite passed after rebuilding. The next manual headed run must
verify that active browser
pixels appear before navigation finishes, the final page is visible briefly,
and owner transitions are labeled correctly. P4-2 retains only its
reviewed latest two in-memory frames and clears them after expiry; a persistent
image gallery is outside the current live-image contract.

## Credential-free release coverage

The following tests were executed with Docker Desktop access and without
`OPENAI_API_KEY`:

| Coverage | Result | Evidence |
|---|---|---|
| TypeScript production build | Passed | `npm.cmd run build` |
| P4-3A headed compartment, distinct image, mount/port restrictions, display startup, forged RFB input denial, disposal | 3/3 passed | `npm.cmd run test:p4-3a-container`; emitted `P4_3A_HEADED_CONTAINER_AND_RFB_PROOFS_PASSED` |
| P4-3B profile/admission, RFB and WebSocket validators | 3/3 passed | `npx.cmd playwright test tests/live-viewer-p4-3b.spec.ts --workers=1` |
| P4-3B gateway, pinned noVNC client, stale/cross-origin/single-use capability denial, six-position full-frame pixel proof, exact public proxy path and disposal | 2/2 passed | `PUBLIC_BROWSER_P4_3B_RUNTIME=1 npx.cmd playwright test tests/live-viewer-runtime-p4-3b.spec.ts --workers=1` |
| Python viewer protocol and Streamlit rendering/authorization behavior | 12/12 passed | `uv --cache-dir .uv-cache-p4 run python -m unittest tests.python.test_live_viewer_p4_3b tests.python.test_live_viewer_ui_p4_3c -v` |
| Python-to-Node protected owner transitions and cancellation/disposal | 2/2 passed | `PUBLIC_BROWSER_P4_3B_RUNTIME=1 uv --cache-dir .uv-cache-p4 run python -m unittest tests.python.test_live_viewer_release_p4_3b -v` |

Runtime assertions prove three distinct owner sessions (exploration attempt and
two replay runs), each closed; headed result classification is observational
with `autonomousEligible: false`; and cancellation revokes the viewer and
removes its protected container. The Node gateway runtime test connects the
pinned noVNC client to the actual headed Chromium display. Python tests prove
that Streamlit emits the client only for a validated current headed handle,
keeps its capability out of browser storage and URL query/fragment, disables
client input, and removes it for transition/closed/unavailable states.

The runtime tests passed on an elevated rerun after the sandbox could not access
the Docker Desktop named pipe. This was an execution-environment restriction;
the successful run used the same repository tests. The P4-3A script's residual
headed-container query passed. The protected P4-3B owner-transition and
cancellation tests also completed their per-session cleanup assertions.

These tests do not launch the actual Streamlit app in a browser with a real
provider credential. They do not establish the embedded Streamlit `st.html`
viewer's stability during a
real OpenAI/MCP workflow. That required manual gate remains open below.

## Manual real-provider proof

Run in PowerShell 7 at the repository root. First build and sync dependencies:

```powershell
npm.cmd ci
npm.cmd run build
uv sync
```

Create two separately approved configs for the same target. Approval is
bound to the inspected URL and DNS pins. Review the complete host/port/address
set printed by each approval command before typing the URL to approve.

```powershell
$targetUrl = 'https://the-internet.herokuapp.com/challenging_dom'
$jobRoot = Join-Path $PWD ("jobs\p4-3-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $jobRoot -Force | Out-Null
$artifactRoot = Join-Path $jobRoot 'artifacts'
$headedInspection = Join-Path $jobRoot 'headed-inspection.json'
$headlessInspection = Join-Path $jobRoot 'headless-inspection.json'
$headedConfig = Join-Path $jobRoot 'headed-trusted-config.json'
$headlessConfig = Join-Path $jobRoot 'headless-trusted-config.json'

node .\dist\profile\admission-cli.js inspect $targetUrl |
  Set-Content -Encoding utf8 $headedInspection
if ($LASTEXITCODE -ne 0) { throw 'Headed target inspection failed.' }
node .\dist\profile\admission-cli.js approve-headed `
  $headedInspection $headedConfig (Join-Path $artifactRoot 'headed')
if ($LASTEXITCODE -ne 0) { throw 'Headed public approval failed.' }

node .\dist\profile\admission-cli.js inspect $targetUrl |
  Set-Content -Encoding utf8 $headlessInspection
if ($LASTEXITCODE -ne 0) { throw 'Headless target inspection failed.' }
node .\dist\profile\admission-cli.js approve `
  $headlessInspection $headlessConfig (Join-Path $artifactRoot 'headless')
if ($LASTEXITCODE -ne 0) { throw 'Headless public approval failed.' }
```

For the headed UI proof, enable the separately reviewed P4-2 image capture in a
disposable copy of the approved headed config. This allows the live image and
viewer to appear alongside the P4-1 timeline. It does not change the headed
approval, profile, network policy, or fingerprint.

```powershell
$headedLiveConfig = Join-Path $jobRoot 'headed-live-config.json'
$config = Get-Content -Raw -LiteralPath $headedConfig | ConvertFrom-Json -AsHashtable
$config['liveImagePolicy'] = @{
  liveImagePolicyVersion = '1'
  captureApproved = $true
  displayApproved = $true
}
$config | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $headedLiveConfig -Encoding utf8

$env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG = $headedLiveConfig
$secureKey = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) { throw 'API key is empty.' }
try {
  uv run playwright-demo-ui
} finally {
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG -ErrorAction SilentlyContinue
  $secureKey.Dispose()
  Remove-Variable secureKey -ErrorAction SilentlyContinue
}
```

Open only `http://127.0.0.1:8501`. Submit:

- URL: `https://the-internet.herokuapp.com/challenging_dom`
- Task: `Go to https://the-internet.herokuapp.com/challenging_dom. In the table row containing Iuvaret1, select the edit link. Confirm that the URL is exactly https://the-internet.herokuapp.com/challenging_dom#edit.`

Verify the actual embedded view shows the same active browser progressing
through exploration and replay. Check the timeline owner transition for the
attempt and each run; old pixels/viewer must disappear when the owner changes.
Confirm the viewer is labeled view-only, the image is correlated to its owner,
and the final headed result says `QA_ASSERTION_PASSED`,
`presentationMode: headed`, `observation.state: observational`, and
`autonomousEligible: false`. The report projection should be available and two
fresh replay IDs should be present. The browser/viewer must close when the run
finishes; stop the local UI with Ctrl+C.

Then perform the separate fresh headless proof using its independently
approved config. Keep the same provider key only in the launch environment:

```powershell
$env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG = $headlessConfig
$secureKey = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) { throw 'API key is empty.' }
try {
  uv run playwright-demo-ui
} finally {
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG -ErrorAction SilentlyContinue
  $secureKey.Dispose()
  Remove-Variable secureKey -ErrorAction SilentlyContinue
}
```

Submit the same URL and task. Confirm a fresh headless profile identity and
fingerprint, a successful typed QA result, two distinct fresh replay IDs,
`observation.state: no_intervention`, and `autonomousEligible: true`. This run
establishes autonomous equivalence; the headed run cannot do so.

After both UI runs, check that no protected container remains:

```powershell
docker ps -a --filter "name=public-browser-g1-" --format "{{.Names}} {{.Status}}"
```

Close the browser tab after each run. Return only the headed and headless
profile references/fingerprints, TestSpec/exploration/resolved/run IDs, event
kinds/count or truncation state, image state/frame count/owners, viewer state
per owner, headed and headless observation/eligibility fields, QA statuses,
report availability, and whether the Docker query was empty. Do not return the
key, screenshots, page text, provider output, raw artifacts, or raw logs.

## Closure state

P4-3 remains **manual verification required** until both real-provider UI runs
pass and their safe evidence plus final cleanup result are recorded. No
P4-3D/documentation closure is claimed here.
