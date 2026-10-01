# Agentic v2 credentialed release gate

Status: **released**. Automated release regressions passed and the operator-reported real-provider proof completed successfully.

This record covers the assembled production path selected by trusted
`PLAYWRIGHT_DEMO_WORKFLOW_VERSION=agentic-exploration-v1`. A credential-free
fixture verifies the Python host, Node v2 CLI, trace v2, fresh compiler, v6,
two deterministic runs, ResultRecordV2, report projection v2, and Python
consumption. It uses a deterministic test model and is not evidence of a real
provider run. The operator separately performed the credentialed UI run and
reported the safe facts recorded below; the reviewer did not request or access
the operator's provider credential.

## Credential-free release regressions

Validation performed on 2026-09-24:

| Check | Result |
|---|---|
| `npm run build` | Passed |
| `npm run typecheck` | Passed |
| Agentic exploration, trace-v2 capture/finalization, compiler, v6 runner, WP4B, v2 contracts, and Node CLI Playwright suites | 83 passed, 1 opt-in provider test skipped |
| Python agentic-v2 consumer/UI plus legacy subprocess, projection-v1, loopback UI, and workflow suites | 40 passed |
| `docker ps -a --filter "name=public-browser-g1-"` | Empty after automated run |

The Node suite exercised the protected seven-goal Status Codes-shaped fixture
through the actual Node child and Python host, including immutable trace v2,
fresh compiler, accepted v6, two distinct deterministic replays, safe report
projection v2, and cross-version denial. It also covered exploration and
compiler stops, replay binding failure, replay disagreement, matching true and
false assertions, provider/environment mapping, cancellation, and cleanup
semantics. The fixture does not establish real OpenAI interpretation or
decision behavior.

The Python tests verified every reviewed v2 terminal category, projection
correlation and denial, unavailable projection behavior, distinct Streamlit
categories, timeline unavailability for agentic jobs, and the unchanged legacy
v1 path.

## Recorded operator-run live proof

The operator reported the following safe facts after running the seven-step
Status Codes scenario through the supported agentic-v2 Streamlit path. This is
the observed release evidence; no identifiers or details beyond this report
are inferred here.

| Field | Observed result |
|---|---|
| TestSpec | `local-3f00e342-7e26-43a6-a32e-89908e5f89fb` |
| Exploration attempt | `explore-e7fc3d92-40c2-49ce-a1da-e82d37882425` |
| Successful trace | `trace-360fdebd-091e-441d-996e-af5964e7df15` (`SuccessfulExplorationTrace v2`) |
| Compiler attempt | `compiler-69fb9970-2703-4fc5-ac0c-36f26de65408` |
| Resolved spec | `resolved-4939c7f0-b54b-4ef5-a963-0368d090b2ca` (`ResolvedTestSpec v6`) |
| Replay 1 | `run-ace2780e-cf96-4288-a8bb-95fe86ef63b6` (`completed_pass`) |
| Replay 2 | `run-b4f585f0-3874-4453-9407-7b89de3cbab4` (`completed_pass`) |
| Profile fingerprint | `80a681aab2237c2536ed762ea53585a0cc4205dfe95a13bab0f3c0b2608eea9d` |
| Stage | `qa` |
| Terminal status | `QA_ASSERTION_PASSED` |
| Exploration / compilation / replay | `completed` / `completed` / `completed` |
| Reproducibility | `agreed` |
| Authoritative QA | `QA_ASSERTION_PASSED` |
| Cleanup | `verified` |
| Report projection | available |
| Screenshot / evidence descriptors | `capture_disabled`; 14 authorized evidence descriptors |
| Agentic terminal timeline | unavailable; deferred until correlation is separately reviewed |

The two distinct replay IDs and matching safe `completed_pass` outcomes show
that authoritative QA followed exploration, immutable trace v2, fresh
compilation to v6, and two deterministic replays. Exploration and compiler
acceptance were not treated as QA verdicts. This closes the reviewed product
authority chain:

`LLM/MCP exploration → trace v2 → deterministic compiler → v6 → two fresh deterministic replays → authoritative QA`

The agentic P4 terminal timeline remains explicitly deferred until its event
correlation is reviewed. Its unavailability did not block this release proof.

## Reproduction procedure (optional)

For a repeat run, create a new exact approval for the canonical root URL and
run the supported loopback Streamlit UI. Use a dedicated PowerShell 7 window.
The approval file and artifact directory remain local under `jobs/` and must
not be committed or shared.

First build the current Node entrypoints, inspect the exact URL, and create a
new approval. Review the inspection URL, port, and every DNS pin before typing
the canonical URL at the approval prompt:

```powershell
npm.cmd run build

$targetUrl = 'https://the-internet.herokuapp.com/'
$jobRoot = Join-Path $PWD ("jobs\agentic-v2-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-" + [guid]::NewGuid().ToString('N'))
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
```

Set the trusted launch selection and run Streamlit. Enter the API key only at
the secure prompt; do not put it in a command literal, task, file, or evidence.
The environment variables are scoped to this PowerShell process. Close this
dedicated window after checking cleanup to discard them.

```powershell
$trustedConfig = (Resolve-Path -LiteralPath $trustedConfig).Path
$env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG = $trustedConfig
$env:PLAYWRIGHT_DEMO_WORKFLOW_VERSION = 'agentic-exploration-v1'
$secureKey = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) { throw 'API key is empty.' }
$secureKey.Dispose()
Remove-Variable secureKey -ErrorAction SilentlyContinue
uv run playwright-demo-ui
```

At `http://127.0.0.1:8501`, enter the approved root URL and this task, then
select **Start test**:

> Go to `https://the-internet.herokuapp.com/`. Locate the link that says
> `Status Codes` and click it. Confirm the URL is exactly
> `https://the-internet.herokuapp.com/status_codes`. Locate the link with text
> `200` and click it. Confirm the URL is exactly
> `https://the-internet.herokuapp.com/status_codes/200`. Locate the `here` link
> in the sentence ending with `go here` and click it. Confirm the URL is exactly
> `https://the-internet.herokuapp.com/status_codes`.

Wait for the terminal result. A passing proof must visibly report **QA passed**
from two matching deterministic replay outcomes, with an available safe report
projection. Check the safe stage summary and correlation fields for exploration,
compilation, both replays, trace, compiler attempt, v6, TestSpec, and profile.
The timeline is expected to say unavailable for agentic v2; do not treat the
legacy event timeline as terminal evidence. Headless is the expected
autonomous-authoritative profile for this run.

After the UI result, stop Streamlit with Ctrl+C and check for residual browser
containers:

```powershell
docker ps -a --filter "name=public-browser-g1-" --format "{{.Names}} {{.Status}}"
```

The listing must be empty after verified normal cleanup. If the Node process
was forcibly terminated, report cleanup as unverified and do not claim the
gate passed.

For a future repeat run, record only safe observed facts: terminal category and
status; profile reference and fingerprint; TestSpec, exploration attempt,
trace, compiler attempt, v6, and two distinct replay IDs; stage outcomes;
projection availability; cleanup state; and whether the residual-container
listing was empty. Do not send the API key, task/page content, provider output,
screenshots, raw trace/compiler artifacts, locators, or unrestricted logs.

## Release closure

The automated checks and operator-observed real-provider facts above close the
release gate. The optional reproduction procedure is not a remaining release
step.
