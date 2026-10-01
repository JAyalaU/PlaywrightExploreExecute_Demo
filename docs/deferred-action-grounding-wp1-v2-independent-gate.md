# Deferred Action Grounding WP1 v2 independent gate

**Current result (2026-09-28): COMPLETE.** The rerun after the exact-literal provenance correction passes. The original gate finding and its failed test count are preserved below as historical evidence; the corrected path now rejects that malformed source mechanically before trusted admission.

## Scope and evidence

Reviewed the repository instructions, system overview/current status, deferred grounding decision, semantic-fidelity addendum, historical WP1 gate, and WP1A/WP1B completion reports. Exercised the new primary and independent Responses formats, adapter normalization, two-extraction orchestration, deterministic admission, v1 isolation, and trusted handoff. No production code was changed. No credentialed provider or browser workflow ran.

The independent mock captures both actual adapter requests. The independent request carries the original instruction and the source-first format; it contains neither the primary response nor trusted metadata or browser state. Both distinct formats admit a reviewed contextual choice fixture with a separately typed Country target/name, dropdown role, and context obligation. The seven required accepted examples also pass in the WP1B adapter suite. The gate's absorbed-Country case rejects after the faithful independent extraction; the historical v1 response stops at primary with one call and cannot create an admission.

## Historical violation (before correction): fabricated literal from discontiguous spans

Source: `Select Option and 1.`

In the original gate, the extraction partitioned `Option` and `1` as argument segments and classified ` and ` as neutral. It set the argument `authoredText` to `Option1`. The then-current ActionGoal v2 validator verified that the referenced segment strings concatenated to that value, so both identical extractions passed source validation and canonical agreement. `Option1` did not occur contiguously in the source, yet the pre-fix orchestration returned `accepted` with a trusted admission and a handoff carrying that changed argument.

This was a mechanical exact-literal/provenance failure, separate from the documented risk that both models can misunderstand the same English clause. The addendum requires exact literal bytes and occurrence. If the source-first extraction instead retained the contiguous authored value `Option and 1`, the pre-fix orchestration rejected the fragmented primary as `SEMANTIC_INTERPRETATION_DISAGREEMENT` after two calls. That disagreement provided semantic protection, but identical malformed drafts bypassed it.

The minimal production mitigation was to make argument provenance preserve one exact contiguous authored occurrence, including all intervening bytes. The separately documented correction implements this rule while retaining multi-span support for non-literal semantic obligations. This gate records the original defect; it did not modify production code.

## Other requested checks

- Reviewed ordinary paraphrases including `Tap Save`, `Choose Option 1 using the Country dropdown`, unnamed `Select Option 1`, and the required case set pass through mocked adapters without a production lexical patch. This proves adapter mechanics and accepted structured outputs, not real-model paraphrase quality.
- Target/argument and Email target/anchor ownership mismatches reject; the relationship fixture retains Email only as anchor. Absorbed, dropped, or neutralized Country material rejects when the independent extraction preserves the target/context obligations.
- Malformed spans, fabricated names/roles/literals, unknown executable/approval fields, invalid graph references, bounds, and closed-schema violations reject mechanically in WP1A/WP1B suites. The noncontiguous argument case above was the exception in the initial gate; the rerun below confirms it now rejects mechanically.
- Unresolved material, authored ambiguity, unsupported operations/constraints, semantic disagreement, provider/environment failures, and deadlines preserve separate stops. No fallback or extra retry occurs. The valid handoff requires the in-process trusted admission; copied admission JSON and altered/dropped obligation linkage fail.
- ActionGoal v1 and prior v5/older adapters remain separately readable and reject successor formats rather than upgrading them. The new v2 interpretation format does not acquire old-route authority.
- No other architectural violation was confirmed in the inspected WP1 boundary. WP2 grounding and production cutover remain out of scope.

## Historical validation (initial gate)

Focused command:

```text
npx.cmd playwright test tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-goal-wp1a.spec.ts tests/deferred-action-interpretation-v2-wp1b.spec.ts tests/deferred-action-interpretation-wp1b.spec.ts tests/deferred-action-interpretation-wp1-gate.spec.ts tests/deferred-action-grounding-wp1-v2-independent-gate.spec.ts tests/structured-action-identity-wp1.spec.ts tests/goal-directed-verification-wp1.spec.ts tests/openai-wire-p2-1a.spec.ts tests/openai-adapters-p2-1c.spec.ts tests/openai-responses-p2-1b.spec.ts --workers=1
```

Result: **131 passed, 1 failed, 0 skipped, 0 expected failures** (132 tests). The one failure is the normal, intentionally failing regression for identical fragmented argument extractions receiving admission. In the new independent gate alone, **4 passed and 1 failed**.

`npm.cmd run typecheck` passed. `npm.cmd run build` passed. The focused suite used mocked Responses transports with fake credentials only; no external provider or browser session was contacted.

The parent agent's SHA-256 verification confirmed all **126 production source files under `app/` and `src/` are unchanged** by this gate.

## Rerun after literal provenance correction (2026-09-28)

The prior failing regression now passes through the actual mocked adapter/admission path. For source `Select Option and 1.`, identical primary and independent drafts that assign `Option` and `1` to one `Option1` literal stop with `INVALID_SOURCE_REPRESENTATION` at primary validation after one adapter call. No second extraction, semantic admission, or trusted handoff occurs. A valid primary followed by the same malformed independent draft stops mechanically at independent validation after two calls.

Valid contiguous literals, including adjacent multi-span literals with Unicode, repeated occurrences, whitespace, and punctuation, continue through trusted admission and handoff. Ordered separated spans remain accepted for non-literal context obligations. The previous Country absorption/fidelity, neutralized or omitted constraints, target/argument and target/anchor ownership, paraphrase, malformed/fabricated source, unresolved/disagreement/no-fallback, v1/older-route isolation, closed handoff and trusted-admission checks remain green through the focused suites. The v1 and older route fixtures remain separately readable and cannot acquire v2 admission.

The exact eleven-suite focused command shown above now reports **141 passed, 0 failed, 0 skipped, 0 expected failures**. The independent gate suite itself reports **5 passed, 0 failed**. `npm.cmd run typecheck` and `npm.cmd run build` both pass. This rerun used mocked Responses transports only; no credentialed provider or browser workflow ran, and no production code was changed by the gate.

No remaining architectural violation was confirmed in the inspected WP1 source contract, adapter/admission path, compatibility boundary, or trusted handoff. The material residual risk is correlated semantic error: two extractions can agree on the same wrong interpretation. Mocked agreement verifies deterministic wiring and failure boundaries, not real-model semantic accuracy. WP2 grounding and production cutover remain out of scope.

## Historical residual risk and follow-up

The initial gate's high-priority literal provenance defect is closed by the separately documented correction. Its original evidence and counts remain above to preserve the gate history. Real-model semantic accuracy and correlated extraction errors remain unmeasured and require later authorized evaluation.

DEFERRED_ACTION_GROUNDING_WP1_V2_COMPLETE
