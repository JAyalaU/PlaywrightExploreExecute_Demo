# Phase 1 live LLM acceptance

## Completion handoff validation (2026-10-07)

**Classification:** `ADAPTIVE_PHASE1_LIVE_ACCEPTED`. This section supersedes the failed completion run recorded below. The controller now closes exploration when trusted evidence covers every authored goal and a demonstrated procedure validates. It does not ask the model for a terminal proposal after that point. The provider adapter, prompt, browser observations, gateway, action vocabulary, budgets, fixture, and original instruction were unchanged between the two attempts.

The connected opt-in test used OpenAI Responses with `gpt-6.1-sol`, JSON object output, schema-validated proposals, and the same instruction for both variants: “Open account settings, enable email notifications, and verify they are enabled.” The trusted limits remained 8 model turns, 8 actions, 12 observations, 0 screenshots, 30 seconds, and 2 ineffective actions. Each variant had one fresh connected attempt against its local loopback fixture. No public site, Docker, or model retry was used.

### Variant A — direct settings link

| Turn | Page context presented to model | Typed proposal and gateway result | Browser result and new observation |
|---|---|---|---|
| 1 | `/`; `od18ec05…`; visible `link Account settings`; goals `g0,g1,g2` | `click` observed link for required action `g0`; accepted | URL changed to `/settings`; `o3d4d213…` exposed `checkbox Email notifications`, unchecked |
| 2 | `/settings`; `o3d4d213…`; checkbox unchecked; goals `g1,g2` | `check` observed checkbox for `g1`; accepted | Checkbox changed false → true; `oecb3302…` |
| 3 | `/settings`; `oecb3302…`; checkbox checked | `verify g1`, checked equals true; accepted | New observation `occb64aa…` satisfied the trusted outcome rule |
| 4 | `/settings`; `occb64aa…`; checkbox checked | `verify g2`, checked equals true; accepted | New observation `of18305c…` satisfied the authored assertion; controller completed without another model turn |

**Result:** 4 model calls; 2 exploration browser actions; a demonstrated two-step procedure (`click` role/name `link Account settings`, then `check` role/name `checkbox Email notifications`). The clean pass opened a fresh browser context, received verified application reset proof `fixture_reset`/`reset2`, re-resolved both semantic targets, performed 2 actions, and observed the expected transitions. After reload, the independent verifier marked `g0`, `g1`, and `g2` `verified_true`; cleanup succeeded; outcome `VERIFIED_PASS`.

### Variant B — profile menu

| Turn | Page context presented to model | Typed proposal and gateway result | Browser result and new observation |
|---|---|---|---|
| 1 | `/`; `o2e6ab0c…`; visible `button Profile`; goals `g0,g1,g2` | `click` observed Profile button for `g0`; accepted | `link Settings` appeared in `od48f6d0…` |
| 2 | `/`; `od48f6d0…`; visible Profile and newly exposed Settings | `click` observed Settings link for `g0`; accepted | URL changed to `/settings`; `oe17cd47…` exposed `checkbox Email notifications`, unchecked |
| 3 | `/settings`; `oe17cd47…`; checkbox unchecked | `check` observed checkbox for `g1`; accepted | Checkbox changed false → true; `o3366bb2…` |
| 4 | `/settings`; `o3366bb2…`; checkbox checked | `verify g1`, checked equals true; accepted | `ob437712…` satisfied the trusted outcome rule |
| 5 | `/settings`; `ob437712…`; checkbox checked | `verify g2`, checked equals true; accepted | `o00fa936…` satisfied the authored assertion; controller completed without another model turn |

**Result:** 5 model calls; 3 exploration browser actions; a demonstrated three-step procedure (`click` role/name `button Profile`, `click` role/name `link Settings`, `check` role/name `checkbox Email notifications`). Fresh browser context and server-side reset were verified as in A. The clean pass re-resolved all three targets without exploration-session refs, performed 3 actions, observed the expected transitions, and reloaded. The independent verifier marked `g0`, `g1`, and `g2` `verified_true`; cleanup succeeded; outcome `VERIFIED_PASS`.

The first action differs because the first observations differ. In B, the model could not choose Settings until the post-Profile observation exposed it; the checkbox action in both variants followed observation of the settings page. The procedures retain semantic role/name targets and observed transitions, not live element refs or invented alternatives. These connected runs provide direct evidence of observation-dependent model proposals and a successful clean-pass handoff on the two accessible fixture variants.

### Controller correction and validation

Previously `unresolvedGoals()` became empty after the two successful verification proposals, but `explored` changed only on a separate model `finish_exploration` proposal. Further identical verifies neither advanced coverage nor counted as ineffective, so the eighth model turn expired. Now the controller evaluates trusted goal rules against current observations and demonstrated action evidence, requires a successful typed check for outcome/assertion goals, checks unresolved authored questions, and validates a demonstrated `LearnedProcedureV1` before handoff. It checks before each model call and after the final budgeted turn. A model completion proposal remains subject to the same predicate. Verification results record whether they added information; repeated equivalent checks with no new evidence stop at `REPEATED_INEFFECTIVE_VERIFICATION`. Empty model-facing remaining goals alone do not establish completion, and exploration completion never grants `VERIFIED_PASS`.

Before these live attempts: focused adaptive tests **22 passed, 1 live test skipped**; `npm test` **185 TypeScript passed, 1 live test skipped, 32 Python passed**; typecheck, build, and `git diff --check` passed. The single connected opt-in live test containing both fresh variants **passed**. The test matrix includes terminal handoff at the exact turn budget, false and repeated verification, missing authored-action evidence despite a true final checkbox, clean-pass failure, and independent verification after reload.

Scope remains the accessible local fixture and deterministic role/name clean re-resolution. A general trusted acceptance-rule intake and evidence-backed clean-pass UI adaptation remain future work. The current required-action rule checks an observed action of the right kind plus the final URL; causal attribution across multi-step navigation merits a tighter check before broader tasks. In this connected B trace, both the Profile and Settings clicks were explicitly attributed to the authored `g0` action. During a configuration audit, a tool-output search inadvertently displayed a local credential value in the tool transcript. The value was not copied into this report or any test artifact; rotate that credential. No production route was changed.

## Earlier failed completion run (superseded)

**Date:** 2026-10-07  
**Classification:** `ADAPTIVE_PHASE1_LIVE_FAILED`

## Configuration and scope

The opt-in test `opt-in live OpenAI model explores both local fixture variants` ran against protected local Chromium and loopback fixtures only. The Node process loaded `ADAPTIVE_LIVE_SMOKE=1`, `ADAPTIVE_LIVE_MODEL=gpt-6.1-sol`, and a nonempty `OPENAI_API_KEY`; no credential value was printed or retained. Both variants used the same authored instruction, `Open account settings, enable email notifications, and verify they are enabled.`, the same OpenAI Responses adapter and prompt, controller, gateway, and trusted limits. Only the fixture presentation changed. The adapter used `text.format.type=json_object`, `store=false`, a 20-second call timeout, and zero SDK retries. The fixed input message now requests a JSON object while retaining the authored goals and bounded observation. Each proposal was parsed with `AgentProposalV1Schema` before downstream use.

Trusted limits: 8 model turns, 8 browser actions, 12 observations, 0 screenshots, 30 seconds, and 2 consecutive ineffective actions. A server-side fixture reset preceded each exploration attempt. This run used one fresh real-model attempt per variant; no prompt, controller, or gateway changes were made between them.

The first invocation inside the command sandbox captured both initial observations but failed with `Connection error` before provider output. It made no model-derived proposals or browser actions. An unsandboxed invocation was then required to allow provider connectivity. The behavioral evidence below comes solely from that invocation. The two fixture variants were each attempted once in that connected invocation, without retrying a model turn.

The adapter prompt at the start of this correction already contained explicit instructions and a JSON example for verifying outcome and assertion goals. Those instructions were not added during the JSON-mode fix, and the prompt remained identical between A and B. They differ from an earlier Phase-1 prompt baseline, so this run cannot establish acceptance under that earlier unchanged prompt. The repeated verification behavior must be interpreted in light of the prompt actually used here.

## Variant A: direct settings link

| Turn | Page context and observation | Model proposal | Gateway and action result | New observation |
|---|---|---|---|---|
| 1 | `/`, `o4b36663…`; visible `link Account settings`; goals `g0,g1,g2` | `click` observed `e0` for `g0` | Accepted; link click returned; URL changed to `/settings` | `oa62e115…`: `checkbox Email notifications`, unchecked |
| 2 | `/settings`, `oa62e115…`; checkbox unchecked; goals `g1,g2` | `check` observed `e0` for `g1` | Accepted; check returned; checkbox changed from false to true | `o89df470…`: checkbox checked |
| 3 | `/settings`, `o89df470…`; checkbox checked; goals `g1,g2` | `verify g1`: checkbox checked equals true | Accepted as a verification observation; no browser action | `o6e1dc97…`; goal `g2` remained |
| 4 | `/settings`, `o6e1dc97…`; checkbox checked; goal `g2` | `verify g2`: checkbox checked equals true | Accepted as a verification observation; no browser action | `o04416e0…`; no unresolved goals |
| 5 | `/settings`, `o04416e0…`; checkbox checked; no unresolved goals | `verify g1`: checkbox checked equals true | Verification observation returned; no browser action | `o79f347d…`; no unresolved goals |
| 6 | `/settings`, `o79f347d…`; checkbox checked; no unresolved goals | `verify g2`: checkbox checked equals true | Verification observation returned; no browser action | `o70445db0…`; no unresolved goals |
| 7 | `/settings`, `o70445db0…`; checkbox checked; no unresolved goals | `verify g1`: checkbox checked equals true | Verification observation returned; no browser action | `o5ab86e1…`; no unresolved goals |
| 8 | `/settings`, `o5ab86e1…`; checkbox checked; no unresolved goals | `verify g2`: checkbox checked equals true | Verification observation returned; no browser action | Turn budget exhausted; no completion proposal |

The real model made **8 calls** and the gateway dispatched **2 browser actions**. The first click was supported by the initial link; the next check used the newly observed `/settings` checkbox. Exploration stopped at `MODEL_TURN_BUDGET_EXCEEDED` with controller outcome `BLOCKED`. No learned procedure was issued. Clean reset and execution were not reached; independent requirement coverage remained inconclusive. Cleanup succeeded.

## Variant B: profile menu

| Turn | Page context and observation | Model proposal | Gateway and action result | New observation |
|---|---|---|---|---|
| 1 | `/`, `o13f5a5d…`; visible `button Profile`; goals `g0,g1,g2` | `click` observed `e0` for `g0` | Accepted; button click returned; `link Settings` appeared | `o3f2fffd…`: Profile button and Settings link |
| 2 | `/`, `o3f2fffd…`; newly visible Settings link; goals `g1,g2` | `click` observed `e1` for `g1` | Accepted; link click returned; URL changed to `/settings` | `ofb3aa05…`: `checkbox Email notifications`, unchecked |
| 3 | `/settings`, `ofb3aa05…`; checkbox unchecked; goals `g1,g2` | `check` observed `e0` for `g1` | Accepted; check returned; checkbox changed from false to true | `o9ce32c8…`: checkbox checked |
| 4 | `/settings`, `o9ce32c8…`; checkbox checked; goals `g1,g2` | `verify g1`: checkbox checked equals true | Verification observation returned; no browser action | `o2a14777…`; goal `g2` remained |
| 5 | `/settings`, `o2a14777…`; checkbox checked; goal `g2` | `verify g2`: checkbox checked equals true | Verification observation returned; no browser action | `of57ba09…`; no unresolved goals |
| 6 | `/settings`, `of57ba09…`; checkbox checked; no unresolved goals | `verify g1`: checkbox checked equals true | Verification observation returned; no browser action | `oaac9d5e…`; no unresolved goals |
| 7 | `/settings`, `oaac9d5e…`; checkbox checked; no unresolved goals | `verify g1`: checkbox checked equals true | Verification observation returned; no browser action | `o7cf320d…`; no unresolved goals |
| 8 | `/settings`, `o7cf320d…`; checkbox checked; no unresolved goals | `verify g2`: checkbox checked equals true | Verification observation returned; no browser action | Turn budget exhausted; no completion proposal |

The real model made **8 calls** and the gateway dispatched **3 browser actions**. It did not repeat A's direct settings-link action: it clicked Profile based on the first observation, then chose the Settings link only after the next observation exposed it. The checkbox decision likewise followed observation of `/settings`. Exploration stopped at `MODEL_TURN_BUDGET_EXCEEDED` with controller outcome `BLOCKED`. No learned procedure was issued. Clean reset and execution were not reached; independent requirement coverage remained inconclusive. Cleanup succeeded.

## Assessment and next correction

The JSON-mode request defect is corrected: both connected requests yielded schema-valid proposals and the gateway dispatched only observed targets. The run demonstrates real observation-dependent navigation and a subsequent state-setting decision in both variants. It does **not** satisfy Phase-1 live acceptance, because neither exploration emitted `finish_exploration` after the authored outcome and assertion were verified. Without that terminal proposal, there was no demonstrated procedure, verified clean reset, clean pass, or independent clean-pass verdict. The controller did not convert the model's repeated verification or the observed checked state into success.

The first failing boundary in the connected run is **model exploration-completion proposal selection**, after valid action execution and verification observations. The smallest evidence-supported follow-up is to make the completion condition clear to the model when `unresolvedGoalIds` is empty, with a focused mocked request test and a separate, newly authorized live acceptance run. Do not infer clean-pass success from this exploratory checkbox state. Also review the goal attribution of Variant B's Settings click during that follow-up: it was proposed under `g1` although navigation to settings serves the authored `g0` action. No such changes were made during this acceptance run.

Offline validation before live execution: 19 adaptive tests passed (including the mocked Responses request success and malformed-output cases), `npm run typecheck` passed, `npm run build` passed, and `git diff --check` passed. The connected live test failed its verified-pass assertion as expected from the `BLOCKED` results.
