# Phase 3A — Context-aware requirement intake and clean verification

**Status:** Implemented offline; initial held-out real-model intake attempts failed, and the intake boundary has been corrected for an operator rerun.  
**Date:** 2026-10-07

## Intake after the first observation

`runAdaptiveVerticalSlice` now accepts the immutable `TaskEnvelopeV1`, the existing `ReasoningModel`, trusted reset, browser factory, and trusted budgets. It accepts no caller-supplied ledger or acceptance rules. The controller resets the application, opens the protected browser, and obtains the initial accessibility/DOM observation before calling the model's bounded `interpretRequirements` method. That method returns a requirement ledger and a small acceptance plan. It does not choose navigation steps or locators. The same model later proposes individual browser actions; there is no second planning agent.

Each ledger goal repeats an exact substring and source span from the original instruction. Validation requires distinct goals for the substantive clauses, full authored-text coverage, exact task/digest binding, and unique goal IDs. Explicit required actions, outcomes, assertions, and constraints stay separate. Inferred prerequisites and unresolved questions are recorded separately and cannot become authored success criteria. Model-supplied fulfillment or evidence claims are rejected. The task instruction is never rewritten.

The plan may initially mark a predicate as a hypothesis. URL/path and named-control predicates become grounded only after a trusted browser observation supports their target. Following an action, the controller may call the same intake method for at most two bounded refinements when a goal needs more context. A refinement must retain every authored goal's ID, kind, text, and span; it cannot replace a grounded predicate or action obligation. A goal without a safe observable predicate remains `needs_refinement` and inconclusive. This preserves uncertainty instead of manufacturing an assertion.

## Closed acceptance vocabulary

| Predicate | Evidence used |
|---|---|
| Exact URL or path | Current clean URL |
| Element existence | Bounded named role/control observation |
| Element count | Complete bounded control enumeration |
| Visibility | Observed control and viewport box |
| Enabled/disabled | Observed enabled state |
| Checked/unchecked | Observed checked state |
| Input value | Observed bounded value |
| Required action | Delivered clean action, actual target witness, before/after observations, and observed transition |
| Required order | Dependency action must precede the required action in clean evidence |
| Forbidden action | Complete clean action sequence contains no matching operation and target |

The browser marks whether the control enumeration is complete. Exact counts and negative existence cannot pass from a truncated list. Predicates are typed data; the model cannot submit arbitrary JavaScript or a custom assertion. Browser operations remain the existing bounded click/check/uncheck/navigation mechanics for this slice.

## Independent clean verification

The verifier receives the validated intake plan, clean observation sequence, and clean action evidence. Outcomes and assertions use the final clean observation after reload. An explicit required action uses its linked authored goal, operation, target witness, source observation, resulting observation, and actual state transition. Its predicate must be proven false before the action and true afterward; an unknown before state cannot establish causality. The witness is checked against the source observation. A visual coordinate must map to one observed control and its learned visual anchor. Ordering dependencies must have prior clean action evidence. Typed forbidden-action and standalone required-order constraints inspect the complete clean action sequence. A final checkbox state alone, model completion claim, unbound target, stale observation, missing action, or incorrect order cannot produce `VERIFIED_PASS`. When a causal requirement cannot be proved, its coverage is inconclusive.

Clear authored cues such as “never,” “do not,” “then,” and “in order” are validated at intake so a model cannot relabel a prohibition as an ordinary outcome or ordering constraint, or omit an explicit predecessor. A clear prohibition with an identified operation must use a forbidden-action constraint or remain unresolved without a competing constraint. This is a narrow fidelity check, not a claim to understand every form of natural-language constraint.

The reset provider and local fixture oracle remain trusted test machinery. Their state is not included in model intake, action context, acceptance predicates, or browser observations. The new Activity and Profile → Security fixture families use different original instructions from the notification A/B/C regressions. The hidden oracle is a closure, with no browser route; tests consult it only after the adaptive run.

## Regression and held-out evaluation

Offline tests cover A/B accessible navigation, C screenshot-based visual discovery and fresh clean re-identification, the new Activity and ordered Security task families, authored-clause omissions, invented goals, unsupported predicates, self-report, incomplete count/absence evidence, wrong target witnesses, forbidden actions, missing actions, wrong ordering, unknown before states, reset failure, and false final state. The existing semantic-general route was not changed.

Validation after the fidelity audit: **51 focused adaptive tests passed, 3 opt-in live tests skipped**; default `npm test` **214 TypeScript tests passed, 3 opt-in live tests skipped, and 32 Python tests passed**. `npm run typecheck`, `npm run build`, and `git diff --check` passed. These checks used offline models and made no provider calls.

The next held-out real-model evaluation is defined in `tests/adaptive-phase3a-heldout.spec.ts` and is **not run by default**. It contains two previously unused instructions:

1. `Visit Activity. Confirm that the browser path is /activity.`
2. `Open Profile; choose Security; switch on Login alerts; verify that Login alerts stay checked.`

The model receives only each authored instruction and current browser observations. The harness supplies trusted origin, reset, and fixed budgets: eight browser actions, fifteen observations, two screenshots, ten exploration model turns, a 150-second total deadline, and the adapter's 45-second per-request timeout with zero retries. It requires `ADAPTIVE_PHASE3A_HELDOUT_LIVE=1`, `ADAPTIVE_LIVE_MODEL`, and an available `OPENAI_API_KEY`. From normal Windows PowerShell, the one-shot operator command is:

```powershell
$env:ADAPTIVE_PHASE3A_HELDOUT_LIVE='1'
$env:ADAPTIVE_LIVE_MODEL='gpt-6.1-sol'
npx.cmd playwright test tests/adaptive-phase3a-heldout.spec.ts --workers=1 --retries=0 --reporter=line
```

Run once per task after confirming provider configuration. The local environment must make `OPENAI_API_KEY` available to Node; do not print it. Record intake calls, model proposals, browser actions, reset proof, clean state, coverage, and phase timings. Do not change the implementation between the two live tasks. No real-model Phase 3A success is claimed by the offline tests.

## Real-model intake boundary correction

The initial connected held-out attempts stopped before any operational proposal or browser action. Activity returned a ledger with `goals` in place of `authoredGoals`, failed runtime schema validation, and ended `BLOCKED`. Security's first intake request timed out after approximately 20.3 seconds and ended `ENVIRONMENT_FAILED`. Neither task established a clean pass.

The Activity mismatch came from the adapter request: its prose referred to authored goals without naming the `ledger.authoredGoals` key, it requested generic JSON-object mode rather than a schema, and it cast parsed JSON to `RequirementIntakeV1` without local shape validation. The runtime ledger contract already required `authoredGoals`; `acceptancePlan.goals` is a different, valid field. The adapter now derives a strict provider JSON schema from the same Zod intake contract used to parse the response. The request names both fields explicitly. Strict-output optional fields are represented as required nullable fields on the provider wire; only declared optional null fields are removed before canonical Zod parsing. There is no `goals` alias for the ledger. The controller's existing intake validation still binds exact source spans and digest, checks authored-clause coverage and classifications, rejects invented or omitted obligations and unsupported predicates, and preserves action ordering.

The approximately 20-second stop came from `OpenAIAdaptiveReasoningModel`'s former 20,000 ms SDK timeout, independently of the controller's 150,000 ms overall deadline. The adapter default is now a bounded 45,000 ms per request, with zero SDK retries. It maps an SDK request timeout to `MODEL_REQUEST_TIMEOUT` and an externally aborted request to `MODEL_REQUEST_ABORTED`. An optional caller signal reaches the SDK; the current vertical slice does not supply one, so an in-flight request may finish after the overall deadline before the controller checks it. The controller's total deadline, model-turn and action limits, and failure behavior are unchanged. The provider-facing strict schema is verified offline, but live provider acceptance of it remains to be established by the operator rerun.

Post-correction offline validation: **57 focused adaptive tests passed, 3 opt-in live tests skipped**; default `npm test` **220 TypeScript tests passed, 3 opt-in live tests skipped, and 32 Python tests passed**. Typecheck, build, and `git diff --check` passed. Mocked provider cases cover valid Activity and ordered Security ledgers, source spans, omitted and invented obligations, wrong classifications and predicates, a virtual response at 20,001 ms within the 45,000 ms request limit, real request timeout, and caller cancellation. No OpenAI call occurred during this correction.

## Limits

The clause validator preserves provenance and prevents easy omission, but deterministic code cannot prove semantic equivalence for arbitrary prose. Ambiguous intent or properties outside the closed predicate vocabulary remain unresolved. Browser observation is limited to the main frame and bounded controls; exact count/absence needs complete enumeration. There is no unrestricted clean recovery, new operation family, generated Playwright source, general browser memory, or new persistence layer. Phase 2 visual grounding and the semantic-general product route remain unchanged.
