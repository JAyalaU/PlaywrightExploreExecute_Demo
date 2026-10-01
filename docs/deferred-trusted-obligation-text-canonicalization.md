# Deferred extraction: trusted source-text canonicalization

## Failure and change

The latest authenticated live stop was in the **independent** source-first extraction. Both providers completed within the 180-second per-call and 420-second shared interpretation budgets. Full ordered source reconstruction succeeded, but ActionGoal v2 validation rejected obligation index 2 of the second step with `OBLIGATION_NOT_AUTHORED`: the model-authored obligation text disagreed with the exact text of its referenced, already-accounted source segments. No provider payload was inspected or retained for this diagnosis.

The active provider formats are now `qa_deferred_action_interpretation_v8` and `qa_deferred_action_source_first_v4`, with prompt versions `action_v2_primary_p4` and `action_v2_source_first_p4`. They preserve the original trusted instruction, ordered exact partitions, ActionGoal semantic kinds, polarity, subject/ownership, argument purpose, graph references, native expected selection, and all other semantic choices. The new closed wire omits duplicate source strings that have a unique mechanical derivation: step `sourceText`, VerificationGoal `instruction`, ActionGoal obligation and anchor `authoredText`, native option `optionLabel`, and native control-constraint `text`. Instruction, ActionGoal, decision, and native-claim accounting segments still carry exact copied source text because they form the ordered reconstruction and identify source ownership.

The trusted normalizer derives clause text from the exact instruction partition, then derives ActionGoal segments and their UTF-16 spans from the exact clause partition. It checks every obligation and anchor reference for existence, uniqueness, source order, and literal contiguity before concatenating the referenced segment text into the canonical ActionGoal v2 fields. For native verification, the uniquely classified option segment supplies the canonical label, and each uniquely indexed control segment supplies its corresponding constraint text. The unchanged TestSpec v6, ActionGoal v2, native VerificationGoal, and independent semantic-admission validators then check source provenance, reciprocal ownership, graph legality, semantic agreement, and bounds. No English parsing, substring search, trimming, fuzzy matching, semantic repair, browser facts, or model-supplied DOM values were added.

The previous offsetless v7/v3 formats and normalizers remain separately readable. Earlier spanful v6/v2 and v5/v1 readers remain unchanged. Trusted admission readback recognizes the recorded v7/v3/p3 and v6/v2/p2 native tuples; new admissions use only v8/v4/p4. There is no fallback or artifact upgrade. The provider allowlist recognizes historical identities for historical callers while the active adapter selects only v8/v4. The live-gate evidence form now lists the active identities. Deadline policy, ActionGoal semantics, grounding, execution, compiler, runner, routing, and stakeholder projection did not change.

## Validation

- Exact five-step numbered live source, including both public URLs, link, native choice, and selected-option verification: two mocked provider extractions and trusted semantic admission preserve the source and canonical obligation/option text.
- Malformed or duplicate graph references, noncontiguous literal refs, unknown owners, injected duplicate text, malformed source partitions, and native claim-index errors reject mechanically. A text-exact but semantically wrong Country/argument ownership reaches the independent semantic gate and rejects there.
- Unicode/UTF-16 boundaries, CRLF, repeated text, punctuation, option/control text, closed schema, previous-reader isolation, and old-route compatibility remain covered.
- Seven focused interpretation, source, diagnostics, WP1 gate, WP5A integration, and native verification suites: **125 passed, 0 failed**. A final test-only TypeScript narrowing change was followed by an **8/8** focused rerun.
- Final `npm run typecheck` and `npm run build` passed.

This is offline contract and mocked integration evidence. A separately approved real-provider/public-target run is still needed to determine whether provider output follows v8/v4 on the live task. A model can still propose a text-exact but semantically wrong segmentation; independent semantic admission remains the boundary for that risk.

The later [reciprocal ownership canonicalization](deferred-reciprocal-ownership-canonicalization.md) supersedes v8/v4 as active provider identities while retaining these readers separately.
