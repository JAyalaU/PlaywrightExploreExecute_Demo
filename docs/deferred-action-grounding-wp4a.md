# Deferred Action Grounding WP4A: deterministic runner v9

## Boundary

`app/runner/deferred-v9.ts` implements one separate fresh deterministic replay. Its only input artifact is the actual `TrustedResolvedTestReadbackV9` from the authenticated compiler/resolved store. A parsed v9, copied readback, prototype, callback, or schema-valid record cannot confer runner input authority. The WP3B handoff is unchanged.

The runner opens a new `ProtectedContextFactory` context with the approved profile reference and exact effective fingerprint, including the existing network/auth/isolation approval controls. No exploration session, compiler runtime, model, MCP, or SDK is loaded. The persisted read path continues to authenticate and validate the v5/compiler-v4/v9 chain using pure validators. Fresh-process tests block exploration modules, `@playwright/mcp`, and `@modelcontextprotocol/*`, then reopen both stores and actually execute v9.

## Guard and action execution

Every action reconstructs guard v1 from the complete immutable endorsed correspondence. It queries the broad reviewed role/name domain in every current page frame before applying only accepted semantic-role/name/label realizations. Native capability, frame convenience, or presence of an option cannot narrow an ambiguous control domain. Completeness bounds remain eight frames, 80 candidates, 80 options, and bounded native label sources. Overflow or unevaluable evidence stops without dispatch.

The selected frame independently proves the exact durable root-to-leaf title/test-id ancestry and unique parent ownership. Authored labels narrow only through browser exact label matching plus reviewed native-label or ARIA-IDREF ownership; visual proximity and equal accessible names alone never prove that relation. The unchanged reviewed label and utility-world trusted-click primitives now live in `app/browser-action/`, with compatibility reexports at their historical exploration paths.

Native select options are completely enumerated in Playwright's isolated utility world. The authored displayed label must identify one enabled owned option with a unique executable value in a single select. The fresh value must equal v9's compiled argument under `require_fresh_mapping_equal_compiled_argument`. A new uniquely mapped value may have been accepted by the compiler; a subsequent replay value change stops `OPTION_MAPPING_MISMATCH`. There is no remapping repair.

The runner owns a private serialized callback in its fresh protected context. Scroll preparation is followed by a full guard renewal, state renewal, and retained-node/label/option identity comparison. It dispatches the exact reviewed operation and argument exactly once on that retained `ElementHandle`, with forced bounded execution avoiding actionability waits that could silently rebind. A replacement cannot inherit authority. No browser ref, CSS/XPath/JS/model locator, exploratory executable value, historical retirement operation, retry, discovery, or old runner fallback is used as authority.

Fresh post-effect facts are bracketed by stable protected state, a renewed complete guard, exact retained-node proof, and a final native-fact read. Text fill requires the exact admitted value in the supported native input/textarea. Native choice requires unchanged complete owned options and the exact mapped option/value selected. Native checkbox/radio activation requires the unchanged utility-world target-owned trusted single-click receipt and checked transition. A command return alone never establishes success; mutated, replaced, partial, no-op, or unevaluable effects retain attempted invocation accounting and stop non-QA.

## Runner records and outcomes

`app/domain/deferred-action-runner.ts` defines the closed `DeferredRunnerRecordV9`, source/trace/compiler/resolved/admission/profile provenance, fresh run/session/page/state chain, ordered step records, invocation outcome, mutation uncertainty, predicate digest, full successful effect facts, and full assertion/actual/evaluation facts. Mechanical parsing checks canonical digest, state continuity, step uniqueness, invocation/effect correspondence, successful proof completeness, and completed assertion accounting. Parsing alone cannot create trusted runner origin.

These records are restricted internal evidence. A future stakeholder-safe projection must remain separate and must not expose authored private values, browser facts, or trace/readback payloads.

`TrustedDeferredRunV9` privately owns the cloned final record. `requireTrustedDeferredRunV9` requires genuine issuer origin and returns a checked copy; caller methods and JSON cannot supply that authority. Valid effects remain in succeeded step records after a later non-QA stop or cleanup failure. Unsuccessful invocations stay in distinct stopped step records, with `not_invoked`, `returned`, or `threw` and `mutationMayHaveOccurred`; no failed or unproven step carries a successful effect. Every step explicitly marks its after-state `observed` or `unavailable`. When mutation occurred but a fresh state read is impossible, `after` retains only the last known point with `unavailable`; that point is never represented as fresh proof or admitted to completion.

The result is either `completed` with per-run deterministic assertion count/evaluation, or `non_qa_stop` with a closed reason. Zero-assertion completion establishes successful execution only. One run's completed assertion result is an observation for future two-run agreement, not a production QA terminal. Stops cover unauthenticated input, profile mismatch, target ambiguity/missing target, label/option/frame mismatch, incomplete/stale evidence, unsupported capability, unevaluable verification, partial/unknown action failure, unproven post-effect, environment failure, state-continuity mismatch, budget exhaustion, and unverified cleanup. False evaluable assertions remain completed false observations; guard/environment uncertainty never becomes QA failure.

The run has a shared 120-second deadline and fixed bounded browser reads/actions. Source order includes authored navigation and supported count, unique boolean/string property, and exact/prefix URL VerificationGoal assertions. `verification-v9.ts` provides the isolated deterministic assertion evaluation with explicit actual facts; it performs no authored-English interpretation or strategy discovery.

## Final integrity and cleanup

All paths close the fresh protected session. An additive `ProtectedBrowserSession.closeWithFinalCheck` runs the trusted read-only final check after existing closing observers and before context teardown. It always completes context/browser/proxy cleanup even when that proof fails. `ProtectedFinalCheckError` distinguishes a failed final proof with completed cleanup from failed cleanup. The runner uses only state reads in this closing window; new actions remain barred by the session closing state. A closing observer's state mutation produces a non-QA continuity stop while preserving earlier valid invocation/effect evidence. Ordinary `close`, its idempotent/reentrant cleanup behavior, and historical runners remain unchanged.

## Supported subset and compatibility

Supported actions are native input/textarea fill, native single-select choice, and native checkbox/radio activation. Unnamed controls, exact authored role/name, endorsed Country label narrowing, and durable nested frames are supported. Authored navigation and existing closed VerificationGoal projections are supported. Generic buttons/links, custom controls, arbitrary/spatial relationships, unsupported verification forms, data-reference substitution, discovery/recovery, production route selection, and two-replay orchestration remain outside this package.

Historical `run.ts`, `locator.ts`, and `verification-v7.ts` were unchanged. Old trace/compiler/resolved/runner families remain separately readable and executable. The parent independently checked their content against the pre-task baseline. The parent also passed final typecheck/build and an import-blocked built runner dependency check.

## Exact production orchestration handoff

The trusted host authenticates v5 and obtains actual v9 via `DeferredCompilerV4Store.readResolvedV9(testSpecId, compilerAttemptId, actualV5Readback)`. It calls `runDeferredResolvedTestV9(protectedFactory, actualV9Readback)` from `app/runner/deferred-v9.ts`, receiving actual `TrustedDeferredRunV9`. Only `requireTrustedDeferredRunV9` grants its cloned provenance/state/step/effect/assertion/cleanup record. The host must preserve the exact authenticated artifact and run links and later invoke two independent fresh runs under the same approved profile before applying reviewed completed-assertion agreement semantics. Non-QA stops and cleanup uncertainty remain non-QA. Neither two-run agreement nor production routing/report projection is implemented here.

## Validation

The final strengthened focused runner suite passed **41/41**, zero failures/skips, in 1.4 minutes. It includes complete protected exploration-to-authenticated-trace-to-fresh-compiler-to-authenticated-v9-to-fresh-runner fixture paths; drift, replacement, partial/unproven execution, mutation followed by unavailable state, final post-proof mutation, closing-boundary drift, cleanup failure, tampering, forgery, fresh-process import blocking, and exact facts for completed false assertions.

The final complete compatibility run passed **444/444**, zero failures/skips, in 8.3 minutes. It combined the complete 381-case WP3 prerequisite/compatibility list from WP3B, the new 41-case runner suite, and 22 historical runner cases from `runner-m4`, `goal-directed-runner-wp5a`, and `structured-action-identity-wp4a`. The focused suite was also completed independently on the final tree. Final typecheck and build passed. The parent independently passed typecheck/build, built-module import blocking, and the three critical post-proof/closing-drift/unavailable-state regressions (**3/3**).

```text
npx.cmd playwright test tests/deferred-action-grounding-wp4a.spec.ts --workers=1 --output=test-results-wp4a-focused-final
npm.cmd run typecheck
npm.cmd run build
```

The complete compatibility invocation used the unchanged full WP3B compatibility file list with the new runner suite and the three historical runner suites added, `--workers=1`, and `--output=test-results-wp4a-compat-final`.

No credentialed provider or approved public-browser workflow was run. Fixture evidence verifies the deterministic contracts and boundaries, not live-provider semantics or the pending public-browser release proof. Two-replay production orchestration and workflow selection remain unimplemented.

DEFERRED_ACTION_GROUNDING_WP4A_COMPLETE
