# Deferred Action Grounding WP1 v2 literal provenance correction

The exact-literal defect recorded in the [independent gate](deferred-action-grounding-wp1-v2-independent-gate.md) is fixed. ActionGoal v2 argument provenance must now describe one contiguous authored occurrence. Ordered multi-span literals remain valid only when each span starts exactly where the preceding span ends; existing exact segment and literal comparisons then prove that no intervening source text was omitted or normalized.

The production change is confined to `app/domain/action-goal-v2.ts`, where `validateActionGoalV2` validates the source draft before semantic admission. Its shared provenance helper applies the additional adjacency check only to argument obligations. Non-literal semantic obligations retain ordered, separated spans. The serialized schema, extraction behavior, canonical agreement, older readers/routes, production workflow selection and future WP2 boundary are unchanged.

The independent gate regression now passes as a normal rejection test. Identical fragmented drafts stop structurally at primary validation after one mocked adapter call, without admission. A faithful primary followed by a fragmented independent extraction also stops structurally, after two calls. The leading-context adversarial fixture that omitted its intervening effect wording now expects this earlier structural stop; contiguous absorbed-Country fixtures retain their semantic-fidelity rejection.

Focused source tests additionally cover omitted whitespace, connective text, line endings/tabs, punctuation, zero-width characters and an astral Unicode character for both literal purposes. They reject borrowing a matching literal from another source occurrence, accept adjacent multi-span Unicode/repeated literals with exact whitespace through trusted admission/handoff, and preserve separated non-literal context provenance.

Validation:

- The independent gate's eleven-suite focused command: **141 passed, 0 failed, 0 skipped, 0 expected failures**.
- `npm.cmd run typecheck`: passed under the repository's strict TypeScript configuration.
- `npm.cmd run build`: passed.

The suites used mocked provider transports only; no credentialed provider or browser workflow ran. Real-model semantic accuracy and correlated interpretation errors remain unmeasured. This correction closes the mechanical literal-provenance defect without adding English interpretation authority or asserting a new independent architecture gate.

DEFERRED_ACTION_GROUNDING_WP1_V2_LITERAL_PROVENANCE_FIXED
