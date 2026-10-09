# Adaptive discovery benchmark boundary

Phase 0 defines scenario categories and scoring. It does not run a benchmark or claim measured generalization. The development fixture is available to implement Phase 1. Held-out scenarios must be bound to previously unseen applications and frozen before evaluation; the scenario IDs and criteria below are the initial test set. Do not add selectors, target-specific branches, or manual hint JSON to the implementation.

## Separation and freeze

- `development-scenarios.json` contains scenarios available while building the agent. Phase 1 starts with the accessible local fixture and an explicit application-state reset capability.
- `held-out-scenarios.json` is the evaluation manifest. Evaluation targets and authored instructions must be selected independently, recorded with a manifest digest, and withheld from implementation work. Run all cases against one frozen implementation commit.
- On failure, record the cause and score the case. Fixes belong to development, followed by a new held-out evaluation set. Never patch one held-out case and continue calling that suite unseen.
- The canvas scenario is conditional on verified visual-coordinate action capability. If unavailable, report it as unsupported tooling, not a passed case or a QA assertion failure.

## Per-scenario record

Record first-attempt exploration success, clean-pass success, original-goal coverage, manual hint JSON count, accessibility/DOM/vision transitions and useful visual fallbacks, model/tool calls, latency, estimated cost, clean-pass adaptations and failures, verification strength, false-positive outcome, reset proof, cleanup proof, and deterministic source-export eligibility. Report stops separately from evaluated false assertions. Keep evidence private and redact credentials, model payloads, and restricted browser content from stakeholder summaries.

The proposed initial acceptance gate in architecture v1 remains unmeasured. Set numerical thresholds before freezing real evaluation targets, not after seeing results.
