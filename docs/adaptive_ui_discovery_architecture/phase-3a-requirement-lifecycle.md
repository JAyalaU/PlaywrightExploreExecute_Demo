# Phase 3A requirement lifecycle and verification feedback

**Scope:** Offline correction of requirement admission, model-visible verification feedback, and bounded diagnostics. No provider or public-site call was made for this change. The adaptive vertical slice remains separate from the semantic-general product route.

## Previous conflation

The prior `predicateGrounded` rule treated a URL/path predicate as grounded only after an observation equaled its expected value. For a valid `/activity` assertion at the initial `/` page, this equated the ability to inspect the path with the path already being correct. Intake could reject a model's `grounded` claim, and a destination never reached could remain inconclusive instead of evaluating false. Verification checks were computed by the controller but the next model proposal lacked their observed value, acceptance match, and progress result.

## Requirement lifecycle

An authored goal first passes source-span, clause-coverage, vocabulary, and predicate-shape validation. A validated predicate's grounding state then records whether the current browser evidence can inspect the property and identify its target. Its observed value is independently `true`, `false`, or `unknown`. Completion depends on trusted exploration and clean evidence, including action proof when required. A valid, origin-scoped URL or path predicate is evaluable when the browser exposes its current URL, even while the expected destination is pending. Controls that appear after navigation may remain hypotheses and be promoted using later trusted observations. Unsupported properties and incomplete observations remain unknown. Exact count and absence still require a complete bounded DOM observation. Model-supplied status is checked against these facts and cannot issue completion.

## Verification feedback and progress

The controller sends bounded structured feedback on the next `ReasoningModel.propose` call. It identifies the goal and verification predicate, observed `true`/`false`/`unknown`, acceptance match, missing action or ordering evidence, whether new evidence was obtained, progress before and after, and a closed reason when progress did not advance. The model may use this receipt to choose an action or check; the controller and independent verifier continue to determine completion from browser and action evidence. Repeated equivalent true observations are not fresh progress. The existing bounded ineffective-verification stop remains; feedback reaches a subsequent proposal before that stop when the budget permits.

## Diagnostic projection

The diagnostic projection is explicitly opt-in through the vertical-slice `diagnostics` option. It contains bounded validated goals and predicate states, proposal kind with goal and observation IDs, gateway decision, executed action and a coarse observed-effect kind, verification result and progress reason, and the first terminal failure. Predicate identities use stable hashes so the projection does not retain expected URLs, control names, or values. It excludes provider reasoning, raw prompts, page content, screenshots, credentials, and private model payloads. Diagnostic collection is observational and does not grant QA authority or change execution outcomes.

## Causal verification findings

The clean verifier requires a same-goal operation, current target witness, returned delivery, before/after observation lineage, observed effect, and a false-to-true predicate transition. Opening a menu can be proved by a newly available named control after the click. Navigation can be proved by a URL/path transition after a witnessed action. A checkbox action requires an observed unchecked-to-checked transition; an already checked final state alone does not prove the action. Ordering depends on prior action evidence and observation order. A later assertion checks the resulting state independently, including after reload where applicable. The action-proof rule was not weakened in this phase.

A controlled unit test in `adaptive-phase3a-boundary.spec.ts` demonstrates one separate general defect: a predecessor receipt with returned delivery, effect, and lineage but an invalid target witness leaves that predecessor inconclusive, yet can satisfy a dependent action's `afterGoalIds` check. The dependency branch currently checks the predecessor receipt shape without proving its goal. A separate correction should require proven predecessor goals while preserving the current witness and false-to-true action requirements. This finding does not establish that the earlier Security live attempt encountered this case; its action receipts were not retained.

## Offline regressions and remaining limits

The final focused lifecycle and feedback suite passed **24/24**. The adaptive regression run passed **64**, with **3 opt-in live tests skipped**; the final added repeated-true check was also covered by the later focused and full runs. `npm test` passed on its second run: **228 TypeScript passed, 3 opt-in live skipped, 32 Python passed**. `npm run typecheck`, `npm run build`, and `git diff --check` passed. The first full run had three timeouts outside adaptive code (local frame navigation, semantic runner checkbox replay, and semantic compiler receipt validation); all three affected suites passed in an 85-test single-worker rerun, then the complete default suite passed. No provider or public-site calls were made. Live-model acceptance is not established by these tests. The vertical slice still has a bounded predicate vocabulary, main-frame control observation, and conservative action proof; unsupported UI properties remain unresolved.
