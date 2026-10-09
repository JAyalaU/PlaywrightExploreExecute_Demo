# SuccessfulExplorationTrace v3 assembly and persistence (WP3B-B)

This is a private assembly path. Production remains on trace v2, compiler v1, resolved v6, and two fresh deterministic replays. No v3 artifact is routed into the v2 compiler or public result/projection path.

## Protected assembly flow

`SuccessfulTraceAssemblerV3` is created for one TestSpec v4, current-state exploration owner, WP2 observation session, and WP3A successful-strategy journal. It subscribes to WP2 runtime record creation before verification starts. The capture hook records each complete evidence-grade observation with the exact runtime record, successful-path position, action ordinal, and separate action-path digest. It rejects observations if the current-state journal has not reached that path state. WP2's own state digest and epoch remain in the WP2 record; these hashes represent different state domains.

Actions are appended only from the current-state successful action journal and retain v2 protected frame bindings. Navigation and other observed records require a live current-state snapshot check; navigation URL and snapshot digest must match protected browser state. Verification entries are copied only from a successful WP3A strategy. At append time, the assembler reads every operand from WP2's runtime-owned record map, checks the witness, requires the latest operand to pass `currentEvidence()`, and checks the current path state. It then invokes the v3 domain validator at finalization, which independently recomputes the comparison and verifies goal intent, frame/scope provenance, source linkage, state/order, and conclusion.

Finalization requires the complete current-state action journal and exactly the successful WP3A strategies used by the path. The v3 validator requires every authored step exactly once and in order. Cancellation, budget exhaustion, failure, or an aborted signal prevent finalization. An evaluated `unsatisfied` verification is valid exploration content; it is never a QA verdict. `unresolved` and `unsupported` produce no successful strategy record and cannot complete the path.

For temporal `appears` or `disappears`, the earlier observation remains a historical protected fact. The latest observation must be current at goal completion. The v3 record names every changed-state path record between their capture positions; the validator requires matching query, session/page/frame/scope, epoch and time ordering, and an advancing successful action ordinal. Ordinary final-state comparisons cannot use historical operands.

## Immutable storage and readback

`LocalArtifactStore.writeSuccessfulExplorationV3` accepts only opaque `AssembledSuccessfulTraceV3` output and revalidates it against the stored TestSpec and effective profile. It atomically creates one JSON artifact under `agentic-explorations-v3/<attempt>.json` with attempt, trace, and a restricted `ProtectedTraceCaptureBundleV3`. The bundle contains only observations used by successful strategies, successful strategy records, and goal-time freshness attestations. It excludes snapshots, errors, abandoned attempts, provider output, and recovery branches. The artifact also contains digests linking source, attempt, trace, and capture bundle; duplicate writes fail.

Readback requires the private job artifact, checks those digests and the effective profile, reconstructs the protected lookup from the stored capture bundle, independently verifies each WP2 witness preimage, and invokes the full v3 validator. The trust anchor for historical readback is the trusted runtime-only write path and the private immutable artifact directory. The JSON digests alone are correlation and accidental-tamper checks, not an external signature. Any environment that allows an attacker to rewrite private artifacts needs an additional authenticated storage layer before treating readback as trusted.

The existing `writeSuccessfulExploration` and `readSuccessfulExploration` methods continue to accept only v1/v2. V3 has separate methods and storage. Compiler v1 continues to call the v1/v2 read path only.

## Handoff

The future production orchestration must instantiate this assembler before WP3A issues observations, append each protected navigation/action fact immediately in authored order, append each evaluated verification strategy before the next mutation, and pass the trusted cancellation/budget state. It may then persist only a finalized v3 artifact. Fresh deterministic compilation must define its own v3 consumer and prove each strategy in a new protected context; no QA verdict is available from this package.
