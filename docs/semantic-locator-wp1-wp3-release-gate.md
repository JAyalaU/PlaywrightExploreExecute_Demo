# Semantic-locator WP1–WP3 release gate

## Current result

Credential-free regressions passed: 88 tests across the WP1–WP3 contracts and
M6/M7 resolver, handoff, evidence, report-projection, live-event, and
headed-observation suites. One pre-existing credentialed headed test was
skipped. The original protected Status Codes attempt is available at
`jobs/status-codes-demo/artifacts/local-b9de4a2a-f843-4995-ae2a-1dbbd21af2d3/attempts/explore-f18d8043-31eb-4229-b4e5-cf8ee2b7c52a.json`.
It contains the original five-step request: navigate to the root, click Status
Codes, assert `/status_codes`, select the `200` link, then assert
`/status_codes/200`. The first three operations succeeded. The `200` target at
authored Step 4 produced two `LOCATOR_QUALITY_FAILED:WEAK_IDENTITY` results
for the same execution step (`x4`), so the click did not complete. The attempt
has six evidence refs, no ResolvedTestSpec, and predates WP3's developer
diagnostic records. It does not contain the later `here` navigation step.

The protected live-provider gate is prepared below but remains manual. This
checkout's Challenging DOM approval is bound to that route only; it must not be
reused for the Status Codes workflow.

## Fresh protected target approvals

Run in PowerShell from the repository root. These commands inspect the exact
Status Codes start URL, show current DNS pins, require the operator to review
them and type the exact URL, then write separate headed and headless trusted
configs. The approval tool rechecks DNS before writing. The API key is not part
of this step.

```powershell
npm.cmd run build
uv sync

$targetUrl = 'https://the-internet.herokuapp.com/'
$jobRoot = Join-Path $PWD ("jobs\semantic-locator-wp1-wp3-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$artifactRoot = Join-Path $jobRoot 'artifacts'
New-Item -ItemType Directory -Path $jobRoot -Force | Out-Null
$headlessInspection = Join-Path $jobRoot 'headless-inspection.json'
$headlessConfig = Join-Path $jobRoot 'headless-trusted-config.json'
$headedInspection = Join-Path $jobRoot 'headed-inspection.json'
$headedConfig = Join-Path $jobRoot 'headed-trusted-config.json'

node .\dist\profile\admission-cli.js inspect $targetUrl |
  Set-Content -Encoding utf8 $headlessInspection
if ($LASTEXITCODE -ne 0) { throw 'Headless target inspection failed.' }
node .\dist\profile\admission-cli.js approve `
  $headlessInspection $headlessConfig (Join-Path $artifactRoot 'headless')
if ($LASTEXITCODE -ne 0) { throw 'Headless target approval failed.' }

node .\dist\profile\admission-cli.js inspect $targetUrl |
  Set-Content -Encoding utf8 $headedInspection
if ($LASTEXITCODE -ne 0) { throw 'Headed target inspection failed.' }
node .\dist\profile\admission-cli.js approve-headed `
  $headedInspection $headedConfig (Join-Path $artifactRoot 'headed')
if ($LASTEXITCODE -ne 0) { throw 'Headed target approval failed.' }
```

Review that each approval is for exactly `https://the-internet.herokuapp.com/`,
port 443, and the inspected public addresses for the approved host. The
profile's network policy permits only that host and port, which covers the
three requested paths while blocking unrelated destinations.

## Headed observational proof

Add the reviewed live image setting to a disposable copy of the headed config.
The generated `approve-headed` config already contains its view-only viewer
approval.

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

Open only `http://127.0.0.1:8501`. Submit the URL
`https://the-internet.herokuapp.com/` and this task:

> Go to https://the-internet.herokuapp.com/. Locate the link that says Status Codes and click it. Confirm the URL is exactly https://the-internet.herokuapp.com/status_codes. Locate the link with text "200" and click it. Confirm the URL is exactly https://the-internet.herokuapp.com/status_codes/200. Locate the "here" link in the sentence ending with "go here" and click it. Confirm the URL is exactly https://the-internet.herokuapp.com/status_codes.

Confirm the embedded browser shows the same protected session progressing.
The headed result must show a complete resolved workflow, two distinct fresh
replay run IDs, `QA_ASSERTION_PASSED`, `presentationMode: headed`,
`observation.state: observational`, and `autonomousEligible: false`. Confirm
the viewer is view-only, event and image ownership changes across the attempt
and replay runs, and the browser/viewer closes at completion.

## Separate fresh headless autonomous proof

Run the dedicated protected provider gate with the headless approval generated
above. It uses the real Node provider path through the Python production host,
asserts two fresh deterministic replays, reconstructs the stored report, and
checks the private M7 diagnostic files against the decision events and
stakeholder projection.

```powershell
$env:SEMANTIC_LOCATOR_STATUS_CODES_LIVE = '1'
$env:SEMANTIC_LOCATOR_STATUS_CODES_HEADLESS_CONFIG = $headlessConfig
$secureKey = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) { throw 'API key is empty.' }
try {
  npm.cmd run test:semantic-locator-status-codes-live
} finally {
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:SEMANTIC_LOCATOR_STATUS_CODES_LIVE -ErrorAction SilentlyContinue
  Remove-Item Env:SEMANTIC_LOCATOR_STATUS_CODES_HEADLESS_CONFIG -ErrorAction SilentlyContinue
  $secureKey.Dispose()
  Remove-Variable secureKey -ErrorAction SilentlyContinue
}
```

The test requires a fresh headless approval for the exact root URL, verifies
the resolved URL assertions in order, checks the 200 projection's retained
MCP rejection provenance and selected-reference match, checks the `here` link
has a reviewed accepted locator, and requires all M7 decisions to have one
closed private diagnostic record. It compares diagnostic count with validated
`step_decision_finished` live events, proves diagnostics are absent from those
events and the stakeholder report projection, and prints only safe IDs,
profile fingerprint, statuses, and boolean proof fields.

## Safe evidence and cleanup

Retain only these safe fields in release notes: profile references and
fingerprints, TestSpec/attempt/resolved/run IDs, three exact URL assertion
results, terminal statuses, Step 4 projection/provenance check, Step 6
accepted-locator check, diagnostic count/closed-field check, live event count,
headed observation fields, report availability, and cleanup result. Do not
copy provider output, page text, raw MCP data, locator expressions, snapshots,
screenshots, traces, video, or the API key.

After each run, stop the local UI and verify the protected browser containers
are gone:

```powershell
docker ps -a --filter "name=public-browser-g1-" --format "{{.Names}} {{.Status}}"
```

An empty listing is required. Record each workflow separately; a headed result
cannot establish autonomous eligibility, and the headless run must have a
fresh TestSpec/attempt/resolved-spec/run chain.

## Closure

The credential-free regression gate is passed. Formal semantic-locator closure
requires the operator-run headed Status Codes proof and the separate fresh
headless provider gate above. Until those results are captured, the release
status is **manual verification required**.
