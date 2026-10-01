# Structured action identity WP2

TestSpec v5 authored `click`, `fill`, and `select_option` actions now have a private protected-browser binding path and an immutable SuccessfulExplorationTrace v4 path. This package does not route v5 into production compilation or replay. TestSpec v4/trace v3/compiler v2/v7 and the released v2/v6 route retain their existing namespaces and behavior. There is no v5 fallback to a phrase-based action binding or trace v3.

## Runtime action identity

`ActionIdentityWitnessV1` is a closed, versioned protected-runtime fact created at `CurrentStateExploration.bind` before an authored action executes. It links the exact `ActionTargetIntentV1`, step and operation to the selected ref, trusted role/name, complete eligible match count `1`, selected-reference equality, reviewed scope/frame ownership, attempt/session/page/profile, snapshot and mutation epochs, state digest, timestamp, and a digest over the complete witness payload. The action path checks the current snapshot and repeats the semantic identity/count/ref proof immediately before acting. A model may supply only a candidate current ref through the existing action decision; it cannot submit witness fields.

Binding uses fixed `getByRole` exact accessible-name queries, including hidden matches for the identity count, within one proven page/frame/scope. A selected ref must be the sole eligible target. The action itself still requires visibility, enabled state, and the existing operation-specific actionability checks. Zero matches, multiple matches, a different selected ref, stale state, or unresolved scope/frame ownership stop exploration without QA classification. Nested frames require the reviewed unique durable title/test-id ownership path; authored v5 frame hints are currently exact title constraints. Non-frame menu/dialog/region/row scopes require one exact semantic scope. No arbitrary selector, JavaScript, or model-supplied runtime identity enters this path.

The initial **unspecified-role** eligibility policy is deliberately closed and operation-specific:

| Operation | Eligible semantic roles |
|---|---|
| `click` | `button`, `link`, `checkbox`, `menuitem`, `radio`, `option` |
| `fill` | `textbox` |
| `select_option` | `combobox` |

For an unspecified role, protected binding counts exact-name matches across **all** eligible roles in the applicable scope/frame and requires a total of exactly one. It does not favor links, buttons, or DOM order. Explicit role must be in that operation's eligible set and must have one exact match. The existing native-select and editable checks still apply.

## Prerequisites and trace v4

Discovered prerequisites retain separate `discoveredPrerequisite` source, reason, current-state binding, selected-node and frame provenance. They never receive an authored `ActionIdentityWitnessV1` or `ActionTargetIntentV1` and cannot complete the authored step. A prerequisite that opens a menu can remain in the successful ordered executable path, followed by the separately witnessed authored action.

Trace v4 keeps the ordered v3 action/VerificationGoal path and adds `actionIdentityProofs`: one `{ recordId, requestedIntent, selectedWitness }` for every authored target action. The private `ProtectedTraceCaptureBundleV4` stores the corresponding runtime-owned witnesses separately from failed/abandoned branches. Assembly compares each action with the protected journal and re-reads its witness from `CurrentStateExploration`; it does not accept controller-provided witness objects. Final validation checks exact step accounting and order, binding reuse, state chain, operation, requested/selected role and name, reference equality, frame/scope, attempt/session/page/profile, time, witness digest, and capture linkage. VerificationGoal records retain v3's observation and strategy validation. A successfully evaluated `unsatisfied` goal remains exploration evidence, not QA failure.

The store accepts only an `AssembledSuccessfulTraceV4`, writes one immutable envelope in `agentic-explorations-v4`, then validates deterministic readback against TestSpec v5, the profile, trace, protected capture, and artifact digests. Restricted diagnostics remain separate. The v4 proof-read API is the handoff for a future fresh compiler; no current compiler or runner consumes v4.

## Remaining compiler handoff

Compiler v3 must read the accepted v4 trace and protected proof, replay the action path in a **fresh** protected context, reconstruct exact structured role/name/scope/frame identity, and verify fresh unique target correspondence. It must derive ResolvedTestSpec v8 without calling the authored-English phrase parser. The runtime frame ID and MCP ref are session-local correlation only and must not become durable deterministic identity.
