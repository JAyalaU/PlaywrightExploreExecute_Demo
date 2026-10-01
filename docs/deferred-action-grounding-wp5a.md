# Deferred Action Grounding WP5A: trusted workflow integration

## Status and selection

The explicit `deferred-action-v1` family is integrated across Node subprocess v2, the trusted Python host composition and the Streamlit safe result boundary. It remains gated and non-default. The released `agentic-exploration-v1`, historical `goal-directed-v1`, `structured-action-v1`, legacy subprocess v1 and their artifact/projector families remain separate.

Trusted launch must set both `PLAYWRIGHT_DEMO_WORKFLOW_VERSION=deferred-action-v1` and `PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE=offline-review`. Without the gate the Node entry and local workflow deny selection; Python returns workflow-unavailable before admission/browser execution. Task text, wire fields and model output cannot select or approve the workflow. This gate is for independent offline review, not a released default or a live-provider approval. No credentialed provider or approved public-browser workflow ran.

## Exact integration path

`app/local/agentic-workflow.ts` branches only after the existing trusted configuration, approved profile, target authority and DNS/policy checks. `app/local/deferred-workflow.ts` owns the dedicated managed factory, stateless model adapters, cancellation and observed final cleanup. `app/interpretation/deferred-action-production.ts` composes:

1. Existing primary ActionGoal v2 extraction and independent source-first extraction adapters through `interpretDeferredActionTaskV2`. Only original authored source reaches the independent extraction. The actual private `TrustedSemanticAdmissionV2` capability remains intact.
2. A fresh protected MCP exploration session with WP2 candidate runtime. Ordered goals use the existing bounded WP2D protected execution controller, authored navigation, and existing VerificationGoal controller. Only successful runtime-owned witnesses and completed supported verification strategies enter `SuccessfulTraceAssemblerV5`.
3. Actual assembled trace v5 into `SuccessfulTraceV5Store`. Exploration cleanup must verify before compilation; the first cleanup failure remains unverified even if a later close succeeds.
4. Actual authenticated trace readback into `compileDeferredSuccessfulTraceV5`, then its actual compiler-v4 origin into `DeferredCompilerV4Store.writeCompilationV4`. Rejections persist their compiler attempt and never issue resolved v9. Accepted compilation returns the existing actual `TrustedResolvedTestReadbackV9` unchanged.
5. Exact WP4B handoff: that actual v9 capability enters `runDeferredTwoFreshReplaysV1`; its actual runtime pair enters `DeferredReplayV9Store.writeReplayV1` with the same v9; actual authenticated replay readback derives ResultRecordV2 and feeds `projectDeferredReportV2`. No supplied result, witness, approval flag or copied artifact replaces a capability.
6. Only after immutable replay persistence does `envelopeForAgenticTerminalV2` produce the external protocol-v2 terminal. Read-only projection reopens and authenticates trace v5, compiler/resolved v9 and replay pair from their trusted identifiers and requires exact result equality before projection.

There is no fallback to TestSpec v5, trace v4, compiler v3, resolved v8 or older runners. Browser convenience cannot weaken admitted obligations. The compiler independently reconstructs the entire endorsed predicate, and both runners retain the unchanged complete guard, exact retained-node execution and fresh effect-proof policy.

## Provider/runtime boundary

`app/interpretation/action-grounding-adapters.ts` and `action-grounding-wire.ts` add reviewed `qa_action_grounding_v5` and `qa_action_grounding_source_first_v1` Responses formats. Strict schemas are generated from the existing closed WP2D decision/mapping vocabulary, with required nullable optionals and supported schema representation; runtime domain validation remains authoritative. Only those exact format instances are added to the bounded Responses transport allowlist. Independent mapping receives original source and admitted obligations, never the first correspondence or browser/candidate discoveries.

No production English parsing, synonym rules, model-authored locator vocabulary, custom browser primitive or new successful effect type was introduced. Existing VerificationGoal source/strategy semantics are reused. Generic button/link activation, custom controls, arbitrary relationships, unsupported temporal verification and recovery remain unsupported.

## Stops, durable accounting and external results

The WP4B `deferredReplay` linkage and agreement/result semantics remain unchanged. Two completed agreeing true observations produce QA pass, agreeing false observations produce QA fail, differing corresponding shape/actual/evaluation produces reproducibility non-QA, and runner/cleanup uncertainty remains non-QA. Zero-assertion completed agreement produces `EXECUTION_REPRODUCED / NO_ASSERTIONS`, never QA pass.

Before an authenticated replay terminal exists, a closed additive `deferredStage` carries integration/source version, stage, category, safe code and source/admission/trace digests as available. Structural, disagreement, omission/fidelity, unresolved, authored ambiguity, unsupported authored mechanism/constraint, provider/environment, trace integrity, compilation and persistence stops stay distinct in this metadata. Source digest before admission identifies the original instruction; after admission it is the immutable admitted handoff source digest. A stage record cannot claim replay runs, resolved execution or QA, cannot coexist with `deferredReplay`, and must preserve required admission/trace provenance. Early-stage report availability is always false.

`app/evidence/deferred-workflow-store.ts` writes these non-QA terminals in the separate immutable HMAC-authenticated `deferred-workflow-stop-v1` namespace. Actual runtime origin is required to write; schema-valid copies/prototypes cannot authorize persistence. Restricted closed accounting preserves validated grounding invocations and successful witnesses from the attempt. It also preserves the actual compiler-origin CompilerAttempt v4, validated against the authenticated v5 trace before compiler-store writing, so fresh compiler execution/effect accounting remains durable when that namespace write fails. Completed actual replay accounting remains available if replay persistence fails. Invalid or untrusted proof cannot enter this accounting. It is diagnostic accounting only and cannot issue a witness, successful trace, resolved capability, pair readback or QA result. Its reader is pure and authenticates the complete stored envelope. The projected/public result contains none of this private accounting.

A store failure is an environment/persistence stop, never QA or repair authority. If even the stop terminal cannot persist, the existing subprocess error boundary returns a non-QA bridge failure. A late cancellation after a completed actual pair keeps that pair privately persisted and returns a cancellation bridge with verified cleanup only when cleanup is verified; it cannot return the previously derived QA envelope for the cancelled invocation.

## Host, Python and UI

`src/playwright_demo/protocol_v2.py`, `deferred_contract_v2.py` and `deferred_stage_codes.py` validate exact deferred result versions, linkage, safe stop taxonomy, stage correlation and assertion-free terminal. They reject cross-family deferred fields, malformed digests, contradictory QA and early-stage available reports. Python is a closed serialization consumer, not a semantic or QA authority.

`ui_workflow.py` uses the existing reviewed admission/supervision/cancellation host with the gated workflow selection. It launches `dist/subprocess/agentic-cli.js` and the separate `dist/subprocess/deferred-report-projection-cli.js`. The new pure projection entry has bounded UTF-8 input/output and trusted configuration reads; its deferred path authenticates stored artifacts without exploration/compiler runtime/MCP/SDK imports. Historical projection CLI remains unchanged.

`report_projection_v2.py` accepts only the exact bounded deferred projection attached to the matching Node envelope. `ui_shell.py` renders only reviewed terminal/correlation metadata, safe stage codes, replay state/assertion count/cleanup, agreement and optional QA. Assertion-free reproducible execution is explicitly labelled as having no QA verdict. The deferred UI exposes no expected/actual values, source instructions/arguments, browser facts, snapshots, traces, guard predicates, mappings, locators, screenshots or protected records. Projection failure cannot reclassify the terminal.

## Runtime and compatibility

The runtime adds bounded asynchronous stage composition and asynchronous immutable storage; no dependencies, synchronous filesystem hot path, worker pool, CPU-intensive pipeline, new network endpoint or logging payload was added. The existing protected factory owns browser/proxy/socket isolation and shutdown. Cancellation closes all tracked sessions, asynchronous cleanup rejection is observed, and final cleanup is checked before external return. No browser state is shared between exploration, compiler or the two replay sessions.

Historical runner/compiler implementations, projections and stores retain their version families. Old projection/store authority refuses deferred records. Existing entry points keep their defaults. No provider credentials or private error strings enter stdout or safe projection.

## Validation

| Check | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Final strengthened WP5A integration | 21 | 0 | 0 |
| Final affected compatibility (includes the 21 integration cases) | 111 | 0 | 0 |
| Broader WP1-WP4 and historical trace/compiler/runner compatibility | 330 | 0 | 0 |
| Python affected host/protocol/projection/UI | 52 | 0 | 1 |
| Python focused after final private-accounting correction | 7 | 0 | 0 |

Typecheck and build passed on the final tree. The 330-case broader run preceded the final private compiler-accounting addition in `domain/deferred-workflow-accounting.ts` and `interpretation/deferred-action-production.ts`; the final 21/111 runs followed it and validate compiler-store failure retains validated execution/effect diagnostics without issuing v9 authority. Scope comparison confirmed the existing WP1-WP4 and historical compiler/runner/projector implementations remained unchanged. Counts overlap where stated and are not an aggregate total. The Python skip is the explicit credentialed-provider opt-in case. One initial Python AppTest timing timeout passed alone and then in two full affected reruns without changing that test.

Completed commands (Windows PowerShell):

```powershell
npx.cmd playwright test tests/deferred-action-production-wp5a.spec.ts --workers=1 --output=test-results-wp5a-focused-final-accounting

npx.cmd playwright test tests/deferred-action-production-wp5a.spec.ts tests/deferred-action-grounding-wp4b.spec.ts tests/agentic-external-v2.spec.ts tests/agentic-production-wp4b.spec.ts tests/goal-directed-production-wp5b.spec.ts tests/structured-action-identity-wp4b.spec.ts tests/agentic-cli-v2.spec.ts tests/report-projection-p3b.spec.ts tests/subprocess-protocol-p2-3a.spec.ts tests/subprocess-entry-p2-3b.spec.ts tests/subprocess-cancellation-p4-2.spec.ts tests/openai-responses-p2-1b.spec.ts tests/openai-adapters-p2-1c.spec.ts --workers=1 --output=test-results-wp5a-affected-final-accounting

npx.cmd playwright test tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-interpretation-v2-wp1b.spec.ts tests/deferred-action-grounding-wp1-v2-independent-gate.spec.ts tests/deferred-action-grounding-wp2-independent-gate.spec.ts tests/deferred-action-grounding-wp2d-a.spec.ts tests/deferred-action-grounding-wp2d-b.spec.ts tests/deferred-action-grounding-wp3a.spec.ts tests/deferred-action-grounding-wp3b.spec.ts tests/deferred-action-grounding-wp4a.spec.ts tests/agentic-trace-contracts-v2.spec.ts tests/agentic-trace-assembly-wp2b.spec.ts tests/agentic-trace-compiler-wp3.spec.ts tests/goal-directed-trace-wp3b-a.spec.ts tests/goal-directed-trace-wp3b-b.spec.ts tests/goal-directed-compiler-wp4a.spec.ts tests/goal-directed-runner-wp5a.spec.ts tests/structured-action-identity-wp4a.spec.ts tests/runner-m4.spec.ts --workers=1 --output=test-results-wp5a-broader-final

.venv/Scripts/python.exe -m unittest tests.python.test_deferred_workflow_wp5a tests.python.test_agentic_external_v2 tests.python.test_report_projection_p3b tests.python.test_subprocess_host tests.python.test_ui_shell_p3c tests.python.test_ui_workflow_p3d tests.python.test_phase3_regression_p3e

.venv/Scripts/python.exe -m unittest tests.python.test_deferred_workflow_wp5a

npm.cmd run typecheck
npm.cmd run build
```

The focused integration enters the actual subprocess adapter and default HTTP-mocked provider adapters with protected loopback browsers. `Select Option 1.` succeeds with one unnamed native select; no authored control name, fabricated identity, model DOM value or weakened uniqueness is supplied. Two eligible dropdowns stop `NON_UNIQUE` before mutation/compile. Additional cases cover Country-owned labels, native fill, checkbox/radio, true/false/disagreeing replay observations, compiler/runner/cleanup stops, zero assertions, malformed source, immutable-store failures, sticky cleanup, cancellation, safe restart projection, old-route isolation, strict schema compatibility, and actual Node-to-Python wire/projection parsing.

## Final offline release-gate procedure

1. Have `test-automator` independently inspect this integration and the authoritative deferred architecture/addendum plus completed WP1 through WP4 gates. Do not change production code, run credentialed providers, start a public browser or enable the production selector.
2. Keep the default selection unchanged. Prove ungated `deferred-action-v1` is denied in Node and Python. Set the exact offline-review gate only inside isolated mocked-provider/approved loopback fixtures; task/form input must never select a workflow.
3. Re-run the focused WP5A integration, affected external/provider/CLI compatibility and the broader changed-boundary suite listed above, then the Python host/protocol/projection/UI suite, typecheck and build on a frozen tree. No skipped prerequisite case counts as proof.
4. Audit actual capability continuity: v2 admission, total endorsed mapping, successful protected WP2 witness, authenticated v5 trace, fresh compiler4/v9, two distinct fresh sessions/runs and authenticated pair/result re-derivation. Repeat ambiguity/drift, false observation versus uncertainty, persistence/cancellation and cleanup regressions.
5. Reopen projection in a fresh process with exploration/MCP/SDK imports blocked. Recheck authentication/tampering, safe bounded output and exact Node/Python enum/shape parity. Inspect UI fields and verify zero-assertion execution is non-QA. Historical stores/projectors and routes must stay isolated.
6. Publish an independent offline gate report with counts, violations and selector state. Only a separately approved release step after that gate may change trusted selector availability/defaults. This completion report does not enable selection or substitute for any future approved-public-target live proof.

DEFERRED_ACTION_GROUNDING_WP5A_COMPLETE
