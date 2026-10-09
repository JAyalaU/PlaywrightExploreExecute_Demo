# Deferred action grounding WP1A: source contract

Implemented source boundary only. No provider format/prompt, browser observations, M7, trace, compiler, resolved artifact, runner or workflow routing accepts this successor yet. The [architecture decision](deferred-action-grounding-architecture.md) remains authoritative for later packages.

## Version and reader boundary

`TestSpecV6Schema` and `parseTestSpecV6` in `app/domain/test-spec-v6.ts` are separate from historical `TestSpecSchema`/`parseTestSpec`. The latter still accepts only v2/v3/v4/v5. No action conversion or route fallback exists. Exporting the new contract from the domain barrel does not enable it in production. Existing `AuthoredStep`, `TestSpec` and all historical provider-wire schemas remain unchanged.

V6 retains `testSpecId`, exact `sourceInstruction`, `executionProfileRef`, `startState` and ordered `steps`. Steps are a closed union of:

- `navigate`: authored absolute HTTP(S) URL without credentials, exact `sourceText`, ID and `sourceInstructionSpan`;
- `action_goal`: `ActionGoalV1`;
- `verification_goal`: existing `VerificationGoal` fields/semantics plus `sourceInstructionSpan` for ordered source ownership.

URL admission still belongs to the protected host. Schema-valid navigation is not operator approval.

## ActionGoalV1

```ts
{
  id, type: "action_goal", goalVersion: "1", sourceStepId,
  sourceText, sourceInstructionSpan: { start, end },
  effect: "activate" | "enter_text" | "choose",
  effectSourceSpan: { start, end },
  explicitOperation?: { operation: "click" | "fill" | "select_option", sourceSpan },
  argument?: { purpose: "entered_text" | "choice", authoredText, sourceSpan },
  targetConstraints: [{
    kind: "role" | "name" | "context" | "relationship" | "uniqueness",
    authoredText, sourceSpan, polarity: "positive"
  }],
  prerequisiteContext?: { authoredText, sourceSpan }
}
```

All spans are half-open JavaScript UTF-16 offsets. `sourceInstructionSpan` addresses the original instruction; all other spans address the exact clause `sourceText`. There is no whitespace/case normalization or browser fact invention. Role constraints retain words such as `dropdown` or `text field`; they do not assert a computed `combobox` or `textbox`. A source `name` preserves authored naming, not a claim about the browser's accessible name. Context and relationship phrases remain authored constraints, not trusted associations or frame locators.

`targetConstraints` can be empty for a choice goal. There is no accessible-name, browser-role, locator, selector, JavaScript, option DOM value, current ref, frame-title or compiler-instruction field. All objects reject unknown fields. An activate/text-entry goal requires some authored target constraint, which can be only a role or context; a bare `Click.` is unclear source intent.

For `Select Option 1.` the clause has `effect: "choose"`, effect span over `Select`, choice argument `Option 1`, and an empty target constraint array. It asserts neither a named control nor native select mechanics. For `Choose Option 1 from the Country dropdown.`, `Option 1` remains the argument; `Country`, `dropdown` and the authored context are retained separately. For `Fill the username field with Jorge.`, `username` and `field` constrain the target while `Jorge` is entered data.

### Semantic effect versus operation

An authored `Click` requires an explicit `click` constraint. `Fill` requires `fill`. `Open` is activation without inventing click mechanics. `Enter` is text entry without inventing fill mechanics. `Select`/`Choose` preserve the exact verb through the effect span and express choice without requiring native `select_option`. A `select_option` constraint is accepted only if that exact operation was authored, not inferred from `Select`. The closed effect cue set also includes press/activate/follow, type/input and pick. Expanding reviewed source verb recognition does not add browser operations.

Ordered multi-effect wording is segmented into separate owned goals. `Open the only dropdown and choose Option 2.` has activation and choice goals with different IDs/spans; `Open the menu and choose Settings.` follows the same structure. Source spans preserve the intervening conjunction. No implicit successful prerequisite is invented.

## Fidelity rules and limits

`parseTestSpecV6` enforces unique IDs, exact clause ownership, ordered nonoverlapping clause spans, and complete instruction coverage. Gaps can contain whitespace, punctuation, numbering and connective `and`/`then`/`please`; a dropped action or verification clause fails. VerificationGoal fidelity/dependencies use the existing validator.

Action fidelity enforces exact spans, source-step linkage, authored effect/explicit operation, literal purpose, bounded text, argument versus target separation, ordered constraints, source role/uniqueness preservation, context/relationship markers, polarity, and contradictory/duplicate/crossing constraint rejection. Nested context/relationship/uniqueness spans may contain more specific name/role constraints; competing overlapping identity constraints reject. Meaningful source tokens must be covered by intent/argument/constraint provenance, preventing silent deletion of names or context. Role words outside quoted names/arguments require separate role constraints.

Choice arguments precede `from`/`in` target wording; fill arguments follow `with`; enter/type arguments precede `in`/`into`. Delimiters inside quoted literal payloads are ignored: `Made in USA` and `Sign in` remain arguments. Quoted entered text retains leading/trailing spaces exactly. Unassigned argument-region words or constraints in the argument region reject. These are source fidelity checks, not browser eligibility rules. Unsupported source phrasing fails closed rather than inventing missing information.

Unquoted negation/alternatives/contrast fail closed. Quoted name literals can contain role, action and polarity words without being treated as operational clauses. Explicit constraints cannot be discarded by labeling an entire source fragment as a name or prerequisite. Prerequisite/context wording must carry a reviewed contextual marker; it cannot swallow the requested operation or argument.

Semantic constraints reject code/selector syntax, and semantic portions of action clauses reject executable content. Literal entered text is inert data and may contain characters resembling code/selectors; it never becomes executable. Neither a source argument nor its spelling proves a DOM value or option membership. Bounds: 16,384 instruction characters, 100 steps, 1,024 clause/phrase/argument characters, 24 constraints and 128 source identifier characters.

The validator is a conservative reviewed lexical source gate, not a universal natural-language entailment engine. This package proves serialized contract behavior for supported source shapes. It does not prove browser executability, full provider fidelity, label association, unique eligible targets, or deterministic reproducibility.

## Exact structured interpretation adapter handoff

The next package must provide a separately named strict v6 wire format and opt-in adapter; existing v3 structured-action wire stays frozen. It must:

1. Preserve original input and exact owned clause occurrences, emitting v6 action goals instead of `click`/`fill`/`select_option` target steps. Segment explicit effects in source order.
2. Retain authored effect verb, explicit operation, literal argument and ordered constraints/context. Never set `accessibleName`, inferred role, native option value, selector, scope locator or frame identity.
3. Produce unambiguous source provenance. If the provider emits phrase provenance rather than offsets, normalization must resolve the exact intended occurrence without a first-match guess; repeated phrases need explicit occurrence/span ownership. Instruction offsets and clause offsets have distinct coordinate systems.
4. Normalize wire `null` optionals to absent application fields only at the new wire boundary. Call `parseTestSpecV6` against the trusted original instruction and trusted profile/start-state metadata. Schema parse alone is insufficient.
5. Return typed interpretation ambiguity/unsupported/validation stops for rejected source semantics. Missing target name/role on a choice is valid source intent and must not be rejected for lacking browser identity.
6. Keep the successor unrouted until later reviewed exploration/compiler/runner packages exist. No v6-to-v5 conversion, older-route fallback or runnable artifact may be inferred from acceptance.

## Validation

Focused new and historical contract suites: 40 passing tests across `deferred-action-goal-wp1a`, `structured-action-identity-wp1`, `goal-directed-verification-wp1` and `domain-contracts`. Typecheck and build pass under strict/exact-optional/unchecked-index settings. These are offline structured-source tests; model output is supplied as fixtures, and no provider/browser workflow was run.
