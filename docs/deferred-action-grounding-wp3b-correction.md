# Deferred Action Grounding WP3B gate corrections

## Scope and authority

This correction addresses the two findings in the [WP3 independent gate](deferred-action-grounding-wp3-independent-gate.md). It preserves the [WP3B compiler/runner handoff](deferred-action-grounding-wp3b.md). The compiler acceptance criteria, full source-predicate reconstruction, deterministic v9 guard/action vocabulary, supported capabilities, historical families and production selection are unchanged. No runner is implemented here.

## Durable rejected-attempt accounting

`CompilerAttemptV4.freshActions` remains the existing closed representation of a validated fresh successful witness and retirement receipt. It records the protected final check, actual invocation, exact operation/argument and fresh post-effect. These individually valid facts remain meaningful when later compilation acceptance fails. `executionStops` continues to hold only rejected, failed or `executed_unproven` invocation accounting; it cannot contain a successful invocation and must remain empty for acceptance.

The defect was in `deferred-trace-compiler-v4.ts`'s `finalIntegrityStop`: it replaced both collections with empty arrays after final mechanical validation failed. The corrected path first fixes the result to rejected `SOURCE_CORRESPONDENCE`, validates each captured action/verification/navigation/unsuccessful-execution entry against the same source trace, fresh-session owner, profile, timestamp and closed correspondence rules, discards invalid entries, and preserves the valid entries. It validates and hashes the resulting rejected attempt again before issuing the existing private compiler capability. Full ordered-chain/final-state requirements still apply to accepted attempts. No rejected attempt produces a v9 artifact or runner readback.

The independent final-state-drift regression now persists and reopens a rejected attempt containing its actual successful text mutation, exact post-effect and attempted/succeeded execution. The final check still rejects and `readResolvedV9` still fails. An additional two-action regression substitutes a retirement proof with a recomputed digest: the invalid entry is discarded while the first valid successful invocation survives authenticated write/read. No-op, partial-failure, replacement and option-mutation regressions also persist/reopen their separate unsuccessful invocation accounting.

## Authenticated readback dependency boundary

`deferred-compiler-store-v4.ts` imports the compiler capability type only. Its write method dynamically loads the original private issuer checker; reading never imports the compiler. The compiler's private symbol, WeakSet membership and private artifact receiver remain unchanged. There is no new public issuer or JSON-to-capability factory.

V5 readback also previously dynamically loaded `trace-assembly-v5.ts` for its mechanical capture parser, pulling the exploration runtime and MCP. The unchanged capture schema/parser now lives in `app/domain/trace-capture-v5.ts`. Its successful VerificationGoal schema/digest parser is similarly moved unchanged to `app/domain/successful-verification-strategy.ts`. Original assembly and verification-controller imports remain compatible through reexports; live runtime checks and assembly origin stay in their original modules. The existing eight-observation bound is shared without changing its value.

The runner-facing dependency graph is:

```text
DeferredCompilerV4Store.readResolvedV9
  -> SuccessfulTraceV5Store authenticated v5 readback
     -> domain/trace-capture-v5
        -> domain/successful-verification-strategy + closed domain contracts
  -> domain/deferred-action-compiler + closed domain contracts
  -> Node crypto/filesystem/path + zod
```

Both restricted HMAC keys, immutable namespaces, bounded regular-file/owner checks, exact trace linkage, closed parsers and private readback issuance remain intact. Only write paths load the respective live assembler/compiler checker. `runtimeVersions.mcp` remains stored provenance metadata, not an import or execution requirement.

The strengthened unnamed-dropdown test launches a new Node process and installs resolution hooks that reject every exploration module, `@playwright/mcp` and `@modelcontextprotocol/*`. It freshly authenticates the persisted v5 trace, reopens compiler/v9, and returns accepted v9 with the exact compiler-derived value. This proves the authenticated read path requires neither MCP packages nor the original compiler-process private state. Copied capabilities, forged constructors, recomputed source/argument alterations, HMAC tampering and cross-root artifacts remain rejected.

## Validation and handoff

The strengthened WP3B suite passed **37/37, zero failures and zero skips**, in 48 seconds. The complete focused WP3 compatibility suite passed **381/381, zero failures and zero skips**, in 5.9 minutes. The latter is one combined run of the same 22 suites listed in the WP3B completion report, including all 37 current WP3B cases. The added retirement-substitution regression accounts for the increase from 380. Typecheck and build passed; the parent independently reran both on the same final implementation. The parent also independently loaded the built trace/compiler stores with all exploration and MCP resolution blocked.

The focused command was:

```text
npx.cmd playwright test tests/deferred-action-grounding-wp3b.spec.ts --workers=1 --output=test-results-wp3b-correction-final
npm.cmd run typecheck
npm.cmd run build
```

The combined command used the complete compatibility file list from [WP3B validation](deferred-action-grounding-wp3b.md#validation), with `--workers=1 --output=test-results-wp3b-correction-compat`.

Both independent-gate findings are corrected. **Runner-v9 implementation may begin with the unchanged supported-subset handoff.** The existing gate report remains a historical independent review; this report records the correction and its strengthened validation, not a new independent gate or a production release.

Protected loopback fixtures and mocked semantic extractions are used. No credentialed provider or public-browser proof is run. Generic button/link activation, custom controls, unsupported relationships and VerificationGoals without closed projection remain unsupported; these corrections add no capability. The restricted host root/key remains the durable filesystem trust assumption. Runner deployment and live browser/provider behavior require their own future validation.

DEFERRED_ACTION_GROUNDING_WP3B_CORRECTION_COMPLETE
