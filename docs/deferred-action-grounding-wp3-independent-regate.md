# Deferred Action Grounding WP3 independent re-gate

## Result

**WP3 passes; runner-v9 implementation may begin using the unchanged WP3B handoff.** The two corrections recorded in the WP3B correction report were independently exercised. A valid successful compiler action remains durably accounted for after a late final-integrity rejection, while the rejected attempt issues no v9 artifact. Invalid per-action evidence is filtered out, failed or unproven invocation accounting remains in `executionStops`, and authenticated v5/v9 reads work in a new process with exploration and MCP package imports blocked.

No production code was changed. Tests used protected loopback fixtures and mocked semantic extractions. No credentialed provider or approved-public-target workflow ran.

## Scope and independent evidence

The gate covered trace-v5 assembly and authenticated storage, compiler-v4 fresh reconstruction, CompilerAttempt v4, ResolvedTestSpec v9 parsing and storage, and historical-family isolation. The review also followed the WP1 admission and WP2 successful-witness dependencies.

The primary `Select Option 1.` case compiled from a successful trace with one unnamed native dropdown. The authored argument remained `Option 1`; fresh compilation derived `runtime-1`. The v9 artifact had a complete all-frame uniqueness guard and required fresh replay mapping to equal the compiler-derived argument.

Fresh-environment mutations behaved as specified: another eligible dropdown, including one in another frame, rejected as ambiguous; changed Country label ownership and frame ownership rejected; a uniquely owned option whose DOM value changed was freshly remapped and compiled with the new value. No exploration ref or runtime value was used as fresh authority.

The v9 and trace checks also covered unnamed fill, Country-constrained choice, checkbox/radio activation, VerificationGoal projection, exact target/argument/anchor ownership, dropped or changed obligations, execution/post-effect proof, verified cleanup, incomplete evidence, generic button/link rejection, unsupported temporal verification, authenticated tampering, and older-route isolation. Compiler code has no English-authority parsing, and compiler/readback paths do not fall back to older families.

## Corrected findings

The final-state-drift regression wrapped the protected execution method and observed one successful browser mutation, then induced drift at the final protected state read. Compilation returned a typed `SOURCE_CORRESPONDENCE` rejection, produced no v9, and the authenticated reopened CompilerAttempt v4 retained the successful invocation, exact entered value, and post-effect in `freshActions`. `executionStops` remained empty for that successful invocation; `readResolvedV9` rejected the attempt.

A second late-integrity regression substituted a retirement receipt and recomputed its digest. The malformed action entry was discarded; the earlier individually valid successful action remained persisted and reopened. Separate no-op, partial-failure, replaced-target, and option-mutation cases retained unsuccessful invocation accounting in `executionStops`, with no successful action witness. Thus invalid proof is not retained merely because the enclosing result is rejected.

The unnamed-dropdown test also launched a fresh Node process. Resolution hooks rejected every exploration module, `@playwright/mcp`, and `@modelcontextprotocol/*`; the child process still authenticated the stored v5 trace, reopened accepted v9, and returned `runtime-1`. This rules out dependency on the original process's private WeakSet state or compiler runtime during persisted readback.

The read stores keep compiler/assembler origin issuers private. Exploration-origin modules are type-only imports at the store boundary; the issuer check is dynamically loaded only by the write path. Readback performs the existing HMAC, owner, namespace, closed-schema, and trace-linkage checks before private-symbol/WeakSet capability issuance. The new-process test passed without changing those origin checks.

## Validation

- Strengthened WP3B suite: **37 passed, 0 failed, 0 skipped**.
- Full focused WP3 compatibility suite: **381 passed, 0 failed, 0 skipped** in 5.8 minutes.
- Typecheck: passed.
- Build: passed.

The combined compatibility command included the current WP3B and WP3A suites, WP1/WP2 prerequisites and independent checks, and the listed historic trace, compiler, observation, and structured-action compatibility suites. The strengthened WP3B suite was also run separately.

## Readiness and limits

Runner-v9 implementation may begin with the existing handoff: the trusted host supplies only the actual `TrustedResolvedTestReadbackV9` returned by authenticated `DeferredCompilerV4Store.readResolvedV9`. The runner must still freshly evaluate the complete v9 guards, preserve the approved profile and source order, execute only supported deterministic operations, require fresh effects, and return typed non-QA stops for drift or unsupported state.

Generic button/link activation, custom controls, arbitrary relationships, and verifications without a closed deterministic projection remain unsupported. These tests establish mocked/protected fixture behavior and dependency isolation; they do not establish live-provider semantic quality or public-browser runtime proof.

DEFERRED_ACTION_GROUNDING_WP3_COMPLETE
