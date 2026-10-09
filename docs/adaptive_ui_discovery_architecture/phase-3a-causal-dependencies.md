# Phase 3A causal dependency verification

**Scope:** Offline correction of the adaptive requirement intake and independent verifier. No provider, public-site, or live acceptance run was made. The semantic-general product route is unchanged.

## Original defect

The controlled case supplied a predecessor click receipt with returned delivery, an `observedEffect`, and before/after observation IDs. Its target witness named a control absent from the before observation, so the predecessor goal was inconclusive. The dependent checkbox action named that goal in `afterGoalIds`. Its own evidence was valid, and the old dependency branch accepted the earlier receipt using goal ID, delivery, effect-field presence, and observation index without proving the predecessor. It marked the dependent goal `verified_true` despite the invalid witness. The same verifier is called for exploration progress and for independent clean verification, so the flaw affected both evaluations. Exploration evidence still cannot substitute for clean evidence at final verification.

## Causal invariant and evidence

An authored required-action dependency is satisfied only by an earlier action that independently proves its own admitted goal. The verifier checks goal attribution, operation, returned delivery, target witness against the before observation, matching URL and document revisions, before/after observation order and single-session lineage, an observed effect, and an admitted predicate changing from false to true. A successful action API return or a correct final state alone is insufficient. Opening a menu can be proved by a newly observed control; navigation by a path or URL change; and checking a box by an observed false-to-true checked state. Each operation uses its admitted predicate rather than a common hardcoded transition type.

The proof check now recursively validates every `afterGoalIds` predecessor and requires its completed observation to precede the dependent action's source observation. A broken link leaves dependent required actions and required-order constraints inconclusive. Verification uses only the observations and actions passed for that evaluation; final clean coverage receives the clean executor's history. A mixed-session observation history cannot produce verified coverage.

Intake permits dependency IDs only for authored required-action goals and rejects self references and cycles. Inferred prerequisites remain ledger hints for procedure discovery, not independent authored acceptance obligations. An intermediate action can make a control available for a later required action; that availability is visible in the later action's clean before observation, and the learned procedure can replay the intermediate step. The intermediate receipt does not itself become an authored goal or satisfy an `afterGoalIds` obligation. An unrelated exploratory receipt does not invalidate an otherwise proved sequence, and it cannot replace a required predecessor.

## Offline regression evidence

The focused boundary suite covers a valid two-step dependency and a three-step menu expansion, navigation, and checkbox chain. Negative cases cover missing menu, navigation, or checkbox action; invalid target witness; wrong operation or goal; missing observed effect; unknown before state; reversed action order; and a cross-session chain. It also covers an unrelated exploratory receipt alongside a valid chain, intake rejection of non-action, inferred, and cyclic dependency IDs, and required-order verification when a predecessor is invalid. A correct final checked state remains insufficient when a mandatory action is missing.

Validation results: **31/31 focused causal-boundary tests passed**; adaptive regressions **78 passed, 3 opt-in live tests skipped**; `npm test` **241 TypeScript passed, 3 opt-in live skipped, 32 Python passed**; typecheck, build, and `git diff --check` passed. No provider or public-site call was made.

## Remaining limits

This is a closed observable-predicate proof, not proof of arbitrary hidden application side effects. When target identity, before state, or effect cannot be established from the available browser evidence, the required action remains inconclusive. Inferred navigation steps may contribute to a learned procedure, but their ledger descriptions alone do not grant acceptance coverage. Live model behavior is outside this offline task.
