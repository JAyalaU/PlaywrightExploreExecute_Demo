# Deferred Action Grounding WP3A: SuccessfulExplorationTrace v5

## Result and execution boundary

This package adds an isolated, restricted trace-v5 family for TestSpec v6 / ActionGoal v2. It does not select a production workflow or implement compiler v4, resolved v9, replay, or provider/public-browser proof. Historical trace readers and production families retain their existing contracts.

The new boundary is:

```text
actual WP1 semantic-admission capability
 -> actual WP2 total endorsed mapping and protected successful witness
 -> exact private final-check/execution/post-effect readback
 -> explicit runtime binding-retirement/current-state receipt
 -> ordered action and existing VerificationGoal successful strategies
 -> WeakSet-owned assembler result
 -> isolated immutable authenticated storage
 -> separate trusted stored-provenance capability for a later fresh compiler
```

The concrete implementation modules are `app/domain/agentic-trace-v5.ts`, `app/exploration/trace-assembly-v5.ts`, and `app/evidence/trace-store-v5.ts`. Narrow additive handoffs in the grounding runtime, trusted observation session, and existing verification controller make current state and verification evidence available without converting an old-family source or action record.

## Closed serialized contract

`SuccessfulExplorationTraceV5` has `traceVersion: "5"`, an immutable complete TestSpec v6/v2 source, the original WP1 semantic-admission record, its complete obligation handoff, profile/fingerprint, attempt/session ownership, bounded timestamps, initial/final state points, ordered authored path, completed source-step IDs, and a canonical trace digest. WP1 admission/accounting digests retain their original canonical preimage; WP2 witness digests retain their original versioned preimages.

An authored action entry embeds the exact `ActionGroundingWitnessV1`, including original preparation, total endorsed correspondence, broad complete candidate facts, applicable label and option ownership, final complete predicate, reviewed operation, admitted literal or runtime-derived executable value, actual successful execution, and fresh post-effect. It additionally records the runtime-owned binding-retirement receipt. That receipt is state continuity, not a replacement execution/effect witness.

The closed action witness subset is native input/textarea fill, single native-select choice, and native checkbox/radio activation with trusted owned click delivery plus checked-state transition. Generic button/link effects, custom controls, arbitrary/spatial relationships, and pending action prerequisite/reference/relationship obligations remain unsupported. No generic click-command return, navigation, arbitrary DOM change, snapshot, or model success claim can substitute for a supported witness.

Prepared strategies, prechecks alone, rejected/failed/`executed_unproven` executions, omitted obligations, changed target/argument/anchor ownership, abandoned successful records, reused execution IDs, altered arguments, and wrong frame/state/source/profile/order cannot enter a successful action entry. Only the final successful strategy of an unchanged-state pre-dispatch retry is captured; previous preparations/rejected attempts remain outside the trace.

Prepared/final-check records occur only inside an actually successful witness's provenance. They are never standalone successful path entries.

## Live assembly and private readback

`SuccessfulTraceAssemblerV5.create` receives an actual trusted WP1 admission and the actual `ActionCandidateGroundingSessionV1`. The runtime's private receiver checks ownership, actual MCP session, attempt, profile, current source start URL, and initial state. If verification is present, the actual observer and actual verification controller must share that deferred runtime and observer instance.

The assembler calls known class prototype methods against those real receivers. Fake callbacks, object literals, overridden instance readbacks, `Object.create(prototype)`, copied admissions, and matching schema/digests cannot acquire the private slots or WP1/WP2 WeakSet authority. Each action is compared against the next private successful runtime journal entry and against exact private witness, mapping, final-check, execution, post-effect, and retirement readback. The mapping still requires its actual WP2 issued capability linked to the same actual admission.

The source step and full material correspondence remain unchanged. All entries follow authored order and a strict state chain; no first-action state rebasing absorbs unrecorded page drift or navigation. A stale retry that changes state after capture started needs a new valid source-start capture or an explicitly reviewed state-ordering mechanism. This package fails closed instead of inventing a prerequisite or hiding the drift. Finalization independently refreshes current protected state and requires all private successful actions to be represented exactly once.

An actual origin-guarded `AssembledSuccessfulTraceV5` is issued only after full trace/capture validation. The store checks its private WeakSet and known private receiver, rather than trusting `instanceof` or an arbitrary `protectedArtifact` callback.

## Explicit post-effect to current-state continuity

WP2D-B retires bindings in its existing execution cleanup by advancing the mutation epoch after post-effect capture. Its successful post-effect is historical and cannot be silently equated with the next current state. WP3A adds `ActionGroundingRetirementV1` as an explicit runtime-owned bridge, leaving the original post-effect and successful witness unchanged.

After that existing invalidation, an exclusive protected read renews the exact retained target, complete page/frame material, navigation and MCP revision, exact native effect, and native option collection/node identities where applicable. A receipt requires the identical post-effect state as its before point, exactly one housekeeping mutation/state-epoch increment, a different state digest, unchanged material and owner, exact witness/post IDs, and bounded time. It uses the existing shared execution deadline. Deadline, page mutation, navigation/revision drift, changed value/selection, option replacement, or unavailable ownership omits the receipt; a historical successful effect alone then cannot finish v5.

The meaning and reader of existing `ActionGroundingWitnessV1` remain unchanged. Historical witnesses without the new live retirement/currentness receipt stay separately readable and do not silently acquire v5 assembly authority.

Cleanup drift after receipt issuance still fails the next strict state check or final fresh proof. The retirement receipt cannot discharge any authored obligation or authorize another browser mutation.

## Verification and existing ordering

The same reviewed `SuccessfulVerificationStrategyV1`, comparison, subject/frame correspondence, completeness, temporal operand, and evaluation rules are reused. The deferred observer uses the grounding runtime's exact session/page/state/epoch domain. Its `snapshotDigest` and nested `ownerSnapshotDigest` still mean actual accessibility snapshot hashes; they do not become material-state hashes. Bounded snapshot reads are surrounded by renewed protected state checks.

The assembler captures observations at their actual committed path position and action ordinal, reads them from the real observer journal, reads strategies from the real controller journal, and proves the latest operand current at goal completion. A temporal strategy retains its earlier/later observations and exact intervening successful action record IDs. Evaluated true and evaluated false completed verification strategies retain their existing non-QA meaning.

An evaluated-false completed verification strategy records a trustworthy completed evaluation; it does not claim action success or a QA verdict.

Existing authored navigation can be recorded from its exact approved URL and fresh protected state, followed by deferred actions. Verification source dependency/order and existing present/action/absent temporal evidence remain supported. This package does not manufacture old-family prerequisite action/wait records or resolve pending ActionGoal prerequisites, references, relationships, or new preparatory operations.

## Immutable persistence and durable provenance

`SuccessfulTraceV5Store` uses only the separate `deferred-successful-trace-v5` namespace. It accepts actual assembler output, revalidates the closed trace/capture, and atomically creates one immutable attempt artifact. The capture contains only the exact successful action records and the observations/strategies used by recorded verification goals; unused, failed, rejected, retried and abandoned facts are absent.

The full namespace/owner/artifact payload is authenticated with a persistent private store authority key outside the serialized trace/capture. Reads check authentication, closed schema, exact source/capture linkage, namespace/path ownership, bounded regular files, and directory/symlink restrictions before issuing `TrustedSuccessfulTraceReadbackV5`. Reopening the same restricted store works after browser close; copying an artifact to a different store authority or a different owner path fails.

The durable trust boundary is the trusted host's restricted artifact root and private store authority key. JSON/digests alone do not prove origin. A party able to replace the host's protected key and artifacts has crossed that host/filesystem authority boundary. POSIX private modes are requested; Windows deployments must protect the root/key with the host's existing access controls. No key or restricted payload is projected to stakeholder outputs.

The stored readback capability is separately WeakSet-owned. It attests authenticated historical provenance and does not recreate WP1 semantic-admission capability, WP2 mapping capability, current browser authority, or live action permission. Pure trace/capture parsing remains integrity-only. This distinction is the new-process compiler boundary.

## Exact compiler-v4 handoff

The future compiler receives only the actual `TrustedSuccessfulTraceReadbackV5` from the trusted restricted store and obtains its checked artifact through `requireTrustedSuccessfulTraceReadbackV5`. It must preserve:

1. Complete immutable TestSpec v6/v2 source, original admission/version/extraction/accounting linkage, and all authored obligation/anchor/argument ownership.
2. Ordered successful action/verification/navigation records and initial/final state ordering.
3. Exact successful witness, original preparation and endorsed mapping, complete candidate predicates, selected ref correlation, frame ancestry, label sources, native options, exact operation, authored argument and runtime-derived value.
4. Exact protected final-check, execution, post-effect and binding-retirement receipt, matching IDs/digests/profile/session/page/frame/state epochs and time bounds.
5. Existing verification successful strategies, exact protected observation captures, goal-time freshness, temporal operand order and intervening successful action IDs.

Compiler v4 must reconstruct the whole endorsed predicate in a new protected same-profile context, independently prove fresh target/frame/label/option correspondence and effect, and derive only a reviewed closed replay representation. Old refs and runtime values are correlation facts, not durable locators or fresh authorization. It must reject nonunique/unrepresentable/unsupported correspondence without a resolved artifact, and must not parse source English to repair missing meaning. The retirement receipt explains historical epoch continuity; it is neither a replay operation nor a new effect guard. No compiler v4 implementation is included here.

## Validation

The focused WP3A suite covers all supported native witness types, exact admitted/runtime arguments, Country label correspondence, ordered verification/navigation/temporal evidence, prepared/failed/unproven exclusion, unchanged-state retry exclusion, unexplained state/navigation rejection, private receiver and WeakSet forgery, overridden readbacks, schema-valid witness substitution, cleanup-time value/material/navigation/revision drift, cleanup after receipt, receipt forgery, dropped/changed obligations, argument/frame/state/order substitution, generic witness rejection, authenticated source/namespace/cross-root/owner tamper, immutable writes and closed-session durable readback.

The full focused compatibility command passed **323 tests, zero failures and zero skips** in 4.5 minutes: the previously gated 240 WP1/WP2 cases, 33 new WP3A cases, and 50 additional historical trace/assembly/verification compatibility cases. The parent's independent WP3A rerun passed **33/33**. Final implementation and parent `typecheck` and `build` passed.

The commands use protected loopback fixtures and mocked source/strategy extraction only; no credentialed provider, approved-public-target browser, production workflow, or live-provider proof ran.

```text
npx.cmd playwright test tests/deferred-action-grounding-wp3a.spec.ts tests/deferred-action-grounding-wp2-independent-gate.spec.ts tests/deferred-action-grounding-wp2d-b.spec.ts tests/deferred-action-grounding-wp2d-a.spec.ts tests/deferred-action-grounding-wp2c.spec.ts tests/deferred-action-grounding-wp2b.spec.ts tests/deferred-action-grounding-wp2a.spec.ts tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-interpretation-v2-wp1b.spec.ts tests/deferred-action-grounding-wp1-v2-independent-gate.spec.ts tests/goal-directed-observation-wp2.spec.ts tests/agentic-current-state-wp2a.spec.ts tests/structured-action-identity-wp2.spec.ts tests/m6-mcp.spec.ts tests/goal-directed-trace-wp3b-a.spec.ts tests/goal-directed-trace-wp3b-b.spec.ts tests/agentic-trace-contracts-v2.spec.ts tests/agentic-trace-assembly-wp2b.spec.ts tests/goal-directed-verification-wp3a.spec.ts --workers=1
npm.cmd run typecheck
npm.cmd run build
```

DEFERRED_ACTION_GROUNDING_WP3A_COMPLETE
