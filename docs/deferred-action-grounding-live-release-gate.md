# Deferred Action Grounding real-provider/public-target release gate

## Purpose and status

This runbook prepares one operator-controlled real-provider proof for the trusted `deferred-action-v1` route. It does not enable or change the workflow default. The route remains explicitly selected at trusted process launch and still requires its existing `offline-review` gate value. That value is an implementation gate; it is **not** public-target approval, provider authorization, or evidence that the live gate passed.

The native owned-option selected-state VerificationGoal capability is implemented for the deferred route. It supports an authored option label as the subject, proves complete eligible-control uniqueness and native option ownership, and reads `HTMLOptionElement.selected`; it does not use `aria-selected`, model-supplied DOM values, or prior action success as verification truth. The exact three-step source has test-only mocked-provider/protected-loopback coverage through two agreeing true replays. No public-target provider run has been performed as part of preparing this procedure. Keep the live proof pending until a separately authorized operator runs it against an exact approved public profile and reviews the restricted artifacts and safe result.

Native selected-state verification is a separate read-only VerificationGoal strategy. It establishes the entire eligible choice-control domain before matching the authored option label, proves the option belongs to the unique native control, freshly maps the label to a runtime value, and reads the native `selected` property. Compiler v4 pins its fresh mapping in assertion v2; each runner-v9 replay remaps and requires the same value before evaluating the native selected boolean. The assertion is true only when the existing owned option's selected state matches the authored polarity. Missing/duplicate options, zero/multiple eligible controls, mapping or owner drift, stale/incomplete evidence, or any other uncertainty remains a non-QA stop. Preserve the exact three-step task below and inspect the restricted trace/compiler/replay records; a terminal alone does not prove that the exact authored verification was evaluated.

## Exact primary task

Use this exact public start URL and these three authored steps, preserving punctuation and order:

1. `Go to https://the-internet.herokuapp.com/dropdown.`
2. `Select Option 1.`
3. `Verify that Option 1 is selected.`

This task tests native choice and an authored verification, without generic button/link activation. It must remain the same through both extractions, semantic admission, grounding, trace, compiler, and replays. Do not shorten, paraphrase, append a control name, or replace its verification if the exact source stops.

## Approval and isolation preconditions

Use the existing P3-A public URL admission process and the exact approved headless profile. Approval binds one canonical URL, hostname, default port, complete DNS pin set, profile, policy, and effective-profile fingerprint. The Streamlit URL field does not confer authority. If an existing approval does not name the exact canonical URL `https://the-internet.herokuapp.com/dropdown` as its approved start URL, do not use it for this proof. Inspect the URL and create a **new** approval/configuration through the documented interactive approval flow. Never edit pins or profile content under an existing identity; DNS drift or an unapproved redirect/host is a stop requiring fresh operator review.

A read-only lookup was performed against each existing `public*.json` config in the local `config/` directory for the exact primary URL. All returned `denied`; none is an authority for this task. No approval or config was created during preparation. The operator needs separate authorization for the exact public target, then must complete the fresh inspection/approval steps below.

From PowerShell 7 at the repository root, build the reviewed tree, then inspect and approve the exact URL into a new local job directory. Keep the generated config, inspection, and artifact directory private and out of Git or stakeholder reports.

```powershell
npm.cmd run build

$targetUrl = 'https://the-internet.herokuapp.com/dropdown'
$jobRoot = Join-Path $PWD ("jobs\deferred-live-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + "-" + [guid]::NewGuid().ToString('N'))
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

Review the displayed canonical URL, port, and every resolved address. The approval command performs a second inspection and requires typing the complete canonical URL. It creates the target config exclusively and fails if DNS changed. Do not use the test-only `PUBLIC_BROWSER_P3F_*` sentinel as a provider credential. Before any provider call, run the exact approved-profile/isolation proof described in [the operator guide](phase-3-operator-guide.md#verify-the-exact-profile-before-a-live-run); it is a separate protected-browser precondition, not this live task or proof of model quality. Stop if the profile proof has a failure or skip.

The browser remains inside the existing disposable protected container and proxy-only egress boundary. The provider key belongs only in the local host process environment through the secure prompt; it must not enter the task, URL, configuration, browser container, protocol payload, diagnostics, or evidence form. Do not enable headed viewing, direct egress, extra hosts, or a broader network policy for this gate.

## Trusted launch and submission

After the approval and profile precondition are reviewed, use the guarded loopback launcher only. In a fresh PowerShell terminal at the repository root, enter the full path of the exact approved config and set the two explicit launch-side workflow values. They must not be supplied by the task, form, request JSON, or model. The `offline-review` value opens the already-reviewed code path only; the approved config remains the separate public-target authority.

```powershell
$approvedConfigPath = Read-Host 'Full path to approved trusted config'
$trustedConfig = (Resolve-Path -LiteralPath $approvedConfigPath).Path
$secureKey = Read-Host 'OpenAI API key' -AsSecureString
try {
  $env:OPENAI_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
  if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) {
    throw 'OpenAI API key is empty.'
  }
  $env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG = $trustedConfig
  $env:PLAYWRIGHT_DEMO_WORKFLOW_VERSION = 'deferred-action-v1'
  $env:PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE = 'offline-review'
  uv run playwright-demo-ui
} finally {
  Remove-Item Env:OPENAI_API_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:PLAYWRIGHT_DEMO_TRUSTED_CONFIG -ErrorAction SilentlyContinue
  Remove-Item Env:PLAYWRIGHT_DEMO_WORKFLOW_VERSION -ErrorAction SilentlyContinue
  Remove-Item Env:PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE -ErrorAction SilentlyContinue
  $secureKey.Dispose()
  Remove-Variable secureKey -ErrorAction SilentlyContinue
}
```

The guarded launcher binds Streamlit to `127.0.0.1`; use `uv run playwright-demo-ui`, not direct `streamlit run`. Confirm the UI identifies the trusted route as `deferred-action-v1`. Submit the exact URL and task above once. Do not submit concurrently or change task text after a stop. Capture the bounded UI terminal and safe deferred projection. The UI does not expose private trace, guard, mapping, source argument, option value, assertion actual/expected, or protected evidence.

## Stage-by-stage closeout rules

The live proof passes only if the full trusted chain succeeds:

`ActionGoal v2 primary extraction + independent source-first extraction → trusted semantic admission → total endorsed obligation mapping → protected WP2 grounding and execution → successful ActionGrounding witness → authenticated trace v5 (including native VerificationGoal strategy v2) → fresh compiler v4 / accepted resolved v9 (including native selected-state assertion v2) → two distinct fresh runner-v9 contexts → authenticated replay pair and re-derived ResultRecordV2 → bounded safe projection.`

The operator should inspect restricted local records only through their authenticated stores/readbacks. Verify that the primary and source-first extractors received the permitted inputs, agreed on all source accounting and obligations, and that no model-supplied approval flag was used. Grounding must prove a complete all-frame candidate set with exactly one eligible native dropdown; `Option 1` stays the authored choice argument, there is no authored control name, and the executable value is derived by trusted option ownership/mapping. Two eligible controls must stop `NON_UNIQUE` before mutation, trace completion, compilation, replay, or QA. The successful witness must include fresh post-action proof.

The fresh compiler must reconstruct the entire admitted predicate with its own fresh protected context and produce authenticated compiler-v4/resolved-v9 authority. It may use the reviewed fresh grounding runtime; the WP5A compiler implementation includes an MCP-backed protected observation session. Do not describe the compiler as MCP-free. The two runner-v9 replays are the model-free/MCP-free phase: each must consume the same authenticated resolved-v9 readback in a distinct new protected browser session, independently re-establish the complete guard, execute deterministically, and produce the same completed deterministic assertion observation. No LLM/MCP, exploration refs, compiler-session refs, discovery, repair, or older route may supply replay authority.

For this task, close as `QA_ASSERTION_PASSED` only after both replays complete, cleanup is verified, both exact corresponding observations are true and agree, authenticated replay persistence succeeds, and result re-derivation plus safe projection validate. Two agreeing false observations are `QA_ASSERTION_FAILED`, not a successful release proof. Different assertion shape/actual/evaluation is a reproducibility non-QA stop. Assertion-free reproducible execution is explicitly non-QA and cannot close this task because this primary task includes a verification step. Any unsupported/unresolved verification, grounding/compiler/runner stop, provider failure, persistence failure, cancellation, or cleanup uncertainty remains at its stage as non-QA. Do not patch or retry a failure here and do not use a v5/v8 or historical fallback.

Before ending the UI process, allow its `finally` cleanup to clear the key and trusted launch variables. Stop the launcher with Ctrl+C. Confirm no protected browser container remains:

```powershell
docker ps -a --filter "name=public-browser-g1-" --format "{{.Names}} {{.Status}}"
```

An empty result is expected after verified cleanup. If the process was forcibly terminated or cleanup is uncertain, record that uncertainty and stop; do not claim QA success. Preserve restricted artifacts under the configured retention policy, and do not copy raw artifacts into a report.

## Restricted operator evidence form

Store this form beside the restricted job evidence, with access limited to the operator/reviewer. Populate identifiers and digests from authenticated records, never by trusting free-form log text. Do not paste private source/admission/trace/compiler/replay payloads, prompts, provider responses, browser facts, option values, locators, guard predicates, or assertion actual/expected values into this form. Record opaque IDs, versions, outcome enums, and pass/fail checks only.

```text
DEFERRED ACTION GROUNDING — RESTRICTED LIVE PROOF RECORD

Run record ID:
Operator / reviewer:
Date (UTC):
Outcome: NOT RUN / STOPPED NON-QA / QA_ASSERTION_PASSED / QA_ASSERTION_FAILED
Exact submitted target URL: https://the-internet.herokuapp.com/dropdown
Exact task order/content verified before submission: YES / NO

Approved public authority
  Public URL admission version: 1
  Restricted local approval-config reference (do not share):
  Exact canonical start URL confirmed: YES / NO
  Approved profile id@version:
  Approved profile fingerprint:
  DNS/policy review completed: YES / NO
  Exact-profile protected isolation proof: PASS / FAIL / NOT RUN
  Browser cleanup evidence: VERIFIED / UNVERIFIED

Source and semantic admission
  TestSpec schema version: 6
  TestSpec source contract version: 2
  ActionGoal contract version: 2
  VerificationGoal version: 2
  TestSpec ID:
  Source digest:
  Primary extraction format: qa_deferred_action_interpretation_v9
  Independent source-first format: qa_deferred_action_source_first_v5
  Primary prompt version: action_v2_primary_p5
  Independent source-first prompt version: action_v2_source_first_p5
  Native verification decision format: agentic_native_option_verification_decision_v6
  Native verification decision version: 6
  Native observation / strategy / comparison / resolved assertion versions: 2 / 2 / 2 / 2
  Semantic admission version: 2
  Semantic admission digest:
  Admitted obligation digest / mapping digest:
  Extraction agreement and complete source accounting: PASS / FAIL

Grounding and trace
  Exploration attempt ID:
  Grounding runtime/evidence contract versions:
  Candidate result: UNIQUE / NON_UNIQUE / OTHER STOP
  Authored dropdown name present: NO / YES (unexpected)
  Authored choice argument preserved as Option 1: YES / NO
  Runtime-owned label-to-executable-value proof: PASS / FAIL / NOT REACHED
  Successful ActionGrounding witness version / opaque ID:
  Fresh post-action effect proof: PASS / FAIL / NOT REACHED
  Trace version / successful trace ID / digest:

Restricted authority review (YES / NO / NOT REACHED)
  Independent extraction received original source only (not primary output/browser state):
  Both extractions fully accounted for source and agreed on every material obligation:
  Total endorsed obligation-to-grounding correspondence:
  Target / argument / anchor ownership preserved exactly:
  Compiler independently reconstructed the full admitted predicate in a fresh context:
  Compiler re-proved current candidate uniqueness, frame, label association (if used), and owned option/value mapping:
  Compiler produced resolved v9 only after all required checks:
  Both replay sessions independently re-established the complete full-predicate guard before action:
  Both replay values were runtime-derived or exactly revalidated against the compiled argument:
  Verification strategy is deterministic and corresponds to the exact authored clause:
  Runner-v9 used no LLM, MCP, exploration refs, or compiler-session refs:
  No historical route/store/projector fallback:

Fresh compiler
  Compiler version: 4
  Compiler attempt ID:
  Compiler result: ACCEPTED / REJECTED / NOT REACHED
  Resolved schema version: 9
  Resolved spec ID:
  Same approved profile/fingerprint and fresh context: PASS / FAIL / NOT REACHED

Fresh replays and authenticated result
  Runner version: 9
  Replay 1 run ID / session ID:
  Replay 1: COMPLETED_TRUE / COMPLETED_FALSE / COMPLETED_EXECUTION / NON_QA_STOP / NOT RUN
  Replay 1 cleanup: VERIFIED / UNVERIFIED / NOT RUN
  Replay 2 run ID / session ID:
  Replay 2: COMPLETED_TRUE / COMPLETED_FALSE / COMPLETED_EXECUTION / NON_QA_STOP / NOT RUN
  Replay 2 cleanup: VERIFIED / UNVERIFIED / NOT RUN
  Replay contexts distinct and fresh: PASS / FAIL / NOT REACHED
  Deterministic verification strategy supported for exact authored clause: PASS / FAIL / UNSUPPORTED / UNRESOLVED
  Corresponding assertion observations agree: YES / NO / NOT APPLICABLE / NOT REACHED
  Reproducibility: AGREED / DISAGREED / NOT ESTABLISHED
  Authenticated orchestration/replay ID and digest:
  ResultRecordV2 workflow/version: deferred-action-v1 / 2
  Terminal stage/status/reason code:
  QA terminal: QA_ASSERTION_PASSED / QA_ASSERTION_FAILED / NONE
  Result and pair re-derived from authenticated persistence: PASS / FAIL / NOT REACHED

Safe projection
  Projection version: 2
  Projection kind: AVAILABLE / UNAVAILABLE
  Fresh-process restart readback: PASS / FAIL / NOT RUN
  Privacy inspection: PASS / FAIL
  No source/browser/trace/guard/mapping/assertion values in shared output: CONFIRMED / FAIL

Actual stop stage/category/code (copy only reviewed safe enums):
Restricted artifact-store references (IDs/paths only, no payload):
Reviewer notes / gate decision:
```

When the controller stops before a replay terminal, record its actual safe `deferredStage` (`interpretation`, `grounding`, `trace`, `compilation`, `environment`, or `cancellation`) and category/code. A stop must not be relabeled as QA failure. Any unresolved source interpretation, unsupported observation, ownership or mapping uncertainty, or later runtime/environment stop leaves this gate open; do not represent it as a successful closeout.

## Stakeholder-safe closeout form

Only copy reviewed fields visible in the safe UI projection or the external ResultRecordV2 envelope. Do not publish the restricted form above or attach local artifact directories.

```text
DEFERRED ACTION GROUNDING — SAFE LIVE GATE SUMMARY

Workflow: deferred-action-v1
Approved target: https://the-internet.herokuapp.com/dropdown
Terminal: NOT RUN / NON-QA STOP / QA_ASSERTION_PASSED / QA_ASSERTION_FAILED
Stage and safe reason code (if stopped):
Replay count and states:
Reproducibility: AGREED / DISAGREED / NOT ESTABLISHED
Cleanup: VERIFIED / UNVERIFIED
QA result: PASS / FAIL / NO QA VERDICT
Projection: AVAILABLE / UNAVAILABLE
Gate decision: OPEN / CLOSED
```

Do not add source or choice text beyond the approved task label, browser-derived values, assertion actual/expected values, provider diagnostics, trace/admission/compiler payloads, guard/mapping/locator data, screenshots, protected evidence, or credentials. If any unsupported field appears in an external projection, treat it as a gate violation and do not share it.

## Required outcomes for this procedure

| Case | Required handling |
|---|---|
| Exact one-dropdown task, all source obligations admitted, supported deterministic verification, both completed true observations agree, persistence/projection/cleanup valid | Candidate live proof passes; reviewer may close this gate after restricted evidence review. |
| Two eligible dropdowns | `NON_UNIQUE` at grounding before mutation/trace/compiler/replay/QA. |
| Country-constrained variation used in a later separate run | Country label association must be runtime-proven and remain linked through compiler/replays; no guessed name. It does not replace this primary task. |
| Native fill or checkbox/radio scenario | Existing supported smoke scenario only; not a substitute for this dropdown live proof. |
| Agreeing false assertions | Deterministic `QA_ASSERTION_FAILED`; report failure and keep release gate open. |
| Replay disagreement, any runner stop, cleanup uncertainty, compiler/grounding/provider/environment/persistence/cancellation stop | Stage-specific non-QA; preserve and report the actual stop; gate remains open. |
| Zero-assertion reproducible execution | `EXECUTION_REPRODUCED / NO_ASSERTIONS`, non-QA; cannot close this assertion-bearing proof. |
| Unexpected success with no authenticated supported verification strategy corresponding to the exact source | Gate violation; do not close or use it as release evidence. |

## Optional separate robustness follow-up

After the primary proof has been recorded, a reviewer may authorize a separate fresh run using the linguistic variation:

1. `Go to https://the-internet.herokuapp.com/dropdown.`
2. `Choose Option 2.`
3. `Confirm that Option 2 is selected.`

This is a separate semantic-variation evaluation, not a repair or replacement for the primary task. Use the same exact-target admission rules and a fresh run/artifact identity. Both source extractions must independently preserve and agree on the exact authored clauses and native selected-state claim; trusted admission must account for the complete source without phrase-specific validator behavior. Preserve it as an optional follow-up; do not combine its result or evidence with the primary release closeout. A paraphrase that stops or fails admission remains a stop for that separate run and does not change the primary task's result.

## Boundary references

- [WP5A integration and exact offline handoff](deferred-action-grounding-wp5a.md)
- [Independent offline release gate](deferred-action-grounding-offline-release-gate.md)
- [Public URL admission contract](p3-a-public-admission.md)
- [Local operator guide and exact profile-isolation proof](phase-3-operator-guide.md)
- [Deferred Action Grounding architecture](deferred-action-grounding-architecture.md)
- [ActionGoal semantic-fidelity addendum](action-goal-semantic-fidelity-architecture.md)

DEFERRED_ACTION_GROUNDING_LIVE_GATE_READY
