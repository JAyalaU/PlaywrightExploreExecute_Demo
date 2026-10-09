# Deferred action grounding WP1B: interpretation adapter and provider wire

Implemented the separately callable TestSpec v6 interpretation boundary using the [WP1A contract](deferred-action-grounding-wp1a.md) and [architecture decision](deferred-action-grounding-architecture.md). Acceptance produces authored source intent only. Production selection, browser grounding, M7, observations, trace, compiler, resolved artifacts and replay remain unchanged. No credentialed provider or browser workflow was run.

## Exact AI path

```text
trusted InterpretationRequest
  -> interpretDeferredActionTask + standalone v6 source prompt
  -> createOpenAIDeferredActionInterpretationModel
  -> existing bounded/stateless Responses transport, new reviewed format identity
  -> strict v6 wire parse and nullable normalization
  -> v6 response parse
  -> parseTestSpecV6 against original instruction and trusted metadata
  -> accepted TestSpecV6 or typed non-QA interpretation stop
```

The public callable API and accepted result type are separate from historical `interpretTask`/`TestSpec`. There is no workflow flag, production route, v6-to-v5 conversion or fallback. The model receives the exact original instruction; it supplies steps only. Trusted code owns schema version, testSpec ID, source instruction, profile reference and start state. Direct UTF-16 half-open offsets preserve the exact intended occurrence; normalization never searches for a first matching phrase.

Changed files:

- `app/interpretation/deferred-action-interpret.ts`: new prompt, deadline, version-specific outcome and source acceptance.
- `app/interpretation/deferred-action-wire.ts`: strict new format and normalization.
- `app/interpretation/openai-adapters.ts`: new adapter.
- `app/interpretation/openai-responses.ts`: additive trusted format type/allowlist and interpretation diagnostic classification.
- `app/interpretation/index.ts`: exports.
- `tests/deferred-action-interpretation-wp1b.spec.ts`: actual adapter/transport mock regressions.
- This completion/handoff record.

## Provider format and source responsibility

`qa_deferred_action_interpretation_v4` is a new strict `text.format` schema. The provider-wire number is distinct from TestSpec `schemaVersion: "6"` and ActionGoal `goalVersion: "1"`. It permits only navigate, action_goal and verification_goal steps. Every object is closed and requires every wire property. Application optionals are required nullable wire properties, normalized to absent application fields only at this new boundary. This follows the [official OpenAI Structured Outputs contract](https://developers.openai.com/api/docs/guides/structured-outputs).

The model owns clause segmentation, action versus verification, semantic effect, explicitly authored operation, literal arguments, ordered target/context/relationship/uniqueness wording, authored prerequisites and verification meaning. It preserves all explicit constraints with exact source provenance. It cannot assert an unstated browser role or accessible name, native versus custom implementation, option DOM value, current ref, frame identity, selector, locator, executable code, runtime uniqueness or approval authority. The prompt does not inherit v5's mandatory exact accessible-name requirement.

`activate`, `enter_text` and `choose` are semantic effects. `Click` explicitly constrains `click`; `Fill` explicitly constrains `fill`. `Select` and `Choose` express choice without deciding native `select_option`. Only literally authored `select_option` supplies that explicit mechanism constraint. `Open` and `Enter` likewise leave compatible reviewed mechanisms to later grounding.

## Reviewed example outcomes

| Authored source | Accepted source structure |
|---|---|
| `Click the Save button.` | activate; explicit click; name Save and role button |
| `Click Save.` | activate; explicit click; authored name Save; no inferred role |
| `Select Option 1.` | choose; choice argument Option 1; empty target constraints; no explicit operation |
| `Choose Option 1 from the Country dropdown.` | choose; argument Option 1; context from the Country dropdown; name Country; authored role dropdown |
| `Fill the username field with Jorge.` | enter_text; explicit fill; argument Jorge; name username; authored role field |
| `Enter Jorge in the only text field.` | enter_text; argument Jorge; context, explicit uniqueness and authored role text field; no name or fill requirement |
| `Open the only dropdown and choose Option 2.` | ordered activation and choice source goals with separate exact clauses |
| `Open the menu and choose Settings.` | ordered activation of authored menu intent, then choose Settings argument without a fabricated grounded target |
| `Click the only button.` | activation with role and authored uniqueness, no target name |

These are mocked-provider results through the actual new prompt/adapter/transport/normalizer/validator. They prove the wiring accepts faithful structured outputs; they do not prove a real model generates them or that a browser can execute them.

The argument remains independent of target constraints. Source fidelity rejects placing Option 1 in the target identity, inventing a dropdown name, omitting an authored role/name/context, weakening Click/Fill, or inferring native selection from Select. Empty choice target constraints are valid. An authored `only` is a source constraint to prove later, not current browser uniqueness.

## Ambiguity and failure ownership

The new ambiguity wire has a closed authored reason-code set: contradictory authored effects, missing literal argument, unresolved antecedent, conflicting explicit targets and unclear authored clauses. Unknown accessible name, browser role/count, native/custom mechanism or frame discovery is excluded. A model-declared authored ambiguity produces `AMBIGUOUS_INSTRUCTION / MATERIAL_AMBIGUITY`. Unsupported demanded operations produce `INTERPRETATION_FAILED / UNSUPPORTED_REQUEST`.

Strict wire/JSON errors produce sanitized `PROVIDER_OUTPUT_INVALID`. A well-shaped response that fails WP1A source fidelity produces `INTERPRETATION_FAILED / INVALID_TEST_SPEC`, rather than the historical blanket ambiguity mapping. Wrong spans, omitted clauses, invented names and target/argument conflation are validation failures. No rejection triggers another provider format or older route.

A standalone unquoted `Click it.` cannot fabricate its antecedent from browser state and is rejected as source ambiguity even if emitted as a goal. The same source-reference guard covers target context `on it` and relationship `next to it`; quoted authored names and literal arguments are excluded, with masking in UTF-16 units. The source guard recognizes an immediate prior activation/text-entry goal with one explicit named target, or a role-described target without a name. `Click Save. Click it.` and `Click the only button. Click it.` retain both exact owned clauses and the literal authored reference `it`; no span is fabricated for Save in the second clause. Later grounding must preserve that source relationship and cannot treat `it` as a literal accessible name. This is a conservative source guard, not a general coreference engine: references across intervening clauses, choice stages or several named semantic objects require further source-contract review if needed. The model remains responsible for identifying materially unclear authored references; the closed ambiguity reason code is not proof that the model's linguistic judgment is correct.

Existing timeout, response-size, refusal, incomplete and HTTP-failure handling is reused. The new entry point enforces an aborting deadline and input/output bounds; transport failure records contain stable codes rather than raw response payloads. There is one provider call, no automatic retry or repair. Diagnostics classify this new format as interpretation and keep prompts, credentials and response content private. Latency/cost therefore remain one bounded interpretation call; exact spans and the richer source schema can increase token usage. No new tools or stored provider conversation are introduced.

Navigation retains authored absolute HTTP(S) URL validation; protected host admission remains necessary. VerificationGoal retains existing optional hints, fidelity, polarity, temporal semantics and earlier-step dependency validation. Historical v5/v4/v2/v3 readers, formats and prompt semantics are untouched.

## Exact trusted-grounding handoff

1. Receive only an accepted `TestSpecV6` from this separate API and preserve its original source, IDs, order, profile/start-state ownership and UTF-16 provenance. Acceptance is source validity, not action authorization or replayability.
2. Treat ActionGoal name/role/context/relationship/uniqueness as authored wording, not observed browser identity. Preserve each explicit constraint. Empty choice target constraints and unknown browser dimensions must reach bounded grounding.
3. Ground the target separately from entered/chosen literal. Option 1 is an argument; actual control identity, ownership and label-to-value mapping require protected facts. Native selection versus a reviewed custom click sequence remains open unless the author explicitly fixed an operation.
4. Preserve multi-stage goals and clear authored antecedents using ordered source context. Do not combine stages into an invented target or invent successful prerequisites.
5. Runtime must establish complete candidate membership/uniqueness, current target/ref, relationship facts, frame/scope provenance, operation compatibility and argument fidelity. None is supplied by this package.
6. Record only successful trusted grounding strategies in the separately reviewed successor trace. A fresh independent compiler later determines deterministic correspondence. No v5/v4/v8 route may consume or reinterpret accepted v6 source goals.

## Validation and remaining proof

Focused gate: 68 passing tests across the new WP1B adapter suite, WP1A source contract, structured-action v5, VerificationGoal v4 and historical OpenAI wire/adapter/transport suites. Typecheck and build pass. The new suite checks success, failure and integration edges: one-control-independent dropdown source intent, malformed/invented output, explicit constraint loss, multi-stage ordering, repeated clauses/UTF-16 offsets, quoted whitespace, navigation/verification fidelity, standalone/recoverable pronouns, trusted format identity, provider refusal/incomplete/timeout, sanitized diagnostics, bounds and no fallback.

Remaining proof: real model clause/spans fidelity, actual provider acceptance of this strict format and interpretation behavior require a later authorized environment-level gate. Browser execution and deterministic reproducibility require the later grounding/trace/compiler/runner packages. The inherited WP1A lexical source gate remains conservative and is not universal natural-language entailment.

DEFERRED_ACTION_GROUNDING_WP1B_COMPLETE
