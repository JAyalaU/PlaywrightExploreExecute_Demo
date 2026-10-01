# P4-2C live-image release proof

Status: **P4-2C complete.** The credential-free exact-profile protected runtime
gate passed, and the human operator subsequently attested that the separate
real-provider Streamlit live-image proof passed. These remain distinct proofs.
The protected automated run uses the test-only deterministic model harness and
does not need `OPENAI_API_KEY`. It proves capture delivery, disabled behavior,
capture-on/off replay equivalence, cancellation, receiver failure, and cleanup
through Streamlit, Python, the authenticated image channel, Node, and the
existing isolated browser.

### Recorded protected runtime result

On 2026-09-23, `npm.cmd run test:p4-2c` was run with the exact approved
Challenging DOM trusted configuration and both runtime variables enabled. The
build passed, all 7 Node capture tests passed, and all 24 Python tests passed,
including all 3 protected-browser cases (no skips). Safe release evidence:

```text
P4_2_SAFE_EVIDENCE={"profile":{"id":"admitted-public-9d69d0992851e3253020d15f26a8ee530d6d6d551616366f0285f3be33e780e0","version":"1"},"profileFingerprint":"c5818a77c85f9ed9f4326c468aec682b80b0066effeec37571fe085136b22759","captureEnabledFrames":3,"captureDisabledFrames":0,"captureEnabledQa":"QA_ASSERTION_PASSED","captureDisabledQa":"QA_ASSERTION_PASSED","runIdsPerReplay":2,"enabledImageState":"available","disabledImageState":"capture_disabled","expiryState":"closed","residualContainers":false}
```

The protected cancellation case received a frame before cancellation, returned
`CANCELLED` with `forcedTermination: false`, cleared host-held image bytes, and
left no browser container. Forced termination remains `cleanup: unverified` by
the established subprocess contract. A separate Docker query after the suite
was also empty. This deterministic injected-model proof does not satisfy the
real-provider UI proof below.

### Recorded human-operated proof

On 2026-09-23, the operator reported that the real-provider UI verification
described below passed and explicitly asked that this attestation be accepted.
The operator did not provide a sanitized transcript, frame count, correlation
IDs, or a separate residual-container output for that run; this record does not
invent those observations. The credential-free results above provide the
independent exact-profile bounds, cancellation, and cleanup evidence. With the
operator's attestation for the live UI proof, the P4-2C release gate is closed.

## Credential-free protected runtime

Run from PowerShell 7 in the repository after Docker Desktop is available. Use
the operator-approved Challenging DOM trusted configuration from P3-F. The test
keeps the approved target, profile, policy, and fingerprint unchanged, redirects
only the artifact root to temporary storage, and adds the P4-G1 image approval
to a disposable derived configuration. It removes `OPENAI_API_KEY` from the
injected-model child environment.

```powershell
$trustedConfig = 'C:\path\to\operator-approved\trusted-config.json'
if (-not (Test-Path -LiteralPath $trustedConfig)) { throw 'Trusted config not found.' }

$env:PUBLIC_BROWSER_P4_2_RUNTIME = '1'
$env:PUBLIC_BROWSER_P4_2_CONFIG = $trustedConfig
try {
  npm.cmd run test:p4-2c
} finally {
  Remove-Item Env:PUBLIC_BROWSER_P4_2_RUNTIME -ErrorAction SilentlyContinue
  Remove-Item Env:PUBLIC_BROWSER_P4_2_CONFIG -ErrorAction SilentlyContinue
}
```

Expected result: the Node capture tests and Python P4-1/P4-2 channel tests pass,
and three exact-profile protected UI cases pass without skips:

* approved capture displays a correlated bounded frame; capture-disabled mode
  displays no bytes; both modes produce two fresh `QA_ASSERTION_PASSED` replays;
* cancellation after a protected frame clears host-held bytes and closes the
  session, with process cleanup reported using the existing `unverified`
  semantics;
* a controlled image receiver failure withholds images, leaves both replay
  outcomes and final QA unchanged, and disposes the protected browser.

The protected test emits one `P4_2_SAFE_EVIDENCE` JSON line with profile
reference/fingerprint, frame states/counts, QA status, replay count, expiry
state, and residual-container result. It contains no image bytes, page pixels,
provider information, task text, credentials, or artifact paths. Also verify
that the final Docker query is empty:

```powershell
docker ps -a --filter "name=public-browser-g1-" --format "{{.Names}} {{.Status}}"
```

The test's expiry assertion advances only the disposable in-memory buffer's
monotonic clock; it does not sleep for a minute. Existing P4-2A tests cover the
never-settling CDP timeout/no-overlap correction, failure isolation, bounds, and
capture not blocking runner work. Existing P4-2B tests cover channel auth,
correlation, JPEG validation, inline rendering without a reusable media
endpoint, and post-expiry display denial.

If Docker is unavailable or any protected case is skipped, report the protected
gate as **unverified**, not passed. Do not substitute a localhost fixture or
mock browser for the approved profile proof.

## Human-operated real-provider UI proof

This proof demonstrates the actual image/timeline presentation while the real
OpenAI/MCP workflow executes. It is separate from the deterministic protected
gate. The operator holds the provider credential; never paste it into a command
or save it in a file.

Create a separate trusted config copy that preserves the approved public
admission, profile, policy, and fingerprint. Add the explicit P4-G1 trusted
approval to that copy. In PowerShell:

```powershell
$trustedConfig = 'C:\path\to\operator-approved\trusted-config.json'
$liveConfig = Join-Path $PWD 'jobs\p4-2-live-trusted-config.json'
$config = Get-Content -Raw -LiteralPath $trustedConfig | ConvertFrom-Json -AsHashtable
$config['liveImagePolicy'] = @{
  liveImagePolicyVersion = '1'
  captureApproved = $true
  displayApproved = $true
}
$config | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $liveConfig -Encoding utf8

$env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG = $liveConfig
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

Open only `http://127.0.0.1:8501`. Use the approved target and stakeholder task:

- URL: `https://the-internet.herokuapp.com/challenging_dom`
- Task: `Go to https://the-internet.herokuapp.com/challenging_dom. In the table row containing Iuvaret1, select the edit link. Confirm that the URL is exactly https://the-internet.herokuapp.com/challenging_dom#edit.`

The UI should show the ordered P4-1 timeline and a live browser image labeled
with its attempt/run owner and capture time. The final result should show
`QA_ASSERTION_PASSED`, two distinct replay IDs, and an available safe report
projection. The image is ephemeral and may show page pixels; choose a page
suitable for local viewing. Close the browser tab after the run and stop the UI
with Ctrl+C. The `finally` block removes the credential and trusted-config
environment variables. Then run the residual-container query shown above.

Return only the profile reference/fingerprint, safe correlation IDs, image
states and frame count, bounds and owner labels, event kinds/count or
unavailable/truncated state, terminal QA status, two run IDs, report
availability, and cleanup result. Do not return screenshots, image bytes,
page text, provider/model output, raw logs, credentials, or unrestricted
artifacts.

P4-2 is closed on the recorded credential-free protected run and the operator's
attestation of the separate real-provider UI proof. A skip, injected-model
result, or stored report alone does not prove that the UI displayed live pixels.
