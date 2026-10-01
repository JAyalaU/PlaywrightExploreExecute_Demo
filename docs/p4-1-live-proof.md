# P4-1C live-event release proof

Status: **P4-1 complete**. The credential-free protected-browser proof and the
separate human-operated real-provider Streamlit proof both passed. The operator
holds the provider credential; this repository stores only sanitized event
kinds/codes, correlation IDs, final typed status, and cleanup result.

## Credential-free protected-browser check

Run from PowerShell 7 in the repository after Docker Desktop is available. The
test uses the exact operator-approved admission-v1 profile and policy in the
supplied trusted config for the Challenging DOM target. It retains the profile,
policy, approval, and fingerprint exactly while redirecting only the artifact
root into a disposable temporary directory. It uses the test-only deterministic
Node model harness, removes `OPENAI_API_KEY` from the child environment, runs
the actual Streamlit app, Node event channel, isolated browser, Python
validator, and report projection, then checks that no `public-browser-g1-*`
container is left behind.

```powershell
$env:PUBLIC_BROWSER_P4_1_RUNTIME = '1'
$env:PUBLIC_BROWSER_P4_1_CONFIG = '<path to the operator-approved trusted-config.json>'
try {
  npm.cmd run test:p4-1c
} finally {
  Remove-Item Env:PUBLIC_BROWSER_P4_1_RUNTIME -ErrorAction SilentlyContinue
  Remove-Item Env:PUBLIC_BROWSER_P4_1_CONFIG -ErrorAction SilentlyContinue
}
```

Expected result: all credential-free tests pass, including the protected UI
path; the test prints one `P4_1_SAFE_EVIDENCE` JSON line containing profile
reference/fingerprint, correlation IDs, event kinds/count, typed terminal
status, report projection availability, and a boolean residual-container
result. It contains no page content, raw task, provider output, artifact paths,
or credential.

**Observed operator run, 2026-09-23:** `npm.cmd run test:p4-1c` built the Node
project, passed 7 Node tests and 17 Python tests with no skipped test, and
exited successfully. The exact approved profile was
`admitted-public-9d69d0992851e3253020d15f26a8ee530d6d6d551616366f0285f3be33e780e0@1`
with fingerprint
`c5818a77c85f9ed9f4326c468aec682b80b0066effeec37571fe085136b22759`.
Its safe evidence reported TestSpec
`local-a501a861-1fe7-4577-b1b5-f863368f7693`, exploration attempt
`explore-3196fdaf-600f-404c-9b48-5cb9874b71f7`, resolved spec
`resolved-e88a3d26-f774-477d-8217-ab56291d758a`, two distinct execution
runs, 25 ordered events with no older event omitted, terminal
`QA_ASSERTION_PASSED`, an available report projection, and
`residualContainers: false`. The event kinds covered interpretation, MCP
calls, locator assessments, resolved-spec readiness, both replays, report
completion, and terminal. This closes the credential-free protected-browser
portion only.

## Human-operated real-provider UI proof

Use the existing operator-approved trusted configuration for
`https://the-internet.herokuapp.com/challenging_dom`; do not put approval or
policy data in the UI form. In PowerShell, set the trusted configuration path
and hold the key only in the local environment for the UI process:

```powershell
$env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG = '<path to the operator-approved trusted-config.json>'
$secureKey = Read-Host 'OpenAI API key' -AsSecureString
$env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
try {
  uv run playwright-demo-ui
} finally {
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG -ErrorAction SilentlyContinue
  $secureKey.Dispose()
  Remove-Variable secureKey -ErrorAction SilentlyContinue
}
```

Open only `http://127.0.0.1:8501`. Enter:

- URL: `https://the-internet.herokuapp.com/challenging_dom`
- Task: `Go to https://the-internet.herokuapp.com/challenging_dom. In the table row containing Iuvaret1, select the edit link. Confirm that the URL is exactly https://the-internet.herokuapp.com/challenging_dom#edit.`

The timeline should show ordered, validated events for workflow and
interpretation, exploration, approved MCP tool names/outcomes, locator
assessment, resolved-spec readiness, both replay ordinals, report completion,
and a terminal preview matching the final typed result. The UI should report
`QA_ASSERTION_PASSED` and a safe report projection. No provider text, model
reasoning, raw MCP payload, page snapshot/text, URL query, artifact path, or
secret should appear in timeline events. The final v1 typed result and report
projection remain authoritative.

Return only sanitized evidence: profile reference/fingerprint, TestSpec,
exploration/resolved-spec IDs, two execution-run IDs, the ordered event kinds
and any reviewed status/reason/locator-quality codes, terminal QA status,
report projection availability, whether the timeline was truncated or
unavailable, and the post-run residual-container check. Do not return the key,
raw provider response, page content, unrestricted logs, or artifact contents.

The human-run real-provider path is required in addition to the credential-free
protected-browser path. A skip, injected-model result, or credential-free
protected-browser pass alone is not a substitute.

The operator separately reported `QA result: QA_ASSERTION_PASSED` from a
real-provider UI run, followed by an empty residual-container query. The safe
report projection they supplied shows `capture_disabled`, ten redacted evidence
descriptors, and `QA_ASSERTION_PASSED` in two distinct replay runs:
`run-6624e807-2e6f-493b-9295-05f288a237f0` and
`run-85f1c932-2be1-48a6-aaad-af128a766d03`. Its exploration attempt is
`explore-b6cf8e31-6fbe-48a6-a1a9-ba5090895a6c`. Correlated Node-owned
stored metadata identifies TestSpec
`local-8203cb02-133f-4e9d-aeac-4026f92bff5e`, resolved spec
`resolved-278b9ce2-d442-4876-9be5-292e03506474`, and the same approved
profile fingerprint recorded above. These facts verify the final result and
report correlation.

The operator also supplied the separate live UI timeline for that run. It
progressed in order through `workflow_started`, interpretation start/accepted
finish, exploration start, paired approved MCP navigation/snapshot calls,
step-decision start/finish, paired `browser_generate_locator` calls, a rejected
`mcp_generated` locator with `UNSUPPORTED_GRAMMAR`, an accepted
`semantic_row_scope` locator, paired `browser_click` and snapshot calls,
`resolved_spec_ready`, two `replay_started`/`replay_finished` pairs each ending
`QA_ASSERTION_PASSED`, `report_completed` with `available`, and `terminal` with
`QA_ASSERTION_PASSED`. No timeline-unavailable, inconsistent, or truncation
marker was reported. The terminal agrees with the final typed QA result and
correlated safe report. This satisfies the real-provider live-event proof; no
provider response, page text, raw MCP payload, credential, or unrestricted
artifact is recorded here.
