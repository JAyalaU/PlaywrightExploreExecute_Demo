# Deferred Action Grounding offline release gate

## Result

**Offline release gate passed. `deferred-action-v1` is ready for offline release review only.** The trusted selector remains gated and non-default. This gate made no production-code changes, did not enable workflow selection, and did not run a credentialed provider or approved public-target workflow.

A separately approved real-provider/public-target proof may begin as its own controlled step. This offline result does not approve that run or change the selector. The current released workflow remains unchanged.

## Scope and evidence

The gate independently reviewed the WP5A composition, local workflow selector, Node subprocess entry, Python host and protocol validators, Node/Python projection contracts, and Streamlit render path. It also ran the final-tree focused, affected, broader-boundary, Python, typecheck, and build checks prescribed by WP5A. Protected browser evidence came only from loopback fixtures with mocked HTTP provider responses.

The integrated path preserves the actual capabilities from v6/ActionGoal v2 semantic admission and total endorsed obligation mapping through protected WP2 grounding and action execution, authenticated trace v5, fresh compiler v4/resolved v9, two fresh runner-v9 contexts, authenticated replay/result re-derivation, and bounded deferred projection. Each stage consumes the trusted predecessor capability; copied or schema-valid records do not replace it. Stage-specific interpretation, grounding, trace, compilation, provider/environment, persistence, cancellation, and cleanup stops remain non-QA. No older TestSpec, trace, compiler, resolved-artifact, runner, store, or projector family is a fallback.

The primary `Select Option 1.` scenario completed the entire mocked-provider path against one unnamed native dropdown. The authored option remained the argument; the model supplied no control name or executable DOM value. Both fresh replays completed with distinct run/session identities. Because the scenario has no assertion, its terminal was reproducible execution with **no QA verdict**. With two eligible dropdowns, grounding returned `NON_UNIQUE` in the single exploration context: there were no execution runs, resolved artifact, replay pair, or QA result.

Country-constrained choice, unnamed native fill, and native checkbox/radio activation also completed through the integrated path. Verification fixtures covered agreeing true and agreeing false assertions; both classify as QA only after two completed agreeing runs. A differing replay stopped for reproducibility. Grounding ambiguity, compiler rejection, runner stop, cleanup uncertainty, persistence failure, and post-completion cancellation did not become QA. Assertion-free agreement remained non-QA.

Authenticated projection was reopened in a fresh Node process after persistence while all exploration, Playwright MCP, and MCP SDK imports were blocked. Authentication and result re-derivation succeeded; tampering and historical-projector access failed closed. Python parsed the actual Node envelope/projection in the integration cases and enforces the same deferred versions, linkage, stage-code vocabulary, replay states, agreement rules, and closed field sets. The UI reads only the reviewed terminal/correlation metadata and deferred replay state, assertion count, cleanup, reproducibility, and optional QA fields. The projection and UI expose no source text or arguments, browser facts, trace/guard/mapping evidence, assertion actual/expected values, screenshots, or protected records. Projection is bounded to 8 KiB.

Selection checks passed. The existing default behavior is unchanged. The Node CLI denied `deferred-action-v1` when `PLAYWRIGHT_DEMO_WORKFLOW_VERSION=deferred-action-v1` was set without `PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE=offline-review`, returning `INVALID_TRUSTED_CONFIGURATION` before configuration or browser work. Python independently returned `workflow_unavailable` before public admission when ungated. The offline gate and workflow version come from trusted process launch configuration; the task request has no workflow field, the strict Node request rejects an injected `workflowVersion`, the UI form carries only URL and task text, and model output cannot select a workflow. The historical routes, stores, and projectors remained isolated. The parent gate owner independently compared 171 production file hashes across `app/` and `src/playwright_demo/`; all matched, with no added or removed production files.

## Final-tree validation

| Suite | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Focused WP5A integrated mocked-provider/loopback suite | 21 | 0 | 0 |
| Affected Node compatibility | 111 | 0 | 0 |
| Broader WP1-WP4 and historical trace/compiler/runner boundary | 330 | 0 | 0 |
| Python affected host/protocol/projection/UI | 52 | 0 | 1 |
| Python focused deferred workflow | 7 | 0 | 0 |
| Post-build fresh-process projection smoke (overlaps focused suite) | 1 | 0 | 0 |

The sole Python skip is the explicit credentialed-provider opt-in test. Typecheck and build passed. The 330-test suite was rerun on the final tree after the private compiler-accounting correction; it was not expanded to the unrelated historical 500-test universe.

Commands run:

```powershell
npx.cmd playwright test tests/deferred-action-production-wp5a.spec.ts --workers=1 --output=test-results-wp5a-independent-final

npx.cmd playwright test tests/deferred-action-production-wp5a.spec.ts tests/deferred-action-grounding-wp4b.spec.ts tests/agentic-external-v2.spec.ts tests/agentic-production-wp4b.spec.ts tests/goal-directed-production-wp5b.spec.ts tests/structured-action-identity-wp4b.spec.ts tests/agentic-cli-v2.spec.ts tests/report-projection-p3b.spec.ts tests/subprocess-protocol-p2-3a.spec.ts tests/subprocess-entry-p2-3b.spec.ts tests/subprocess-cancellation-p4-2.spec.ts tests/openai-responses-p2-1b.spec.ts tests/openai-adapters-p2-1c.spec.ts --workers=1 --output=test-results-wp5a-independent-affected-final

npx.cmd playwright test tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-interpretation-v2-wp1b.spec.ts tests/deferred-action-grounding-wp1-v2-independent-gate.spec.ts tests/deferred-action-grounding-wp2-independent-gate.spec.ts tests/deferred-action-grounding-wp2d-a.spec.ts tests/deferred-action-grounding-wp2d-b.spec.ts tests/deferred-action-grounding-wp3a.spec.ts tests/deferred-action-grounding-wp3b.spec.ts tests/deferred-action-grounding-wp4a.spec.ts tests/agentic-trace-contracts-v2.spec.ts tests/agentic-trace-assembly-wp2b.spec.ts tests/agentic-trace-compiler-wp3.spec.ts tests/goal-directed-trace-wp3b-a.spec.ts tests/goal-directed-trace-wp3b-b.spec.ts tests/goal-directed-compiler-wp4a.spec.ts tests/goal-directed-runner-wp5a.spec.ts tests/structured-action-identity-wp4a.spec.ts tests/runner-m4.spec.ts --workers=1 --output=test-results-wp5a-independent-broader-final

.venv/Scripts/python.exe -m unittest tests.python.test_deferred_workflow_wp5a tests.python.test_agentic_external_v2 tests.python.test_report_projection_p3b tests.python.test_subprocess_host tests.python.test_ui_shell_p3c tests.python.test_ui_workflow_p3d tests.python.test_phase3_regression_p3e
.venv/Scripts/python.exe -m unittest tests.python.test_deferred_workflow_wp5a

npm.cmd run typecheck
npm.cmd run build

npx.cmd playwright test tests/deferred-action-production-wp5a.spec.ts --grep "persisted projection restart" --workers=1 --output=test-results-wp5a-independent-postbuild-smoke
```

The separate Node CLI gate probe set the workflow environment to `deferred-action-v1`, left the offline gate unset, and observed `INVALID_TRUSTED_CONFIGURATION`. The Python suite contains the matching pre-admission denial test.

## Residual limits

No architectural violation was found in the reviewed offline boundary. Intent interpretation still has correlated-model-error risk, and mocked provider agreement does not establish live-model semantic quality. The intentionally unsupported subset remains generic button/link activation, custom controls, arbitrary/spatial relationships, unsupported temporal verification, and recovery/repair. These continue to stop without fallback. An approved real-provider/public-target proof is still required before any production selector release or default change.

The offline procedure is complete: retain both launch gates, run no public target as part of this result, and keep the existing workflow default unchanged. Any real-provider proof requires separate explicit approval and the existing trusted public-target admission/profile controls; its evidence and outcome must be reviewed independently.

DEFERRED_ACTION_GROUNDING_OFFLINE_RELEASE_READY
