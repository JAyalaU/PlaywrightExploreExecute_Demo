# Deferred Action Grounding WP3A + WP3B independent gate

## Result

**Needs revision before runner-v9 implementation begins unchanged.** The trusted trace/readback and successful v9 paths passed the focused fixtures. One confirmed rejected-attempt accounting gap remains: the fresh compiler performed a successful mutation, detected later state drift, correctly withheld v9, then erased the successful execution witness from the durable rejected CompilerAttemptV4. The new independent regression fails on that contract.

The gate made no production-code changes and ran no credentialed provider workflow. Browser tests used protected loopback fixtures and mocked source/strategy extraction.

## Scope and evidence

The review covered WP1/WP2 trusted admission and witness boundaries as dependencies, SuccessfulExplorationTrace v5 assembly and HMAC storage, compiler-v4 fresh reconstruction, CompilerAttemptV4 and ResolvedTestSpec v9 parsing/storage, and historical-family isolation. The implementation paths reviewed were `app/exploration/trace-assembly-v5.ts`, `app/evidence/trace-store-v5.ts`, `app/exploration/deferred-trace-compiler-v4.ts`, `app/domain/deferred-action-compiler.ts`, and `app/evidence/deferred-compiler-store-v4.ts`.

The primary regression is the literal authored goal `Select Option 1.` with one unnamed native dropdown. The action argument remains `Option 1`, the runtime derives `runtime-1`, and a fresh v5 trace/readback compiles to accepted v9 without an authored target name. The v9 guard requires a fresh authored-label/value mapping to equal the compiler argument. A separate test proves a changed, uniquely owned DOM value can be remapped during compilation; two matching dropdowns, including one in another frame, reject before mutation. Changed `Country` ownership and durable frame drift reject; malformed, truncated, duplicate, disabled, or absent options reject.

### Trusted handoff and v9 readiness

Actual v5 assembly output is required for storage. Trace-store reads authenticate the full restricted artifact with a persistent HMAC key, revalidate the closed trace/capture and owner linkage, then issue a private readback capability. The compiler requires that actual capability. Tampered source/capture, cross-root copies, and schema-valid copied capabilities fail in the focused tests.

The compiler opens a fresh same-profile/fingerprint protected context and preserves source order, obligations, target/argument/anchor ownership, frame ancestry, labels, option mapping, exact operation/argument, action effect, VerificationGoal projection, and cleanup. Compiler code contains no source-English parsing, model call, or older-family fallback. Resolved v9 has no MCP refs or session refs as locators; its guards carry complete all-frame query bounds, unique eligible count, durable frame anchors, authored label and option ownership rules, native effect/control, exact argument policy, and source/compiler/admission provenance. Generic button/link activation, custom controls, arbitrary relationships, and verification without a supported deterministic projection reject with typed non-QA reasons.

An added child-process regression passed: it reopened the persisted v5 trace and v9 artifact in a new Node process, authenticated them with new store/readback objects, and returned accepted v9 with `runtime-1`. This demonstrates there is no reliance on the original compiler-process WeakSet state after authenticated persistence.

One packaging concern remains separate from runtime authority. `deferred-compiler-store-v4.ts` statically imports the compiler-origin checker from `deferred-trace-compiler-v4.ts`, which statically imports `mcp.ts` and therefore the Playwright MCP package and MCP SDK. `readResolvedV9` makes no MCP session or tool call; v9’s `runtimeVersions.mcp` is metadata. Still, the persisted v9 reader cannot be loaded without those packages. If runner v9 must be deployable without MCP dependencies, move the compiler-capability checker/origin token boundary into a module that does not import the exploration runtime.

### Confirmed defect: successful invocation disappears from rejected attempt

The independent regression wraps the actual protected `executePreparedGrounding` method, then injects DOM state drift on the compiler’s final protected state read after the action. It confirms exactly one execution returned `succeeded`. Compilation returns `SOURCE_CORRESPONDENCE`, issues no v9, and the attempt is persisted and reopened through the authenticated compiler store. The reopened CompilerAttemptV4 has `freshActions: []`; `executionStops` is also empty because it stores only unsuccessful invocations. The test expected the actual fresh action witness and post-effect to remain accounted for in the rejected attempt, so it fails at [deferred-action-grounding-wp3b.spec.ts](/C:/Users/Jorge/Documents/Playwright_Demo/tests/deferred-action-grounding-wp3b.spec.ts:407).

The clearing behavior is in `finalIntegrityStop` at [deferred-trace-compiler-v4.ts](/C:/Users/Jorge/Documents/Playwright_Demo/app/exploration/deferred-trace-compiler-v4.ts:131), where both `freshActions` and `executionStops` are replaced with empty arrays. The smallest correction is to preserve validated invocation/effect evidence in a rejected-attempt diagnostic field (or retain individually valid fresh witnesses) while keeping `result.status: rejected` and emitting no ResolvedTestSpec v9. Invalid witness material must still be discarded. This reduces audit and recovery risk without widening acceptance.

## Coverage and counts

The complete focused compatibility command ran **380 tests: 380 passed, 0 failed, 0 skipped** before adding the new gate assertions. It included WP3A/WP3B, WP1/WP2 prerequisites and prior trace/compiler compatibility suites.

After the independent assertions were added, the full WP3B suite ran **36 tests: 35 passed, 1 failed**. The passing 35 include the new child-process readback regression. The one failure is the confirmed durable accounting gap above. The strengthened single-case rerun also failed as expected: **0 passed, 1 failed**, with one successful protected invocation and no witness in the persisted rejected attempt.

Final typecheck and build passed after the test changes. No provider or public-browser workflow ran.

## Remaining boundaries and gate decision

Supported fresh compilation includes unnamed native select choice, Country-constrained native select, unnamed input/textarea fill, checkbox/radio activation, supported VerificationGoal projection, navigation ordering, complete all-frame uniqueness, frame ancestry, exact option ownership/value mapping, and authenticated v5/v9 storage. Generic button/link activation, custom controls, unreviewed relationships, and temporal verification without a closed projection remain intentionally unsupported.

**Runner v9 should not begin unchanged.** Preserve durable accounting for successful compiler invocations that are later rejected, and remove the transitive MCP package dependency from the authenticated v9 read path if standalone runner packaging is required. The main browser safety invariant passed: drift and ambiguity stop before accepted v9, and the accounting defect did not issue a resolved artifact.

DEFERRED_ACTION_GROUNDING_WP3_NEEDS_REVISION
