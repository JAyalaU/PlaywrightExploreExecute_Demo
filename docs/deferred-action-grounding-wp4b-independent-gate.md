# Deferred Action Grounding WP4B independent gate

## Result

**WP4B passes. The trusted `deferred-action-v1` workflow cutover may begin from the reviewed WP4B handoff unchanged.** The gate found no production-code defect. A test-only restart regression was added because the prior child-process coverage wrote and read its pair in the same process; the added case now proves authenticated persisted-pair read and safe projection after a process restart, with exploration, MCP, and SDK imports blocked.

No workflow selector was enabled. Host, Python wire/projection, and UI integration still require their separate review and compatibility work before any production selection. No credentialed provider or approved public-browser workflow ran.

## Scope and evidence

The gate read `AGENTS.md`, the system overview, current status, the WP4A independent gate, and the WP4B contract. It inspected the pair orchestrator, ResultRecordV2 derivation, restricted pair store/readback, bounded deferred projector, historical result store/projector boundaries, focused tests, and the prior broad-suite source/dist harness correction.

Both invocations receive the same actual authenticated `TrustedResolvedTestReadbackV9` and profile. The orchestrator validates that capability before running, then invokes the deterministic v9 runner sequentially. Each run owns a new protected context. Tests verify distinct run, session and page identifiers, and cookie isolation. A missing profile, a failed first or second guard, runner/environment failure, or cleanup uncertainty produces a non-QA result without retry or fallback.

Agreement compares the ordered corresponding assertion observations, including deterministic assertion shape, actual facts and evaluation. Two completed matching true observations produce QA pass; matching false observations produce QA fail. Different assertion results, including two aggregate-false runs whose corresponding facts differ, produce a reproducibility stop. A completed pair with no assertions is recorded as reproducible execution with no QA classification. Runner stops and unverified cleanup remain non-QA.

The pair store accepts only the runtime-issued pair plus actual v9 capability. Persistence uses an authenticated restricted-root envelope. Reopen authenticates the envelope, validates the complete pair against the same v9, and derives ResultRecordV2 again from the validated pair rather than trusting the stored terminal. Forged/copy/prototype/schema-valid capabilities, changed provenance, missing session linkage and on-disk terminal tampering are rejected. The added restart regression persists a passing pair in the test process, starts a separate Node process, blocks every `/exploration/` import plus `@playwright/mcp` and `@modelcontextprotocol/*`, authenticates trace v5, v9 and the persisted replay pair, then obtains the safe projection.

The projection is available only from authenticated replay readback. Its closed bounded result exposes run identifiers, completed/stop classification, assertion counts, cleanup/reproducibility and optional QA status. Assertions' actual/expected values, source text, browser values, guard predicates, mappings, locators, traces and protected records remain private. Historical store, projector and workflow-selector regressions reject deferred-family records; historical route behavior remains covered by compatibility suites.

## Prior broad-suite harness failure

The earlier 499/500 run failed in the historical adapter-selection test because it imported TypeScript source and built `dist` in the same Node process. Both copies registered Playwright utility selector engines, and Playwright rejected duplicate singleton registration. The scoped correction in `tests/structured-action-identity-wp4b.spec.ts` preserves the source-side adapter/version/ambiguity checks and runs the same built-`dist` selection checks in a fresh child process. It changes no application module, selector registration, or adapter behavior. Production's local entry point runs built `dist` code in one process, so the corrected test follows the deployed module boundary; it does not conceal a collision in the production import graph. The corrected regression passed in both affected and broad suites.

## Validation

- Focused WP4B: **17 passed, 0 failed, 0 skipped**.
- Affected WP4B and historical external/projection compatibility: **59 passed, 0 failed, 0 skipped**.
- WP4A prerequisite plus WP4B and historical compatibility: **506 passed, 0 failed, 0 skipped**.
- Typecheck: passed.
- Build: passed.
- The parent independently verified all **146 production `app/` file hashes** remained unchanged, with no production files added or removed during the gate.
- No credentialed provider or approved public-browser workflow ran; browser evidence is from protected loopback fixtures.

Commands:

```text
npx.cmd playwright test tests/deferred-action-grounding-wp4b.spec.ts --workers=1 --output=test-results-wp4b-independent-focused
npx.cmd playwright test tests/deferred-action-grounding-wp4b.spec.ts tests/agentic-external-v2.spec.ts tests/agentic-production-wp4b.spec.ts tests/goal-directed-production-wp5b.spec.ts tests/structured-action-identity-wp4b.spec.ts tests/report-projection-p3b.spec.ts --workers=1 --output=test-results-wp4b-independent-affected
npx.cmd playwright test tests/deferred-action-grounding-wp3b.spec.ts tests/deferred-action-grounding-wp3a.spec.ts tests/deferred-action-grounding-wp2-independent-gate.spec.ts tests/deferred-action-grounding-wp2d-b.spec.ts tests/deferred-action-grounding-wp2d-a.spec.ts tests/deferred-action-grounding-wp2c.spec.ts tests/deferred-action-grounding-wp2b.spec.ts tests/deferred-action-grounding-wp2a.spec.ts tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-interpretation-v2-wp1b.spec.ts tests/deferred-action-grounding-wp1-v2-independent-gate.spec.ts tests/goal-directed-observation-wp2.spec.ts tests/agentic-current-state-wp2a.spec.ts tests/structured-action-identity-wp2.spec.ts tests/m6-mcp.spec.ts tests/goal-directed-trace-wp3b-a.spec.ts tests/goal-directed-trace-wp3b-b.spec.ts tests/agentic-trace-contracts-v2.spec.ts tests/agentic-trace-assembly-wp2b.spec.ts tests/goal-directed-verification-wp3a.spec.ts tests/goal-directed-compiler-wp4a.spec.ts tests/agentic-trace-compiler-wp3.spec.ts tests/deferred-action-grounding-wp4a.spec.ts tests/runner-m4.spec.ts tests/goal-directed-runner-wp5a.spec.ts tests/structured-action-identity-wp4a.spec.ts tests/deferred-action-grounding-wp4b.spec.ts tests/agentic-external-v2.spec.ts tests/agentic-production-wp4b.spec.ts tests/goal-directed-production-wp5b.spec.ts tests/structured-action-identity-wp4b.spec.ts tests/report-projection-p3b.spec.ts --workers=1 --output=test-results-wp4b-independent-broad
npm.cmd run typecheck
npm.cmd run build
```

## Handoff and residual boundary

The trusted host can follow the existing WP4B sequence: authenticate trace v5 and resolved v9, call `runDeferredTwoFreshReplaysV1`, persist the actual trusted pair with the actual v9 capability, reopen the authenticated result, and call `projectDeferredReportV2`. Only the derived ResultRecordV2 or safe projection may cross its reviewed external boundary. Store/projection failures remain environment or availability stops and cannot change QA.

The gate authorizes beginning the separately reviewed trusted workflow integration using this handoff unchanged. It does not authorize enabling the workflow selector. The production host's trusted selection, v5/compiler-v4 integration, Python closed-wire/projection support, and UI result handling remain required follow-up work. Public-provider/live behavior was not exercised.

DEFERRED_ACTION_GROUNDING_WP4B_GATE_PASSED
