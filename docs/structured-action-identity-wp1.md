# Structured action identity WP1

TestSpec `schemaVersion: "5"` is an opt-in interpretation contract. It is not routed into current exploration, trace, compiler, or replay production. TestSpec v4 and the released v2/v6 path remain unchanged. An invalid v5 interpretation returns `AMBIGUOUS_INSTRUCTION`; it does not fall back to v4.

For each authored `click`, `fill`, or `select_option`, v5 requires `actionTargetIntent` with `intentVersion: "1"`, `sourceStepId`, `operation`, exact `accessibleName`, `exact: true`, a source-clause name span, an explicit reviewed role with a source span or `role.kind: "unspecified"`, and optional ordered reviewed scopes with source spans. Spans are half-open UTF-16 code-unit offsets into the immutable action `sourceText`. `navigate` has no target intent. VerificationGoal retains the v4 semantics. V5 permits only these actions and verification goals.

For an authored `Click the Add/Remove Elements link.` step, the versioned action shape is:

```json
{
  "id": "s2",
  "type": "click",
  "sourceText": "Click the Add/Remove Elements link.",
  "target": { "description": "Add/Remove Elements" },
  "actionTargetIntent": {
    "intentVersion": "1",
    "sourceStepId": "s2",
    "operation": "click",
    "role": { "kind": "explicit", "value": "link", "sourceSpan": { "start": 30, "end": 34 } },
    "accessibleName": "Add/Remove Elements",
    "exact": true,
    "nameSourceSpan": { "start": 10, "end": 29 }
  }
}
```

Role-omitting wording uses `"role": { "kind": "unspecified" }`. Scope entries, when authored, use `{ "kind", "description", "sourceSpan" }` in authored order.

The interpreter owns the language mapping. The opt-in provider format `qa_structured_action_interpretation_v3` supplies a closed action intent with authored name/role/scope substrings; normalization locates their unique spans in `sourceText`. The v5 validator checks the source clause, step/operation linkage, name span and exact target description, role grounding, operation cues, and scope/frame grounding. An explicit role cannot be omitted as `unspecified`. Unknown fields, selectors, code, and extra operations are rejected. Source spans are immutable provenance for interpretation fidelity; the future compiler should consume only structured identity and trusted runtime correspondence, not parse action prose.

Mechanical text checks cannot prove arbitrary English equivalence. The interpreter must return ambiguity whenever it cannot confidently establish the requested target. Runtime WP2 must independently bind the selected current node to this identity with protected role/name/scope/frame facts, including uniqueness and selected-reference equality; model-provided intent is not a trusted browser fact. Discovered prerequisites are not TestSpec authored actions and must not inherit or fabricate an authored `ActionTargetIntentV1`. The trace/compile migration will define their separate runtime grounding.

The interpretation validator also fails closed when an action clause contains negation or contrast outside the proposed accessible-name literal. A name span alone could otherwise accept an explicitly excluded alternative, such as `Save` from `Click Cancel, not Save.`. This check remains at the interpretation boundary; compiler v3 does not parse the clause. A literal target name such as `Not Now` remains valid when the negation word is inside the name span.

The current v4 wire `qa_agentic_interpretation_v2`, trace v3, compiler v2, resolved v7, and runner remain separately readable and routed. No v5 artifact is silently upgraded from v4 or accepted by that path.
