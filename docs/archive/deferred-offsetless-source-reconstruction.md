# Deferred extraction: exact ordered source reconstruction

## Change and boundary

The live interpretation stop with primary `SOURCE_ACCOUNTING_INVALID / SPAN_OR_LITERAL_MISMATCH` at instruction-accounting item 2 could not distinguish a bad model-computed UTF-16 offset from a text mismatch. The provider had completed in 57,481 ms; this was a structural source-validation stop, not an extraction deadline. This change removes offset arithmetic from the active deferred semantic provider formats. No credentialed provider or public browser workflow was run to claim a live outcome.

The active primary provider format is now `qa_deferred_action_interpretation_v7`; the independent source-first format is `qa_deferred_action_source_first_v3`. Both receive the original trusted instruction as before. Their closed schemas contain ordered exact text partitions, semantic classifications, ownership references, and obligation references, but no model-authored `sourceSpan`, `sourceInstructionSpan`, or `optionSourceSpan`. The source-first call still receives neither the primary extraction nor browser state.

The normalizer reconstructs each full instruction from ordered `instructionAccounting.authoredText` segments using a cursor. Each clause must exactly match the corresponding step's `sourceText`, ID, and order. Within an ActionGoal v2 clause, `sourceAccounting` reconstructs the entire clause. Within a native option verification clause, `claimAccounting` reconstructs the entire clause and assigns exactly one option occurrence and each accepted control constraint to its indexed text occurrence. Authored ambiguity and unresolved decisions use an ordered full-instruction `sourcePartition` for evidence. All whitespace, punctuation, CRLF, repeated text, and UTF-16 surrogate pairs remain part of the exact comparison. The trusted normalizer derives canonical half-open UTF-16 spans from the cursor, then passes the result to the unchanged TestSpec v6 / ActionGoal v2 / native verification mechanical validators and two-extraction semantic admission. It does not search for matching substrings, trim, case-fold, repair text, or infer semantics from browser state.

The previous spanful `qa_deferred_action_interpretation_v6` and `qa_deferred_action_source_first_v2` wire readers and their canonical normalizers remain separately available for old records. The older v5/v1 provider readers also remain. New provider output cannot enter those formats by fallback, and old spanful output is rejected by the v7/v3 schemas. Authenticated admission readback accepts the recorded previous native-option version tuple without upgrading it. No ActionGoal semantics, grounding, execution, replay, routing, or deadline policy changed.

## Validation

- The exact five-step numbered live instruction, including both public URLs, the Dropdown link clause, native choice, and selected-option verification, survived both mocked semantic extractions and admission byte-for-byte. The test made no public browser or credentialed provider call.
- The focused reconstruction suite covers Unicode/UTF-16 boundaries, CRLF, repeated literals, punctuation, native claim ownership, decision evidence, malformed/omitted/reordered/duplicated/empty segments, injected offsets, old-reader isolation, and a text-exact but semantically wrong Country/argument interpretation that reached independent semantic comparison.
- Seven affected interpretation, source, structural-diagnostic, WP5A integration, and native-option suites passed: **122/122 tests**. The final test-only schema assertion was followed by a focused reconstruction rerun: **5/5 tests**.
- `npm run typecheck` and `npm run build` passed on the final tree.

Remaining external check: only a separately approved real-provider run can establish whether the new format prevents the specific live structural stop with provider-produced output. The offsetless contract deliberately still rejects any non-exact partition; two extractors that agree on a text-exact but wrong semantic interpretation remain subject to the existing independent-admission risk.

The later [trusted source-text canonicalization](deferred-trusted-obligation-text-canonicalization.md) supersedes v7/v3 as the active provider identities while retaining these readers for historical compatibility.
