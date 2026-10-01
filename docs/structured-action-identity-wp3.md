# Structured action identity WP3

This package adds a private, version-isolated fresh compiler path:

`TestSpec v5 → SuccessfulExplorationTrace v4 → CompilerAttempt v3 → ResolvedTestSpec v8`.

It does not select this path in production, execute v8, or produce QA outcomes. The existing TestSpec v4/trace v3/compiler v2/v7 route and the released v2/v6 route remain independently readable. A v5 compilation failure has no fallback to either historical route.

## CompilerAttempt v3 and v8

CompilerAttempt v3 links the source TestSpec, exploration attempt, successful trace, profile/fingerprint, a distinct fresh session, ordered check records, verification strategy links, and action identity links. Each authored action link records its trace record, source step, requested-intent digest, selected-witness digest, and, on acceptance, resolved step ID. A rejected attempt has a typed non-QA reason, one matching failed check, and no accepted assertion or action-step links. Accepted attempts require profile, per-record ordered postcondition, fresh action identity, and representable verification checks.

ResolvedTestSpec v8 reuses the closed v7 deterministic action/verification assertion language and records `sourceSchemaVersion: "5"`, compiler attempt v3, trace v4, profile/fingerprint, and compiler runtime version `"3"`. Readback validation requires exact path order and operation, unchanged action values and VerificationGoal assertions, durable frame path, and a locator matching the structured requested intent and protected selected witness. It rejects changed scope, role, name, or prerequisite source. V8 is stored only in the `agentic-compiler-attempts-v3` namespace and is not accepted by the v7 runner.

## Fresh correspondence

The compiler opens a separate protected browser session under the admitted effective profile and reconstructs every successful path record in order. For an authored target action, it compares the `ActionTargetIntentV1` with the protected `ActionIdentityWitnessV1` and the trace binding, reconstructs a closed semantic role/name/scope/frame query, requires one complete fresh eligible match, and checks the selected target and any recorded destination. Explicit roles must match exactly. For `unspecified`, the compiler checks the same operation-specific closed role set used by WP2: click has button/link/checkbox/menuitem/radio/option; fill has textbox; select has combobox. It uses the runtime-resolved role only after establishing one eligible target across that whole set. It never guesses a role or parses the authored action sentence.

The v1 eligible-role policy is a shared closed contract consumed by protected binding, trace validation, and fresh compilation, so the compiler cannot silently broaden its role set. Frame reconstruction uses durable title/test-id anchors and fails when an anchor is missing or ambiguous. Reviewed named menu/dialog/region/row scopes must be uniquely reconstructed. Session-local MCP refs and runtime frame IDs remain correlation only.

Discovered prerequisites have no authored intent link. They compile from their own protected binding role/name/frame provenance, with a unique fresh semantic match; ambiguity or insufficient scope provenance stops compilation. They cannot satisfy the authored action or borrow its proof. VerificationGoal strategies use the existing v7 projection and fresh trusted observations. An evaluated-false strategy retains its predicate and remains non-QA at compilation. A successfully explored but unrepresentable temporal strategy remains typed compilation unsupported with no resolved artifact or QA verdict.

The new compiler imports only closed action construction, frame traversal, and wait helpers from the historical compiler. It does not call `authoredIdentity`, `authoredActionIdentityV3`, `parseAuthoredRoleNameIdentity`, or `formFor`, and does not inspect action `sourceText`. Phrase-based matching remains confined to historical artifact routes.

## Storage and next handoff

Accepted and rejected compiler attempts use immutable create-only writes and deterministic readback against the stored v4 trace and protected capture. An accepted attempt and its v8 artifact are written together. Restricted trace observations, action witnesses, and compiler checks remain private artifacts, outside stakeholder-safe projection.

The next package must add a dedicated v8 deterministic runner, then explicitly route v5/v4/v3/v8 through two separate fresh replays and version-aware ResultRecordV2 linkage. No current production workflow may silently select v8.
