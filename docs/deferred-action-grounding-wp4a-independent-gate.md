# Deferred Action Grounding WP4A independent gate

## Result

**WP4A passes. Two-fresh-replay production orchestration may begin with the existing runner-v9 handoff unchanged.** The runner accepted authentic v9 readback only, ran in a fresh approved matching context, re-evaluated the closed predicate before dispatch, executed each supported operation once, and required fresh post-action evidence. Guard, state, verification, environment, and cleanup uncertainty remained non-QA stops. No production code changed during this gate.

The only added test cases directly cover the previously implicit exactly-once dispatch rule and a missing VerificationGoal target after an earlier successful action. Root verification confirmed all 142 production `app/` files had unchanged SHA256 hashes and no production paths were added or removed.

No credentialed provider or approved public-browser workflow ran. Evidence came from isolated protected loopback fixtures.

## Scope and evidence

The gate read the repository instructions, system overview, current status, WP3B contract, WP3 independent re-gate, and WP4A contract. It independently inspected `app/runner/deferred-v9.ts`, `app/runner/verification-v9.ts`, `app/domain/deferred-action-runner.ts`, the protected-context final-check boundary, and `tests/deferred-action-grounding-wp4a.spec.ts`.

The primary path creates an ActionGoal v2 admission, successful trace v5, fresh compiler v4 output, and authenticated `TrustedResolvedTestReadbackV9`, then invokes the runner with that actual store capability. Forged, copied, prototype-only, tampered, or schema-valid readbacks fail before the protected context opens. Profile mismatch also stops before context creation. A fresh child process blocks all `/exploration/` modules, `@playwright/mcp`, and `@modelcontextprotocol/*`; it authenticates persisted v5/v9, executes the runner, and successfully reads the trusted run record without those imports.

For every action the runner counts the broad role/name domain across frames before applying only accepted role, name, or owned-label correspondence. It checks frame ancestry, native control type and capability, complete native option ownership, and the fresh authored-label-to-compiled-value mapping. The runner then retains the current `ElementHandle`, scrolls, rebuilds the full predicate, and proves node identity and state before dispatch. New tests instrument the actual Playwright `ElementHandle.fill`, `selectOption`, and `click` calls: each supported action invokes its operation exactly once. Existing replacement tests prove a replaced candidate is rejected before dispatch or cannot produce a successful effect afterward.

Post-action acceptance requires bracketed fresh native facts and a renewed complete guard. The fixtures cover exact entered text, selected owned option and pinned value, and trusted checkbox/radio transition. A command return with a no-op, partial failure, replacement, option mutation, changed value, closed page, or post-read mutation never yields a successful effect. Prior valid successful effects remain in the record if a later step, final state check, or cleanup stops the run.

The supported end-to-end set passed: unnamed input and textarea fill; unnamed native dropdown choice; Country-constrained choice; checkbox/radio activation; authored navigation; and deterministic boolean, count, string, and URL assertions. Unsupported generic buttons/links and custom controls stop before dispatch. Assertions with a complete actual fact and a false predicate remain `completed` false observations. The added regression removes the named dialog after a successful fill: the missing verification target produces `VERIFICATION_UNEVALUABLE`, records the verification step as stopped, and preserves the successful fill effect. Thus evaluator uncertainty does not become an assertion failure.

Drift and failure fixtures cover fresh multi-match ambiguity across frames, custom-role ambiguity, changed/duplicate/disabled/truncated options, changed label ownership, frame-owner drift, target replacement, compiled-argument mismatch, unproven post-effect, state unavailability after an attempted action, protected cleanup failure, and persisted-data tampering. Attempts distinguish `not_invoked`, `returned`, and `threw`; mutation uncertainty is kept separate from successful effects. Those conditions return typed non-QA outcomes. Source inspection also confirmed there is no old-runner fallback, model/MCP dependency, discovery, or recovery path in runner v9.

## Validation

- Focused WP4A suite: **44 passed, 0 failed, 0 skipped**.
- Full WP3 prerequisite and compatibility list plus WP4A and three historical runner suites: **447 passed, 0 failed, 0 skipped**, 11.0 minutes.
- Typecheck: passed.
- Build: passed.
- Production-source integrity: parent independently verified all **142** pre-gate `app/` file hashes unchanged, with no added or removed production files.

Focused command:

```text
npx.cmd playwright test tests/deferred-action-grounding-wp4a.spec.ts --workers=1 --output=test-results-wp4a-gate-focused-final
```

Full compatibility command:

```text
npx.cmd playwright test tests/deferred-action-grounding-wp3b.spec.ts tests/deferred-action-grounding-wp3a.spec.ts tests/deferred-action-grounding-wp2-independent-gate.spec.ts tests/deferred-action-grounding-wp2d-b.spec.ts tests/deferred-action-grounding-wp2d-a.spec.ts tests/deferred-action-grounding-wp2c.spec.ts tests/deferred-action-grounding-wp2b.spec.ts tests/deferred-action-grounding-wp2a.spec.ts tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-interpretation-v2-wp1b.spec.ts tests/deferred-action-grounding-wp1-v2-independent-gate.spec.ts tests/goal-directed-observation-wp2.spec.ts tests/agentic-current-state-wp2a.spec.ts tests/structured-action-identity-wp2.spec.ts tests/m6-mcp.spec.ts tests/goal-directed-trace-wp3b-a.spec.ts tests/goal-directed-trace-wp3b-b.spec.ts tests/agentic-trace-contracts-v2.spec.ts tests/agentic-trace-assembly-wp2b.spec.ts tests/goal-directed-verification-wp3a.spec.ts tests/goal-directed-compiler-wp4a.spec.ts tests/agentic-trace-compiler-wp3.spec.ts tests/deferred-action-grounding-wp4a.spec.ts tests/runner-m4.spec.ts tests/goal-directed-runner-wp5a.spec.ts tests/structured-action-identity-wp4a.spec.ts --workers=1 --output=test-results-wp4a-gate-compat-final
npm.cmd run typecheck
npm.cmd run build
```

## Handoff and remaining limits

The trusted host authenticates v5 and obtains actual v9 through `DeferredCompilerV4Store.readResolvedV9(testSpecId, compilerAttemptId, actualV5Readback)`. It passes that actual capability to `runDeferredResolvedTestV9(protectedFactory, actualV9Readback)`, then obtains the checked private run record through `requireTrustedDeferredRunV9`. Orchestration must create two independent fresh runner contexts under the same approved profile, preserve artifact/run provenance, and apply reviewed agreement only to completed deterministic assertion observations. A completed run with no assertions represents execution evidence; non-QA stops and cleanup uncertainty remain non-QA.

No runner-v9 architectural violation blocks orchestration. Live-provider semantics, public-browser runtime behavior, and production workflow selection remain outside this gate.

DEFERRED_ACTION_GROUNDING_WP4A_GATE_PASSED
