# Structured action identity real-provider release gate

Status: **ready for operator execution; approved-public-target proof pending**.

This is the current live release gate for the trusted `structured-action-v1`
workflow. The earlier [goal-directed-v1 gate](goal-directed-verification-live-release-gate.md)
is historical and does not close this route. The released
`agentic-exploration-v1` record also remains separate.

This document defines the one required real-provider proof. It does not claim
that the proof has run. Do not run the provider task until the reviewed offline
prerequisites below and exact-profile isolation proof are available.

## Released candidate and authority chain

The operator must select `structured-action-v1` through trusted launch
configuration before interpretation. The job must remain on this route:

```text
TestSpec v5
  -> ActionTargetIntentV1
  -> protected M7 exploration and ActionIdentityWitnessV1
  -> SuccessfulExplorationTrace v4
  -> compiler attempt v3
  -> ResolvedTestSpec v8
  -> fresh deterministic replay 1
  -> fresh deterministic replay 2
  -> reproducibility agreement
  -> ResultRecordV2 authoritative QA result
```

No stage may fall back to TestSpec v4, trace v3, compiler v2, ResolvedTestSpec
v7, released v2/v6, or historical phrase-based action compilation. A stage
stop remains at that stage and produces no QA verdict unless two completed
fresh v8 replays agree.

## Completed offline prerequisites

The independent offline gate is complete; do not rerun it for this operator
proof unless repository policy or a relevant code change requires it.

| Check | Recorded result |
|---|---|
| Final structured-action suites | 38 passed, 0 failed |
| Affected Python host/protocol/UI suites | 33 passed, 0 failed, 1 skipped |
| Typecheck and build | Passed |
| Independent security review | Approved for the final independent offline gate; no provider workflow run |
| Final independent offline gate | Ready for approved-public-target real-provider proof |

The broad-suite results were not wholly green and must not be described as such:

- Initial full Playwright run: 400 passed, 1 failed, 26 skipped. The one
  historical M6 timeout passed when run by itself.
- Initial full Python discovery: 85 passed, 2 failed, 1 error, 10 skipped. An
  AppTest timeout passed alone; a stale P3E synchronous assertion was corrected
  to wait for the admission result and passed; a credential-free historical
  public-site test stopped during exploration.

These broad runs are recorded limitations, not a substitute for the focused
green gate and not claims of clean reruns.

## Operator procedure

Use PowerShell 7 from the repository root on the reviewed single-operator
machine. Use a dedicated terminal. The approved URL is exactly
`https://the-internet.herokuapp.com/`. Use the existing trusted admission and
guarded loopback launch procedures below. Do not edit or share the generated
trusted configuration or artifacts.

### 1. Prepare dependencies and build

Use the checked-in lockfiles and build the Node entrypoints:

```powershell
npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Node dependency installation failed.' }
uv sync
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Node build failed.' }
```

Do not proceed if setup or build fails. The offline gate above need not be
repeated unless required by repository policy or a code change.

### 2. Inspect and approve the exact public target

Create a new job directory and approval. Review the inspection URL, scheme,
host, port, and all DNS pins. At the approval prompt, confirm the exact
canonical target. The approval binds the target, network policy, execution
profile, and fingerprint. Inspection alone grants no browser authority. Stop
if the target or profile differs from the intended approved target; do not
broaden policy or reuse an approval for a different host.

```powershell
$targetUrl = 'https://the-internet.herokuapp.com/'
$jobRoot = Join-Path $PWD ("jobs\structured-action-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-" + [guid]::NewGuid().ToString('N'))
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

Keep `trusted-config.json`, the artifact directory, and private evidence local.
Record the approved profile reference and fingerprint in the closeout form;
never attach the configuration or private artifacts.

### 3. Verify this exact approval's protected runtime

In a separate PowerShell 7 terminal at the repository root, point the reviewed
P3-F isolation proof at the new configuration. The expected URL pins this proof
to the approved root target. The sentinel is not a provider credential. Require
all four tests to pass, no skips, and an empty residual-container listing
before entering a real key or starting the task.

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

Replace only `PATH_TO_TRUSTED_CONFIG` with the full path produced in step 2.
This proof checks the exact approved profile's protected proxy/isolation and
cleanup. A failure is an admission/environment stop; do not run the provider
task to work around it. Record the profile reference and fingerprint printed
by the proof and confirm the residual container listing is empty:

```powershell
docker ps -a --filter "name=public-browser-g1-" --format "{{.Names}} {{.Status}}"
```

### 4. Launch the trusted structured workflow

In the dedicated launch terminal, use the same trusted configuration from step
2. The workflow version is trusted process configuration, not form input. Enter
the provider key only at the secure prompt. Do not put it in a command literal,
task, config, artifact, transcript, or evidence. The guarded launcher binds
Streamlit to loopback; use `uv run playwright-demo-ui`, not direct Streamlit
launch.

```powershell
$trustedConfig = (Resolve-Path -LiteralPath $trustedConfig).Path
$env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG = $trustedConfig
$env:PLAYWRIGHT_DEMO_WORKFLOW_VERSION = 'structured-action-v1'
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

Open `http://127.0.0.1:8501`. Before submitting, verify the UI says
`Trusted workflow: structured-action-v1`. Enter the approved root URL and the
following task exactly, then select **Start test**:

```text
1. Go to https://the-internet.herokuapp.com/.
2. Locate the link that says Add/Remove Elements and click it.
3. Locate the button with the text "Add Element". Confirm it exists.
4. Confirm a button with the text "Delete" does not exist.
5. Click the "Add Element" button.
6. Confirm a button with the text "Delete" exists.
```

If the UI names another workflow or an invalid selection, stop without
submitting and relaunch from step 4. Do not use task wording to switch routes.

### 5. Record the result and verify cleanup

Wait for the final safe result and projection. Do not infer a result from
provider text, logs, a successful exploration, a compiler acceptance, or one
replay. Record the safe fields below. After the run, stop the UI normally with
Ctrl+C and confirm the protected browser container listing is empty:

```powershell
docker ps -a --filter "name=public-browser-g1-" --format "{{.Names}} {{.Status}}"
```

If the process was forcibly terminated, the listing is unavailable, or any
protected browser container remains, cleanup is unverified and the gate stays
open. Never delete an unexpected container as a substitute for determining
whether cleanup completed.

## Operator evidence form

Record values shown by the safe terminal result/projection or verified using
approved safe artifact summaries. Check that every link belongs to this same
job, TestSpec, execution profile, and fingerprint. Mark evidence `unavailable`
when it cannot be verified through an approved safe surface. Do not inspect or
share raw private artifacts to fill a gap.

### Workflow and artifact chain

| Evidence | Operator record |
|---|---|
| Trusted workflow selected before submission | must be `structured-action-v1`; observed: ______ |
| TestSpec ID/version | ID: ______ / must be v5: yes / no / unavailable |
| Exploration attempt ID | ______ |
| Successful trace ID/version | ID: ______ / must be v4: yes / no / unavailable |
| Compiler attempt ID/version | ID: ______ / must be v3: yes / no / unavailable |
| Resolved spec ID/version | ID: ______ / must be v8: yes / no / unavailable |
| Replay 1 ID/result | ID: ______ / result: ______ |
| Replay 2 ID/result | ID: ______ / result: ______ |
| Replay contexts distinct and fresh | yes / no / unavailable |
| Reproducibility | ______ (must be `agreed`) |
| Final stage/status | ______ / must be `qa` / `QA_ASSERTION_PASSED` |
| Execution profile reference | ______ |
| Execution profile fingerprint | ______ |
| Cleanup | verified / unverified |
| Residual protected browser containers after normal stop | empty / present / unavailable |
| Safe ResultRecordV2/report projection | available / unavailable |

### Structured target and verification checks

Use only approved internal artifact summaries or trusted validation results.
Record a yes/no/unavailable confirmation and safe step/record IDs if exposed;
do not copy ActionIdentityWitness fields or payloads.

| Check | Expected confirmation |
|---|---|
| Authored actions | Interpretation produced a structured `ActionTargetIntentV1` for the Add/Remove click and Add Element click: yes / no / unavailable |
| Step 2 requested identity | Structured name corresponds to `Add/Remove Elements`, with the authored link role constraint: yes / no / unavailable |
| Add Element requested identity | Its click has its own structured button/name intent: yes / no / unavailable |
| Runtime proof | Protected runtime created a matching `ActionIdentityWitnessV1` before each authored target action: yes / no / unavailable |
| Selected identity | Requested identity and selected trusted node correspond; prerequisite records, if any, remain separately identified: yes / no / unavailable |
| Step 4 interpretation | Delete absence remained a VerificationGoal; no deterministic assertion operator was assigned at interpretation: yes / no / unavailable |
| Absence strategy | M7 used a trusted complete semantic query/count for button named `Delete`: yes / no / unavailable |
| Pre-click observation | Complete Delete match count was `0` before the Add Element click: yes / no / unavailable |
| Freshness | The pre-click zero observation was not reused as current after mutation: yes / no / unavailable |
| Post-click observation | A fresh complete observation reported at least one Delete button: yes / no / unavailable |
| Trace strategy records | Trace v4 preserves successful ordered verification strategies: yes / no / unavailable |
| Compiler derivation | Compiler v3 derived absence/presence predicates from successful strategies: yes / no / unavailable |
| v8 semantics | Delete absence is count `== 0`; post-click Delete presence is count `>= 1`: yes / no / unavailable |

### Language-boundary proof (mandatory)

The compiler/runner language boundary cannot be established merely from
successful task behavior or a stakeholder result. Use the reviewed source
revision and the completed offline isolation tests/review for this release
candidate. Record the code revision/build identifier and the test/review
references used to establish that the structured route does not call
`authoredIdentity`, `authoredActionIdentityV3`,
`parseAuthoredRoleNameIdentity`, `formFor`, the phrase-specific Add/Remove
workaround, or an equivalent action-`sourceText` identity parser. The reviewed
v5/v4/compiler-v3/v8 path must use structured identity and fresh semantic
correspondence only; v8 replay must not parse prose or invoke LLM/MCP.

The offline regression references include the compiler-isolation and
source-wording checks in `tests/structured-action-identity-wp2.spec.ts`
(`new compiler route has no authored-language identity parser`, `compiler v3
action identity is independent of equivalent authored phrasing`), the runner
checks in `tests/structured-action-identity-wp4a.spec.ts` (`v8 execution
modules have no authored-identity phrase parser or model/MCP dependency`, `v8
action identity is independent of equivalent authored wording`), and the
production no-fallback/replay-boundary checks in
`tests/structured-action-identity-wp4b.spec.ts`. Confirm these reviewed tests
belong to the recorded build revision; do not infer per-run code execution from
the browser result.

Do not inspect raw model/provider output, chain-of-thought, private witnesses,
restricted diagnostics, locators, or unrestricted trace/compiler artifacts.
If the approved revision or isolation evidence cannot be confirmed, keep the
release gate pending.

| Language-boundary evidence | Operator record |
|---|---|
| Source revision/build identifier | ______ |
| Reviewed parser-isolation test/review reference | ______ |
| Structured compiler route avoids historical phrase parsers | yes / no / unavailable |
| V8 replay uses no LLM/MCP and no authored-language parsing | yes / no / unavailable |
| Replay 1 and replay 2 are separate from exploration, compiler, and each other | yes / no / unavailable |

## Failure recording

For any non-passing run, record the exact public stage/status and public reason
code shown by the safe result, correlated IDs that exist at that stage, and
cleanup state. Include a private reason only when a reviewed operator surface
explicitly permits it; never copy `REDACTED_REASON` contents from private logs
or raw artifacts.

| Field | Operator record |
|---|---|
| Stopped stage/status | ______ |
| Public reason code | ______ |
| TestSpec / attempt / trace / compiler / resolved / replay IDs available | ______ |
| Cleanup | verified / unverified / not_started |
| Safe notes | ______ |

Interpretation ambiguity means no exploration; binding or exploration stops
remain non-QA; compilation failure/unsupported means no replay; replay
automation/environment failure remains non-QA; disagreement is a
reproducibility stop. No stop may be relabeled as QA failure. A QA failure is
valid only after both fresh v8 runs complete evaluation, both evaluate false,
and reproducibility is agreed.

## Release criteria

Close the primary proof as **pass** only when all conditions hold:

- The trusted selection is `structured-action-v1` from launch through result.
- Interpretation creates TestSpec v5 structured action intents and preserves
  the Delete absence request as a VerificationGoal.
- Protected M7 completes exploration; each authored target action has a
  runtime-created matching witness, while prerequisites remain distinct.
- Trace v4 is accepted with ordered action identity proofs and successful
  trusted verification strategies, including complete pre-click Delete count
  zero and fresh post-click positive count.
- Fresh compiler attempt v3 accepts and emits linked ResolvedTestSpec v8 using
  structured identity, with the expected Delete count predicates.
- The mandatory language-boundary proof is recorded for the same source
  revision/build.
- Two distinct fresh v8 replay contexts complete under the same approved
  profile/fingerprint; neither uses exploration/compiler state or the other
  replay, and neither invokes LLM/MCP.
- The outcomes agree; only then may ResultRecordV2 report
  `QA_ASSERTION_PASSED` at stage `qa`.
- Versioned provenance links validate from TestSpec through trace, compiler,
  v8, both replays, and ResultRecordV2.
- Safe projection is available and contains no private witness/strategy data.
- Cleanup is verified and no protected browser container remains after normal
  shutdown.
- No older-version or phrase-based fallback occurred.

If a required fact is unavailable, leave the gate pending. Any failure is
recorded at its actual stage and remains non-QA unless it is two agreeing
completed false predicate evaluations. Do not claim release from the automated
gate alone.

## Optional paraphrase robustness proof

After the primary proof passes, a separate run may use the semantically
equivalent action wording `Open Add/Remove Elements from the page.` Keep the
same approved target and workflow. Record its own complete artifact chain and
fresh replay agreement. Confirm interpretation may produce a role-unspecified
intent under contract while binding/compiler/replay still use only structured
identity. This is desirable robustness evidence, but it is not required to
close the primary release gate unless repository release policy changes.

## Operator closeout

| Closeout field | Record |
|---|---|
| Operator / date / timezone | ______ |
| Approved target | `https://the-internet.herokuapp.com/` |
| Workflow and versions | ______ |
| Terminal stage/status | ______ |
| Reproducibility | ______ |
| ResultRecordV2 QA status | ______ |
| Profile/fingerprint recorded | yes / no |
| Language-boundary proof recorded | yes / no |
| Cleanup verified / container listing empty | yes / no |
| Safe evidence chain complete | yes / no |
| Decision | pass / pending / failed |
| Safe stage-specific notes | ______ |

Never include credentials, raw provider/model output, chain-of-thought, private
ActionIdentityWitness or observation payloads, screenshots, page content,
locators, restricted diagnostics, trusted configuration, or unrestricted
artifacts in the closeout.
