# Goal-directed compiler artifact contracts (WP4A)

WP4A defines private `CompilerAttemptV2` and `ResolvedTestSpecV7` contracts. It does not start a fresh browser, compile a trace, dispatch v7 to a runner, or produce QA results. Released compiler v1, resolved v6, trace v2, and legacy resolved versions remain separate.

## Compiler attempt v2

`CompilerAttemptV2` identifies TestSpec v4, exploration attempt, successful trace v3, execution profile and fingerprint, compiler attempt, and a distinct fresh compiler session. Its bounded strategy links identify each verification trace record, goal step, successful strategy digest, ordered observation IDs, and an assertion step ID only on acceptance. Closed checks cover profile equivalence, path order, action identity, strategy correspondence, fresh observation, and deterministic representation. Acceptance requires every path record's ordered check, every verification record's strategy/freshness/representation checks, and existing v6-style targeted-action checks. A rejected attempt carries a typed non-QA reason, failed trace record, and matching failed check; it creates no resolved artifact.

The contract validates ownership, timing, linkage, coverage, and check/result consistency. A check's `passed` claim is **not** a browser attestation by itself. The future protected compiler runtime must produce and authenticate those checks in a new context before the accepted artifact can be trusted.

## ResolvedTestSpec v7

V7 keeps the v6 closed action and wait forms. A `verification_goal` step has an exact source goal and trace record link plus one `DeterministicVerificationAssertionV1`. The initial assertion algebra is:

* complete semantic query count with `equal`, `greater_than`, `at_least`, or `at_most` and a bounded nonnegative literal;
* uniquely re-established semantic target boolean property (`visible`, `enabled`, `checked`, `expanded`, `selected`);
* uniquely re-established target `text` or `value` with exact or contains comparison;
* current URL exact or the reviewed terminal `/*` prefix pattern.

Semantic queries use the exact WP2 closed role, accessible name, frame path, and within-scope structure. There are no arbitrary selectors, executable expressions, visual-order operators, or general logical trees. Conjunction is deferred because the currently reviewed successful strategy has one typed comparison; adding conjunction without a source strategy would enlarge the replay language without preserving a demonstrated meaning.

The v7 validator requires a protected-source validated v3 trace and accepted compiler v2. It maps each v7 assertion exactly from the source strategy's typed comparison and observation request. This preserves role, name, scope, frame, polarity, property, operator, and literal. In particular, absent maps to count `== 0`, present maps to its original count comparison, and exact three cannot become at least one. A hidden but present element remains a count assertion when the strategy was about presence. An observed `unsatisfied` strategy still compiles the **requested** comparison; the false exploration result does not invert it or create a QA verdict.

Existing v6 action safeguards are retained for v7: targeted binding, proven frame ownership and exact frame path, unique locator IDs, wait locator-condition consistency, and the digest of the candidate locator matching passed closed-form, identity, uniqueness, and selected-target checks. The runner must still independently execute accepted v7; the schema alone gives no QA authority.

## Unsupported strategies and handoff

Temporal `appears`/`disappears` strategies are not representable by this initial algebra. Their earlier observation, intervening action, and later observation cannot be preserved by a final-state assertion. Compilation must return `UNSUPPORTED_TEMPORAL_REPLAY` with no v7 artifact. Visual or spatial relationship semantics remain unsupported; no DOM-order substitution is allowed. Other unrepresentable strategies use typed `UNSUPPORTED_REPRESENTATION` or `UNSUPPORTED_RELATIONSHIP`, as applicable.

The fresh compiler work package must read the immutable v3 artifact through protected readback, create a separate protected browser session with the same effective profile/fingerprint, reproduce each action and verification observation strategy in order, generate authenticated checks, and emit v7 only if every strategy has an exact reviewed projection. It must stop compilation without QA classification when projection is unsupported or fresh correspondence fails. A later v7 runner must execute only the accepted closed artifact in two fresh deterministic replays before authoritative QA classification.
