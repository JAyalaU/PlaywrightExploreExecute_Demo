# Phase 3 local Streamlit operator guide

This guide covers the supported local stakeholder workflow: approve one public
HTTP(S) start URL, enter the URL and a natural-language task in Streamlit, and
review the final typed result and safe evidence projection.

The UI is for one local operator. It is not a hosted service and must remain
bound to `127.0.0.1`. Python owns the form and subprocess supervision. Node
continues to own public-target admission checks, model and MCP work, browser
policy, deterministic replay, QA classification, reports, and evidence.

## Prerequisites and setup

Use Node.js 24, Python 3.12 or newer, `npm`, `uv`, and Docker Desktop (or a
supported Docker runtime) that is available to the current user. The project
uses Node's built subprocess entries and a disposable protected browser
container.

From PowerShell 7 at the repository root:

```powershell
npm ci
uv sync
npm run build
```

The guarded launcher starts Streamlit on `http://127.0.0.1:8501`. It rejects
external bind configuration and does not accept command-line binding or script
arguments. Use only `uv run playwright-demo-ui`; a direct `streamlit run` is
outside the supported launch path. Do not configure Streamlit to listen on
`0.0.0.0`, a LAN address, or another externally reachable interface.

## Inspect and approve a public URL

Each approval is for the exact canonical start URL, hostname, default port, and
DNS address set displayed by Node. The URL field does not grant network
authority. A newly submitted target needs its own approval. Node rejects
credentials in URLs, IP literals, non-default ports, and non-public or reserved
addresses. Changed DNS answers require a new inspection and approval. The
approved proxy denies unapproved hosts and ports; redirects and secondary
requests do not silently add network permission.

Create a new local job directory for each approval. The trusted configuration
and inspection output are operational authority data: keep them local and do
not commit or share them. The `jobs/` directory is ignored by Git. Avoid
putting secrets in URL query parameters because the approved URL is stored in
that local configuration.

```powershell
$targetUrl = 'https://the-internet.herokuapp.com/challenging_dom'
$jobRoot = Join-Path $PWD ("jobs\p3-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $jobRoot -Force | Out-Null
$inspectionPath = Join-Path $jobRoot 'inspection.json'
$trustedConfig = Join-Path $jobRoot 'trusted-config.json'
$artifactRoot = Join-Path $jobRoot 'artifacts'

node .\dist\profile\admission-cli.js inspect $targetUrl |
  Set-Content -Encoding utf8 $inspectionPath
if ($LASTEXITCODE -ne 0) { throw 'Public URL inspection failed.' }
Get-Content -Raw $inspectionPath

node .\dist\profile\admission-cli.js approve `
  $inspectionPath $trustedConfig $artifactRoot
```

Review the exact canonical URL, port, and every displayed DNS pin. The approve
command performs a fresh inspection and asks you to type the complete canonical
URL. Approval fails if DNS changed. It creates a new config rather than
overwriting an existing one. Do not edit pins or profile contents under an
existing approval. A secondary hostname needs separate reviewed approval; if
the site requires it and it is not approved, expect a typed stop.

The trusted configuration path is selected at process launch using
`PLAYWRIGHT_DEMO_TRUSTED_CONFIG`. It is never a form field. The generated
configuration contains the profile, policy, approval, artifact root, and
evidence settings; it does not contain the OpenAI key.

## Verify the exact profile before a live run

Run the opt-in profile proof after creating or changing an approval. Use a
separate PowerShell 7 terminal without a real provider key; the sentinel below
is deliberately not a credential.

```powershell
$env:PUBLIC_BROWSER_P3F_RUNTIME = '1'
$env:PUBLIC_BROWSER_P3F_CONFIG = (Resolve-Path -LiteralPath $trustedConfig).Path
$env:OPENAI_API_KEY = 'P3_F_NON_SECRET_SENTINEL'
try {
  npx.cmd playwright test tests/public-admission-config-runtime-p3f.spec.ts --workers=1
} finally {
  Remove-Item Env:PUBLIC_BROWSER_P3F_RUNTIME -ErrorAction SilentlyContinue
  Remove-Item Env:PUBLIC_BROWSER_P3F_CONFIG -ErrorAction SilentlyContinue
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
}
```

Require all four tests to pass with no skips. The proof checks the exact
approval's isolation, proxy behavior, denied loopback, proxy failure,
timeout/cancellation disposal, and absence of residual browser containers.
Stop if any assertion fails; do not broaden policy to make a site work.

## Launch the UI and submit a task

Enter the key through PowerShell's secure prompt, then expose it to the local
host process environment for the run. The Python host inherits that environment
and starts the trusted Node child; the key is not put in Streamlit form state,
the task request, JSON protocol, trusted config, or ordinary evidence. The
isolated browser container does not receive the provider key. Do not paste the
key into a command literal, URL, task, source file, or configuration file.

```powershell
$trustedConfig = (Resolve-Path -LiteralPath $trustedConfig).Path
$secureKey = Read-Host 'OpenAI API key' -AsSecureString
try {
  $env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
  if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) {
    throw 'OpenAI API key is empty.'
  }
  $env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG = $trustedConfig
  uv run playwright-demo-ui
} finally {
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG -ErrorAction SilentlyContinue
  $secureKey.Dispose()
  Remove-Variable secureKey -ErrorAction SilentlyContinue
}
```

Open `http://127.0.0.1:8501`. Enter the same approved URL and a task whose
assertion is supported by the closed TestSpec contract, then select **Start
test**. One run is allowed at a time. The UI waits for the host's final result;
subprocess protocol v1 does not provide live interpretation or replay progress.

To troubleshoot provider or host failures, the optional
`PLAYWRIGHT_DEMO_UI_DIAGNOSTICS=1` setting emits closed, redacted
`P3_UI_SAFE_DIAGNOSTIC` events to the launcher terminal. Diagnostics include
only approved event, status, failure-code, and correlation fields. They do not
include the key, task, provider response body, page content, or raw child
stderr. Turn the setting off after troubleshooting.

## Read results and evidence

The UI distinguishes admission denial/unavailability, a trusted engine result,
a Node bridge error, and a Python process failure. Engine results distinguish
QA assertion failure from automation stop and success. A provider or browser
failure is not a QA assertion failure. The UI displays safe status and reason
codes, correlation IDs, profile fingerprint, presentation/provenance, and
available run IDs.

When Node reports an available report, Python requests the separate
`reportProjectionVersion: "1"` read-only projection. Node reconstructs and
correlates its own report. The projection bounds outcomes and evidence
descriptors, validates closed vocabularies, withholds page-derived strings,
and excludes artifact paths, report references, hashes, provider output, and
binary evidence bytes. Only approved primitive assertion values can be shown;
strings are withheld. Projection failure does not change the QA result.

Screenshot state is explicit: `capture_disabled`, `not_captured`, or
`stored_restricted`. The P3-F profile had screenshot capture disabled. A
restricted screenshot may appear as metadata only; the UI does not display its
bytes. Evidence descriptors identify type, sensitivity, size, time, owner, and
safe evidence ID. They do not grant access to Node-owned artifact files. Do not
copy raw job artifacts or restricted evidence into support reports.

## Stop and clean up

When the final result appears, stop Streamlit with **Ctrl+C** in the launcher
terminal. The launch command's `finally` block removes the provider key and
trusted-config environment variable and disposes the secure prompt value.
Normal success, failure, timeout, and cancellation paths close protected
browser sessions. Verify that no G1 browser container remains:

```powershell
docker ps -a --filter "name=public-browser-g1-" --format "{{.Names}} {{.Status}}"
```

The expected output is empty after a completed/cleaned-up run. A forced process
termination can leave cleanup unverified; inspect Docker before another run.
Keep the trusted configuration and artifact directory for as long as the
approved retention period requires. Expiry is enforced on reads, but pruning
is an explicit `LocalArtifactStore.pruneExpired()` operation and is not run by
the UI. There is no UI cleanup button. Do not delete artifacts while a run is
active, and do not assume that expired directories remove themselves.

## Recorded Phase 3 gates

Re-run the credential-free automated gate after a code change:

```powershell
npm run test:p3-e-offline
```

This gate requires no OpenAI key. The protected-browser composition proof is
opt-in and is recorded separately from its offline tests.

P3-E passed the credential-free composition gate through Streamlit, Python,
Node admission, the existing protocol-v1 host, the test-only injected-model
engine seam, and Node's report projection. It verified profile correlation,
two distinct deterministic replay IDs, `QA_ASSERTION_PASSED`, private-target
denial before engine start, and projection subprocess pipe cleanup. The recorded
offline run had 161 Playwright tests pass (18 opt-in skips) and 35 Python tests
pass (2 skips). The exact-profile protected-browser proof passed 2/2 with an
empty residual-container check. A prior two-worker run encountered an existing
M5 screenshot timeout; the serial release run passed.

P3-F then passed through the real UI and provider path. See the [P3-F proof
record](p3-f-live-proof.md): the approved Challenging DOM task returned
`QA_ASSERTION_PASSED` in two fresh deterministic replays, the report projection
was available with 10 redacted evidence descriptors, screenshot state was
`capture_disabled`, and headless provenance was `no_intervention` with
`autonomousEligible: true`. The operator's recorded container check was empty.
Safe UI diagnostics recorded admission approval, engine success, and completed
projection. The fingerprint and correlation references are in the proof record.

Known limits are intentional for this PoC: one local operator, loopback-only
access, one synchronous run, no streamed stage progress, no image-byte viewing,
and no promise that every public site is usable with one-host approval. A new
host or DNS set requires fresh approval and exact-profile proof. Hosted access,
authentication, queues, databases, noVNC, and `.spec.ts` export are not part of
Phase 3.

## Further reading

- [Phase 3 implementation plan](phase-3-implementation-plan.md)
- [P3-A public URL admission](p3-a-public-admission.md)
- [P3-B report projection](p3-b-report-projection.md)
- [P3-F live proof](p3-f-live-proof.md)
- [Phase 2 runbook](runbook.md)
