# MVP architecture: natural-language UI validation

## Evidence and recommendation

The completed fixture spike supports Playwright MCP for controlled exploration: 12/12 targets resolved and interacted correctly (A=5, B=7), and generated locators passed 24 fresh-context replays. Eleven of twelve passed the approved identity-quality rule. Scenario 8's glyph locator (`getByText('☰')`) replayed twice but failed quality because the glyph is weak identity. Persistence therefore requires both correct execution and durable locator identity. This fixture result does not establish reliability on arbitrary applications or after UI changes.

Use one application process with local job directories: schema-validating intake, a bounded MCP step resolver, a locator gate, a fixed Playwright Test runner, and a typed evidence reporter. Keep the intelligent exploration stage separate from deterministic execution.

```text
User task -> LLM interpretation -> validated TestSpec
                                   -> bounded MCP exploration -> ordered ResolvedTestSpec
                                   -> locator parser + quality gate for every executable target
                                   -> fixed Playwright Test runner (fresh context)
                                   -> typed result + evidence
                 shared, immutable execution profile and browser-wide network policy
```

The model proposes declarative intent and permitted next exploration actions. Code owns schemas, tool policy, retry limits, locator acceptance, network policy, and result classification. The runner makes no model calls.

## Components and sequence

| Component | Responsibility |
|---|---|
| Intake | Convert the full request once into a versioned, discriminated TestSpec; reject unsupported or materially ambiguous requests. |
| Step resolver | For each authored step, use current URL, relevant prior outcomes, bounded accessibility snapshots, `browser_find`, and instruction-justified state changes. Record every state-changing prerequisite needed by replay. |
| Locator gate | Preserve exact `browser_generate_locator` text as provenance; parse an allowlisted locator grammar; verify identity, match count, and durability for every target, including prerequisites. |
| Resolved-test store | Persist the accepted ordered execution sequence, profile reference, derivation metadata, and redacted evidence references; never MCP refs or credentials. |
| Deterministic runner | Interpret the accepted sequence with Playwright Test in a fresh BrowserContext and preflight each locator binding before acting. |
| Reporter | Emit typed phase and operation results with evidence links. |

1. Resolve an immutable execution profile and enforce its network policy before creating a browser session.
2. Interpret the whole user task into a TestSpec, assign an immutable `testSpecId`, and validate it.
3. Open an isolated MCP exploration session under that profile. Resolve one authored step at a time. Give the model only that step, relevant prior outcomes, current URL, and relevant snapshot excerpts. Treat page content as untrusted data.
4. For each authored step, record any exploration-discovered prerequisite interactions in the order needed to expose its target. Request and validate an MCP locator for **each** targeted prerequisite and for the authored operation. Persist a ResolvedTestSpec only after all required operations and locators pass their gates. A prerequisite already represented by an earlier authored step is not duplicated.
5. Run that exact ordered sequence in a new isolated context under the same execution profile. Report results for each operation and the originating authored step. Never infer a missing prerequisite during execution.

Use one interpretation call plus a bounded iterative resolver/tool loop per authored step. Page snapshots cannot grant permissions, alter the TestSpec, or change the network policy. Tool errors and missing snapshot context produce typed exploration outcomes; they cannot be silently converted into a guessed locator.

## Executable prerequisite lifecycle

`TestSpec.steps` are user-authored semantic intent. `ResolvedTestSpec.executionSteps` are the ordered operations the runner actually performs. Each execution step has its own stable ID, `originStepId`, and `source` (`authored` or `discoveredPrerequisite`). A discovered prerequisite records a short reason tied to the authored instruction. For example, “Select Admin from the top-right menu” may produce a prerequisite click on the menu followed by the authored click on Admin. Both clicks need accepted locators and both appear in execution evidence. A frame is represented as locator context; entering it is not an extra click unless exploration actually needed one.

Execution steps form a single ordered list. The runner starts at the TestSpec's declared state, applies prior authored steps and recorded prerequisites in list order, and verifies each operation's expected transition or condition. A failed prerequisite stops dependent operations and marks them `NOT_RUN`; it does not turn their assertion into a QA failure. If any intermediate locator fails at runtime, the accepted resolved spec remains unchanged for evidence. Regeneration is a separate new exploration attempt that yields a new resolved-spec revision after the normal acceptance gate.

## Shared execution profile and state

An immutable `executionProfile` has an ID and version (or content digest). It contains only execution-affecting settings: browser engine, viewport, locale, applicable timezone/color scheme/device emulation, relevant feature flags, timeout policy, network-policy reference, and an authentication/storage-state **reference with its version**. Exploration, locator validation, and replay all load the same profile identity. A material profile change requires a new version and revalidation; a runner must refuse a missing or mismatched profile rather than silently use defaults.

Persist the normalized profile metadata and reference with both TestSpec and ResolvedTestSpec. Keep credentials and storage-state contents in protected storage outside specs and artifacts. Each exploration attempt and execution run records the effective profile ID/version, browser and tool versions, and any environment mismatch. Exploration sessions and browser contexts are disposable; the accepted specs and evidence references survive process restarts.

## Locator quality and persistence

The gate separately records grammar acceptance, unique match, observed-target match, and durable identity for every targeted execution step. Accept role plus accessible name, label, placeholder, meaningful text with parent/region scope, frame scope, and stable application test IDs discovered by MCP. Reject primary reliance on coordinates, DOM position, `nth-child`, incidental CSS/XPath, transient IDs, supplied hints, or glyph text such as `☰`.

The exact MCP expression is code-like untrusted text. Preserve it only as provenance; parse it into a small declarative locator form for the runner. The form supports an ordinary locator, nesting within a semantic scope, and a frame-scoped locator. Its grammar must cover the observed `locator('iframe[title="payment frame"]').contentFrame().getByRole(...)` form without allowing arbitrary CSS/XPath or arbitrary Playwright code. An iframe title or other reviewed stable frame identity may be accepted as frame context; incidental frame positions may not. Unsupported expressions fail validation.

For a locator that executes but fails quality, make one bounded alternative MCP resolution attempt using the same permitted context. If it still fails, retain evidence, block persistence, and request review or an accessibility improvement. Do not introduce a generalized selector-hints system. Immediate fresh-context replay remains separate from long-term stability.

## Deterministic execution and result isolation

Persist a structured ResolvedTestSpec and run it with a fixed, versioned Playwright Test interpreter. It contains ordered operations, validated locator forms, expected transitions/assertions, an execution-profile reference, evidence policy, and derivation links. It contains no MCP refs or executable model text. JSON is preferred to generated TypeScript for the MVP because it is easier to validate, diff, redact, and migrate. TypeScript export can be derived later.

Before each targeted operation, the runner evaluates the accepted locator in the current state and classifies the outcome by operation. For an action that requires a target, zero matches after the allowed wait yield `LOCATOR_BINDING_FAILED` with reason `NO_MATCH`; multiple matches where uniqueness is required yield `LOCATOR_BINDING_FAILED` with `AMBIGUOUS_MATCH`. For a positive target assertion (`assert_visible`, `assert_text`, or `assert_value`), zero matches yield `QA_ASSERTION_FAILED` with `NO_MATCH`, and a matched element that violates the asserted state yields `QA_ASSERTION_FAILED` with a reason such as `NOT_VISIBLE`. Multiple matches when a unique assertion target is required yield `LOCATOR_BINDING_FAILED` with `AMBIGUOUS_MATCH`. A targeted `wait_for` is synchronization, so a target that never binds by its bounded deadline yields `LOCATOR_BINDING_FAILED` with `NO_MATCH`. Malformed locator forms, unsupported semantics, frame-resolution failures, inability to evaluate a locator, and mismatches with stored identity constraints remain `LOCATOR_BINDING_FAILED`. The governing distinction is whether the runner could reliably bind and evaluate the operation target (`LOCATOR_BINDING_FAILED` when it could not) or successfully evaluated an assertion that the product failed (`QA_ASSERTION_FAILED`). Browser/environment failures, exploration-time resolution failures, and quality rejection retain their separate categories. The runner does not regenerate or replace locators. An explicit new exploration attempt is the only regeneration path.

Each result record has `phase`, typed `status`, `testSpecId`, `originStepId`, applicable `executionStepId`, `explorationAttemptId` or `executionRunId`, reason code, expected/actual values, retryability, timestamps, and evidence references. The categories are `INTERPRETATION_FAILED`, `AMBIGUOUS_INSTRUCTION`, `MCP_EXPLORATION_FAILED`, `TARGET_RESOLUTION_FAILED`, `LOCATOR_GENERATION_FAILED`, `LOCATOR_QUALITY_FAILED`, `TEST_BUILD_FAILED`, `LOCATOR_BINDING_FAILED`, `BROWSER_EXECUTION_FAILED`, `QA_ASSERTION_FAILED`, `QA_ASSERTION_PASSED`, and `OPERATION_SUCCEEDED` for actions or waits. Dependent assertions that did not execute are `NOT_RUN`. A QA failure means the intended assertion ran and was false.

Assign immutable `explorationAttemptId` on each exploration attempt and `executionRunId` on each deterministic run. Each accepted resolved-spec revision links its TestSpec ID and originating attempt ID. Every execution step and locator has a stable ID within that revision. Evidence records reference those IDs; replay cannot overwrite exploration evidence or another run's artifacts. Store the source request, normalized/resolved specs, exact generated expression, quality rationale, tool summary, versions/profile, timestamps, match count, expected/actual values, relevant snapshot excerpt/hash, and final result. Capture a final screenshot when policy allows. On failure or dispute, also keep selection screenshot, expanded snapshots, trace, and optional failure video. Redact and restrict artifacts; never retain cookies, tokens, or storage-state contents as ordinary evidence.

## Network and security boundary

Apply one browser-wide network policy to both MCP exploration and deterministic execution at the isolated browser's egress boundary, before requests leave it. Cover main-frame and iframe navigation, subresources, redirects, fetch/XHR, WebSocket handshakes, and downloads. Resolve and check destination addresses for every request and redirect, including DNS changes, so an approved top-level URL cannot load internal-network or metadata endpoints through embedded resources. Deny the run if the policy cannot be enforced consistently. URL validation at intake remains an earlier check, not the sole network defense.

Keep browser processes isolated from host files and services. Disable arbitrary browser evaluation and host commands in normal flow; disable uploads and downloads unless an explicit policy permits them. Treat webpage text as untrusted model input. Use protected named auth-state references and disposable accounts. Screenshots, traces, and page content may contain secrets and require redaction, access control, and retention limits. Detailed controls require security review before untrusted targets.

noVNC is optional observation attached to an isolated browser session. It is outside resolver and runner contracts; headless operation has identical semantics. Human intervention marks a run separately from autonomous evidence.

## Decisions, assumptions, and non-goals

Rejected for MVP: unrestricted LLM-generated Playwright source, model interpretation at runtime, acceptance based only on replay, generalized hints, silent locator regeneration, and premature microservices. Validate on real applications: snapshot coverage, semantic-locator rate, parser coverage (including frames), prerequisite replay, profile equivalence, safe repeatability, authentication behavior, injection resistance, latency/cost, artifact volume, and behavior under changed UIs. Re-run fixture regressions including Scenario 8 quality rejection. The fixture spike establishes immediate reproducibility, not production reliability.

Non-goals: product UI, noVNC-dependent execution, multi-tenant scheduling, distributed workers, database, auto-healing selectors, accessibility remediation, and production API platform.
