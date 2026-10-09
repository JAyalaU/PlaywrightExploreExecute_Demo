# Post-C2 product-surface inventory

## D2 update (2026-10-07)

D2 moved 95 retired root-level architecture, plan, gate, guide, and investigation documents plus the four-file `audit/` family into [the historical archive](../README.md). It moved 16 experiment reports into [experiment evidence](../../experiments/README.md). The chronological [investigation log](../runtime-investigation-log.md) was appended before archival. The only remaining root-level Markdown files are this inventory, the cleanup plan, the current-state staleness audit, and the Phase-C preflight snapshot; these are temporary D3 inputs, not a replacement architecture guide. `AGENTS.md` and root README now point to this inventory instead of mandating retired architecture. D3 will create the authoritative README, architecture, and runbook; D4 will finalize context guidance. The classifications below remain the pre-D2 snapshot and should be read with this relocation in mind.

## D1 update (2026-10-07)

The experiment inventory below is the **pre-D1 snapshot**. D1 moved seven current semantic `.mjs` files to [the opt-in experiment index](../../../tools/experiments/README.md), left the early MCP spike frozen at `spikes/playwright-mcp/`, and removed five superseded/public probe drivers while retaining their reports. Moving the spike's tracked `artifacts/` evidence would cause it to match the repository-wide ignore rule. `scripts/` now contains only the provider-denial test guard. The three removed `factory.browserBackend` references were replaced by native schema-5 profile checks in experiment code. Compiler/replay tools require explicit authenticated artifact paths; no historical frozen path is assumed. One provider-free grounding `freeze` attempt and one compiler fixture preparation/readback succeeded with D1/G1/R1, local-only responses and verified cleanup. No cohorts, provider calls, public-site requests, or Docker calls ran. The ordinary product graph and diagnostic classifications below did not change.

Phase D2 should move the linked experiment reports and historical docs, D3 should rewrite current product docs, and D4 should curate package/context guidance. Current package scripts were unchanged in D1.

Checked-out source audit, 2026-10-07. Read-only inspection of `app/`, `src/playwright_demo/`, `scripts/`, `tests/`, `package.json`, config, and Markdown. No provider, browser, Docker, public site, or experiment was run. Classifications describe **reachability from the current product entry**, not the age or name of a file. The existing worktree contains prior cleanup edits; this inventory does not use Git status as reachability evidence.

## Product graph and boundary proof

```text
ui_launcher.py / streamlit_app.py -> ui_shell.py -> ui_workflow.py
  -> public_admission.py -> profile/admission-cli.ts select (exact approved URL/ref/fingerprint)
  -> host.py -> subprocess/agentic-cli.ts -> agentic-entry.ts
  -> local/agentic-workflow.ts (single semantic route; direct Node approval check)
  -> local/semantic-general-workflow.ts
  -> semantic-intent-v3-boundary.ts -> primary provider + deterministic normalize/relation validation
     -> independent fidelity review -> trusted TestSpec v7 / source v3 admission
  -> profile/local-context.ts + exploration/mcp.ts + semantic-grounding-v1.ts
     -> issued in-memory grounded trace v1
  -> semantic-general-production-v1.ts -> fresh semantic-trace-compiler-v5.ts
  -> authenticated semantic-compiler-store-v5.ts (ResolvedTestSpec v10 readback)
  -> semantic-replay-v2.ts -> two fresh runner/semantic-v10.ts sessions
  -> authenticated semantic-replay-store-v2.ts (pair v2 readback)
  -> ResultRecordV2 / protocol-v2 / report-projection-v2
  -> Python protocol_v2.py / report_projection_v2.py -> Streamlit outcome
```

`agentic-workflow.ts` validates native config, exact target approval, profile reference and fingerprint before `semantic-general-workflow.ts` can open a browser. Its only approval bypass is an in-process `OFFLINE_SEMANTIC_FIXTURE_AUTHORITY` symbol plus injected fixture models; the production CLI does not import that harness. `product-contracts.ts` accepts absent or explicit `semantic-general-v1` workflow selection and rejects retired values. It rejects every nonempty `PLAYWRIGHT_DEMO_BROWSER_BACKEND` value. No second product workflow dispatch was found. The v2 result/protocol and semantic version literals are still required provenance, even though selection is singular.

`profile/local-context.ts` is the sole production browser factory: `ProtectedContextFactory.open()` checks Windows and launches bundled Playwright `chromium`, with a restricted environment and disposable context. `rg` across `app/` and Python found no other `chromium.launch`, Firefox/WebKit launch, CDP connect, container factory, or backend fallback. `exploration/mcp.ts` uses that protected session; MCP remains **PRODUCT**. The optional viewer uses only `observability/local-frame-channel.ts` and `live-images.ts` on Node, and `local_frame_viewer.py`, `local_frame_ui.py`, and `viewer_wire_common.py` on Python. Its private wire still says `deferredViewerVersion` (handshake 1; frame notice 2), but no executable RFB/noVNC transport remains. Negative migration tests and the test harness's Docker subprocess guard are not product paths.

## Module-family classification

| Family/files | Class | Current purpose or disposition |
|---|---|---|
| `app/domain/{semantic-intent-v3,semantic-grounding-v1,semantic-resolved-v10,semantic-runner-v10,shared-contracts}.ts` | `PRODUCT` | Source v3/TestSpec v7, grounding/trace/compiler/resolved v10, runner/pair schemas, shared URL/profile ref. |
| `app/domain/agentic-result-v2.ts` | `PRODUCT` | Semantic-only ResultRecordV2 validation and QA/non-QA terminal schema. Historical filename, not old route. |
| `app/domain/{semantic-exploration-diagnostics-v1,deferred-browser-diagnostics}.ts` | `PRODUCT_DIAGNOSTIC` | Closed exploration/browser/viewer diagnostic collection and safe URL/exception facts. `deferred` is historical; local frame and semantic workflow import it. |
| `app/interpretation/{semantic-intent-v3,semantic-intent-v3-adapters,semantic-intent-v3-boundary,semantic-intent-v3-relations,semantic-intent-v3-wire,semantic-primary-output-diagnostic-v1,openai-responses,model-failure}.ts` | `PRODUCT` | Provider transport, semantic extraction, deterministic normalization/canonicalization, fidelity, trusted admission and required invalid-output evidence. `provider-live-debug.ts` is optional private diagnostic support imported by Responses. |
| `app/interpretation/{semantic-general-production-v1,semantic-replay-v2}.ts` | `PRODUCT` | Compiler/store/replay composition and two-run agreement. `runSemanticGeneralizedOptInV1` is a historical API name on the sole product route. |
| `app/interpretation/semantic-grounding-fixture-preparation-v1.ts` | `EXPERIMENT` | Shared interpretation entry wrapper for stability fixture preparation; no ordinary workflow import. |
| `app/exploration/{mcp,semantic-grounding-v1,semantic-trace-compiler-v5}.ts`; `app/browser-action/committed-document-readiness.ts` | `PRODUCT` | Protected browser session, current candidate/receipt grounding, fresh compiler and document readiness. |
| `app/profile/{native-profile,native-admission,local-context,browser-environment,admission-cli}.ts` | `PRODUCT` | Strict schema 5/fingerprint, exact target approval, Windows Chromium, restricted environment and operator inspection/select/approval. No schema 3/4 or network-policy runtime. |
| `app/local/{agentic-workflow,semantic-general-workflow,product-contracts,project-env,workflow-error}.ts` | `PRODUCT` | One route, trusted config, environment loading and typed stops. `offline-fixture-authority.ts` is `TEST`. |
| `app/runner/{semantic-v10,demo-action-pacing}.ts` | `PRODUCT` | Deterministic runner and presentation pause. `semantic-v10-diagnostics.ts` is mixed: `classifyClickFailureV10` is used by the runner, while its collector/store are `PRODUCT_DIAGNOSTIC`; do not move the whole module without splitting it. |
| `app/evidence/{semantic-compiler-store-v5,semantic-replay-store-v2}.ts` | `PRODUCT` | Mandatory authenticated resolved-v10 and pair-v2 write/readback capabilities. |
| `app/evidence/{semantic-primary-output-diagnostics-v1,semantic-interpretation-diagnostics-v1,semantic-exploration-diagnostics-v1,semantic-compiler-diagnostics-v1}.ts` | `PRODUCT_DIAGNOSTIC` | Restricted private records described below. |
| `app/evidence/{admitted-semantic-test-spec-v7-store,semantic-grounded-trace-v1-store}.ts` | `EXPERIMENT` | Authenticated reproducibility/readback for frozen interpretation/grounding, imported by tests and experiment scripts, not the ordinary workflow. |
| `app/observability/{local-frame-channel,live-images}.ts` | `PRODUCT` | Optional authenticated local frame stream and bounded JPEG notices; observational. |
| `app/subprocess/{agentic-cli,agentic-entry,protocol-v2,read-request,shared-protocol,cancellation,report-projection-v2,report-projection-v2-cli}.ts` | `PRODUCT` | Bounded Node v2 process, cancellation, terminal and safe projection. `semantic-general-test-harness.ts` is `TEST` and explicitly outside production CLI imports. |
| Python `src/playwright_demo/*.py` | `PRODUCT`, except diagnostics support | UI/host/admission/v2 validation and local frame view. `ui_workflow.py`, `ui_shell.py`, `host.py` still use `deferred_viewer` aliases and `_agentic_result`; these are current local-frame/result behavior. `PLAYWRIGHT_DEMO_UI_DIAGNOSTICS` paths are `PRODUCT_DIAGNOSTIC`. |
| `app/index.ts` | `STALE_ORPHAN` | Empty milestone placeholder (`export {}`), no product API. Confirm package/export intent before deletion. |

No additional product workflow or browser module was demonstrated. `app/{domain,evidence,exploration,interpretation,local,profile,runner,subprocess}/index.ts` barrels expose current contracts only; `app/README.md`, `app/evidence/README.md`, and `app/profile/README.md` are historical text despite their location beside product source.

### Names that need care

| File/symbol | Live importer and meaning | Rename candidate? |
|---|---|---|
| `agentic-{cli,entry,workflow}.ts`, `agentic-result-v2.ts`, Python `_agentic_result` | CLI/host/current semantic v2 result. | **Yes**, targeted Phase D rename with import/wire checks; preserve version literals. |
| `deferred-browser-diagnostics.ts`; Python `deferred_viewer` aliases | Semantic exploration and local frame viewer diagnostics. | **Yes**, after preserving diagnostic schemas and frame wire. |
| `deferredViewerVersion`/`PLAYWRIGHT_DEMO_DEFERRED_VIEWER_*` | Current private frame-v2 wire between Python host and Node. | **Decision**, since a wire rename requires both sides to migrate together. Not stale by substring. |
| `semantic-intent-v3.ts` | Current source-contract v3 and TestSpec **v7** implementation. | **No urgent rename**; document both versions. |
| `semantic-general-production-v1.ts` / `runSemanticGeneralizedOptInV1` | Current compiler/replay composition. | **Yes**, API name says opt-in although route is sole product; low priority. |
| `public_admission.py` `lookup_public_admission` legacy wording | Current native CLI `select` caller. | **Yes**, small local naming cleanup only after docs. |

## Persistence and diagnostics

The admitted-v7 store and grounded-trace-v1 store are `EXPERIMENT`: source search found no import in `semantic-general-workflow.ts` or its production composition. Stability fixture preparation and frozen trace/replay tools consume them. The ordinary product issues an in-memory trace capability, then **must** persist/read back Resolved v10 and replay pair v2 before claiming QA.

| Collector/store | Ordinary success write | Failure write | Awaited / failure effect | QA authority |
|---|---|---|---|---|
| Primary-output diagnostic (`semantic-intent-v3-boundary.ts`) | No | `PROVIDER_OUTPUT_INVALID` only | **Awaited write and authenticated readback; failure changes outcome to non-QA environment stop** (`SemanticPrimaryDiagnosticPersistenceFailureV1`). | No |
| Normalization/interpretation diagnostic (`semantic-general-workflow.ts`) | No | Invalid source representation with diagnostic | Awaited inside `try/catch`; write failure ignored. | No |
| Exploration diagnostic + local viewer activity (`semantic-general-workflow.ts`) | Yes, after issued trace/cleanup | Yes, on exploration/viewer stop and cleanup | Awaited inside `try/catch`; write failure ignored. Viewer event collector is in-memory until this snapshot. | No |
| Compiler trace/rejection/seal diagnostic (`semantic-general-production-v1.ts`) | **Trace before compile; seal after accepted compile** | Rejection after failed compile | Trace/rejection writes are awaited **without catch and can stop workflow**; accepted-seal write is caught/ignored. This is a real operability/terminal coupling to revisit in E. | No |
| Runner-v10 diagnostic (`semantic-v10.ts`) | Yes when diagnostic root is supplied (the normal replay passes artifact root) | Yes for instrumented stop | Collector observations are guarded; store write awaited inside `try/catch` and ignored on error. | No |
| Provider live debug (`provider-live-debug.ts`) | Disabled by default | Opt-in private transport facts | Environment-gated; not a QA input. | No |
| Native viewer/host UI diagnostics | Viewer event snapshot on exploration persistence; optional host/UI diagnostic events | Viewer failures and host errors | Viewer preflight can cause a **non-QA** environment stop by design; diagnostic recording itself is guarded. | No |
| Resolved-v10 and replay-pair stores | **Yes, mandatory** | Not diagnostic stores | Authenticated write/readback is required to issue trusted replay/QA capability. Keep regardless of diagnostics mode. | **Yes, authority transfer** |

The high-value Phase E question is the awaited compiler diagnostic trace/rejection write and the required primary invalid-output record. A broad `DIAGNOSTICS=0` switch must not silently skip either until terminal/authority behavior is explicitly decided and tested.

## Tests, scripts, configuration, and package commands

**Tests.** `npm test` currently selects 18 TypeScript files through `test:fast`. Product regression: semantic public routing, native admission/boundary, intent, grounding, compiler, runner, pacing, readiness, provider transport, project environment. Diagnostic regression: primary/normalization/exploration/runner diagnostics and public-run-environment checks. Reproducibility `TEST`/`EXPERIMENT`: admitted-v7 and grounded-trace-v1 store suites; they are intentionally in the default suite today although their stores are not ordinary runtime. Local integration outside default: `subprocess-cancellation-p4-2`, `deferred-local-frame-viewer`, `deferred-local-frame-capture-timeout` and the five bounded Python modules in `test:current`. These are current behavior despite P4/deferred filenames. Negative old-workflow/Docker cases in routing/native tests protect fail-closed migration behavior; no checked-in test file solely executes a retired route was found. Review the two reproducibility store suites for a separate opt-in test group in D4, without dropping required authority-store coverage.

**Scripts.** Product/operator: `admit:public` CLI in package; `scripts/deny-openai-provider.cjs` is a test guard. Local product test is Playwright/Python through package scripts; `spikes/playwright-mcp/` is historical `EXPERIMENT`, not product. Active but opt-in experiments: `semantic-v7-{interpretation-stability-experiment,post-canonicalization-stability,final-stability}.mjs`; `semantic-grounding-v1-{stability-experiment,test-fixture-stability}.mjs` plus `semantic-grounding-v1-test-fixture-source.mjs`; `semantic-compiler-v5-stability-experiment.mjs`; `semantic-resolved-v10-replay-fixture-preparation.mjs`; `verify-semantic-resolved-v10-replay-fixture.mjs`. Public navigation, destination readiness and local-frame capture A/B scripts are historical protected-target spikes; archive or mark non-runnable rather than invoking during ordinary work.

**Confirmed script breakage, independent of static imports:** all literal `dist/*.js` import paths in `scripts/` resolve in this checkout, but `semantic-grounding-v1-test-fixture-stability.mjs`, `semantic-compiler-v5-stability-experiment.mjs`, and `semantic-resolved-v10-replay-fixture-preparation.mjs` still require `factory.browserBackend === 'local-windows'`. `ProtectedContextFactory` now has no `browserBackend` member, so each will stop at that guard if invoked. The last two also pin a prior trace file under `artifacts/semantic-grounding-v1-test-fixture-2026-10-07T00-28-52.867Z-59a84ae1-bfbe-4441-8c77-1d3a892e83ce/...`; that exact file is absent in the checkout. `verify-semantic-resolved-v10-replay-fixture.mjs` similarly depends on frozen artifact paths; verify its inputs before promising runnable status. These are `EXPERIMENT` failures, not product defects. Do not run them until their fixture inputs and factory guards are repaired in D1. One public-target script uses an experiment gate, but it is not a normal operator command.

**Product config.** Required for normal public run: `PLAYWRIGHT_DEMO_TRUSTED_CONFIG` (strict native schema-5 catalog, artifact root/retention, evidence policy and exact public-target approval) and `OPENAI_API_KEY` supplied to the provider. Optional product: `PLAYWRIGHT_DEMO_LIVE_VIEW`, `PLAYWRIGHT_DEMO_ACTION_PAUSE_MS`; viewer child-only `PLAYWRIGHT_DEMO_DEFERRED_VIEWER_{PORT,STREAM_ID,CAPABILITY}` is a private host-to-child capability, not operator input. `PLAYWRIGHT_DEMO_WORKFLOW_VERSION` (empty or explicit current literal accepted) and `PLAYWRIGHT_DEMO_BROWSER_BACKEND` (only absent/empty accepted) are migration-only fail-closed guards; retire when old launch instructions are gone. `PLAYWRIGHT_DEMO_UI_DIAGNOSTICS`, `PLAYWRIGHT_DEMO_LIVE_LLM_TESTS`, `PLAYWRIGHT_DEMO_LIVE_LLM_DEBUG` are diagnostic/test flags. `SEMANTIC_*_MODE`/attempt range and `PLAYWRIGHT_DEMO_{FRAME_AB,DESTINATION_READINESS,NAVIGATION_SPIKE}` are experiment-only. The profile, not an environment backend selector, owns local Chromium identity.

**`package.json` scripts.** `build`, `typecheck`, `admit:public` are current product/operator/developer; `test` and `test:fast` are the current default regression; `test:current` adds local frame/cancellation and Python integration; `test:release` composes typecheck/build/current tests; `test:all` aliases release and is redundant. No Docker/container/old-route package script survives. Phase D target: retain `build`, `typecheck`, `test` (curated product + shared/diagnostic authority), one explicit local integration command, `test:release`, and `admit:public`; expose experiments separately under `tools/experiments/README.md` rather than as normal launch scripts. Decide whether to remove the redundant `test:all`/`test:fast` aliases after CI references are checked.

## Documentation and Codex context

There are 118 Markdown files under `docs/`. The most dangerous preload mismatch is the repository instruction to read `docs/system-overview.md` and `docs/current-status.md`: both now contain explicit historical banners but much of their body still claims agentic/deferred/Docker routes are current. `README.md` still requires Docker and documents removed `npm run local`, `app/locator`, and network policy. `docs/runbook.md`, `docs/phase-3-operator-guide.md`, `app/profile/README.md`, and `app/evidence/README.md` describe removed runtime/modules. These are `STALE_MISLEADING`, not current source of truth.

| Markdown family | Classification and Phase D destination |
|---|---|
| `docs/current-state-architecture-staleness-audit.md`, `semantic-general-cleanup-plan.md`, `semantic-general-phase-c-docker-retirement-preflight.md`, this inventory | `CLEANUP_SNAPSHOT`; preserve in `docs/archive/cleanup/` after authoritative rewrite, not as routine context. |
| `docs/runtime-investigation-log.md`, `current-status.md` | `ROLLING_HISTORY`; keep accessible as history/archive, remove from routine AGENTS preload. `current-status.md` should become a short current pointer or be archived, not stay a long mixed-era source. |
| `docs/semantic-v7-*stability*.md`, `semantic-grounding-v1-stability.md`, `semantic-compiler-v5-stability.md`, `runner-v10-replay-pair-v2-stability.md`, `semantic-general-stability-audit.md`, local frame/browser A/B/performance/recovery reports | `EXPERIMENT_REPORT`; move to `docs/experiments/` with a dated index and explicit historical status. |
| `docs/architecture.md`, `system-overview.md`, `runbook.md`, `test-spec-schema.md`, `agentic-*`, `goal-directed-*`, `structured-action-*`, `deferred-*`, P2/P3/P4 plans/gates, `docs/audit/*`, old public/Docker guides and release records | `HISTORICAL_ARCHITECTURE` or `STALE_MISLEADING` when still linked as current; archive under `docs/archive/` by generation. Relative links need updating. |
| `config/README.md` | Current specialized native-config note; fold its accurate schema-5/approval content into the new operator runbook. |

Minimum authoritative Phase D set: rewritten root `README.md` (setup and pointers), one `docs/architecture.md` (actual v7/v1/v5/v10/pair-v2 graph and authority split), one `docs/runbook.md` (native schema-5 approval, public/local run, failures, diagnostics), optionally `docs/supported-capabilities.md` (only implemented operation families and known bounds). Update `AGENTS.md` to preload only README + architecture, then the relevant boundary; its current two mandatory reads load stale history.

For routine Codex work, read **README + new architecture + touched boundary**, not the journals/cohorts. Principal boundary files (at most two per row): UI/host `ui_workflow.py`, `host.py`; admission/profile `product-contracts.ts`, `native-admission.ts` (then `native-profile.ts`/`local-context.ts` only if touching browser); interpretation `semantic-intent-v3-boundary.ts`, `semantic-intent-v3.ts`; grounding `semantic-grounding-v1.ts`, `mcp.ts`; compiler `semantic-trace-compiler-v5.ts`, `semantic-compiler-store-v5.ts`; runner/replay `semantic-v10.ts`, `semantic-replay-v2.ts` (then replay store if touching authority); external result `agentic-result-v2.ts`, `protocol-v2.ts`; viewer `local-frame-channel.ts`, `local_frame_viewer.py`. This is a menu by task, not a 16-file default preload.

## Phase D execution inputs

| Step | Exact action | Expected gain / tradeoff and checkpoint |
|---|---|---|
| **D1 — tools/experiments** | Move the 12 `.mjs` investigation/fixture drivers from `scripts/` and historical `spikes/playwright-mcp/` to `tools/experiments/` with a small index. Keep `deny-openai-provider.cjs` with tests. First repair/retire the three `factory.browserBackend` guards and replace hard-coded missing artifact paths with explicit fixture input arguments or mark those drivers frozen. Update `../dist`, `.env`, artifact-root and sibling-import resolution after move. | Removes experiments from the runtime surface; path churn can break useful repro tools. Static import/path/syntax check first, then one bounded provider-free fixture smoke only for drivers deliberately kept runnable. |
| **D2 — docs archive** | Move retired route contracts/plans/gates and old Docker/P4 guides to `docs/archive/` by generation; move stability/A-B reports to `docs/experiments/`; preserve cleanup snapshots and rolling log under an obvious history index. | Prevents old claims from masquerading as current; link churn is the cost. Check internal links and leave an archive index. |
| **D3 — authoritative docs** | Replace root `README.md`, `docs/architecture.md`, `docs/runbook.md`; add `docs/supported-capabilities.md` only if it can be verified against `semantic-grounding-v1.ts`/runner v10. Fold accurate native config notes in. Retire `system-overview.md` and `current-status.md` as required preload. | One concise current narrative; writing must preserve approval/QA/non-QA and artifact truth. Review against source and one offline product/negative approval test, no public/provider run. |
| **D4 — package/context** | Curate `npm test` vs explicit local integration vs experiment suites; move admitted-v7/grounded-trace persistence tests to opt-in only if maintainers accept loss of default reproducibility coverage. Remove redundant aliases after CI search. Update `AGENTS.md`/Codex pointers and neutralize misleading current function/file names only in narrow, separately testable edits. Keep frame wire literals until a coordinated host/Node migration is justified. | Smaller context and fewer false entry points; rename/script churn risks integration. Validate package commands, Python host, static import/link references, typecheck/build, offline semantic pass and negative approval path. |

**Residual risk, priority:** High documentation risk (`README`/required preload says Docker and removed route); medium experiment operability risk (three stale factory guards and absent frozen artifact); medium diagnostic coupling (compiler trace/rejection awaited without catch); low code orphan (`app/index.ts`). Current no-Docker/single-route conclusions are static source findings plus C2's documented offline validation, not a new runtime validation in this read-only audit.
