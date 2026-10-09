# ActionGoal semantic fidelity: architecture addendum

**Decision:** Narrow deterministic ActionGoal fidelity to structural/source proof. Replace its English semantic rules with complete source annotation, typed authored obligations, and an independent, source-first semantic extraction gate. No material residual intent may be discarded or delegated to an unchecked grounding decision. Semantic acceptance remains probabilistic; trusted browser proof and deterministic replay remain separate authorities.

This addendum supersedes the fidelity and source-to-browser correspondence wording in the [deferred action grounding decision](deferred-action-grounding-architecture.md:34). It does not replace that decision's protected browser, fresh compiler, replay, or QA boundaries. It is a read-only architecture review: only documentation changed; no provider workflow, browser, tests, or implementation was run.

## Scope and confirmed evidence

Reviewed `AGENTS.md`, system overview/current status, the reality report, deferred grounding architecture, independent WP1 gate, WP1 completion contracts, ActionGoal/TestSpec v6, and the deferred wire/prompt/acceptance path. Implementation scope is source interpretation and validation; no additional exploration or compiler implementation was needed.

The [independent gate](deferred-action-grounding-wp1-gate.md:32) establishes three concrete failures: faithful `Tap Save` rejects; faithful `Choose Option 1 at the Country dropdown` rejects; the latter accepts when the entire target phrase is mislabeled as the argument. These are recorded mocked-adapter/validator results, not live model results. This review inspected their implementation causes; it did not rerun those experiments.

| Evidence | Boundary consequence |
|---|---|
| [Effect/role/connective tables](../app/domain/action-goal.ts:42) and [argument delimiter inference](../app/domain/action-goal.ts:103) | Deterministic code interprets English instead of only checking model-produced provenance. Ordinary variation requires production changes. |
| [Context/relationship/prerequisite rules](../app/domain/action-goal.ts:151) and [role/token coverage](../app/domain/action-goal.ts:173) | English classification and omission detection depend on overlapping lexical rules. A covered token can still have the wrong semantic owner. |
| [Argument ownership skips](../app/domain/action-goal.ts:189) | Once wording is classified as literal data, target/context meaning within it escapes omission checks. Complete coverage is not semantic completeness. |
| [Prompt vocabulary instruction](../app/interpretation/deferred-action-interpret.ts:24) | The prompt reproduces the validator's grammar limits. Merely removing one delimiter regex would leave the same coupling elsewhere. |
| [Single-call acceptance](../app/interpretation/deferred-action-interpret.ts:72), [ambiguity mapping](../app/interpretation/deferred-action-interpret.ts:85), and [pronoun heuristic](../app/interpretation/deferred-action-interpret.ts:94) | Semantic judgment has no independent gate; some coreference judgment is also lexical code. |
| [Closed ActionGoal schema](../app/domain/action-goal.ts:16), [trusted TestSpec construction](../app/interpretation/deferred-action-interpret.ts:88), [closed wire](../app/interpretation/deferred-action-wire.ts:7) | Useful mechanical provenance, version isolation, and authority protections already exist and should be retained. |

**Root cause:** the contract has exact source spans but no separate account of semantic ownership/completeness. The validator tries to supply that missing account through an English parser. Coverage can prove that text was copied, not that the text was interpreted correctly. The `Email` [relationship fixture discrepancy](deferred-action-grounding-wp1-gate.md:59) demonstrates the same distinction: copied `Email` is not proof that it names the button.

## 1. The trust boundary and its unavoidable limit

Deterministic lexical code cannot prove arbitrary natural-language semantic completeness. Larger synonym/preposition lists cannot change that. A model must decide what a clause means, whether a phrase is an argument or target constraint, and whether apparently neutral words actually matter. Two models may make the same mistake. A fresh compiler that faithfully repeats the wrong interpreted predicate will not repair that mistake.

This design therefore promises **no silent structural erasure and an independent semantic gate**, not mathematically guaranteed English entailment. A material constraint classified incorrectly by both independent extractions remains a residual interpretation risk. If the product requires zero such risk, unrestricted natural language cannot be automatically accepted; explicit user confirmation of a structured interpretation would be required. This addendum does not introduce that confirmation flow.

| Authority | Owns | Does not prove |
|---|---|---|
| Interpretation models | Authored segmentation, effect, mechanism constraints, literal/target ownership, semantic relationships, polarity, references, and materiality | Browser facts, permissions, uniqueness, action success, or replayability |
| Deterministic source validator/admission | Closed schemas, bounds, exact source spans/values, full source accounting, field/graph legality, immutable linkage, strict agreement of independent extracted obligations | That `Tap` means activate, `Country` is a target, or an omitted phrase is semantically neutral |
| M7 | Browser-dependent strategies satisfying accepted authored obligations; compatible reviewed operation where unconstrained | Authority to reinterpret, weaken, or drop obligations |
| Protected runtime | Facts and complete predicate evaluation over current browser state; selected target, membership, uniqueness, capability, freshness, and argument mapping | Unrestricted English understanding or semantic endorsement |
| Fresh compiler/replays | The same accepted obligations' closed predicates, operation/argument fidelity, durable correspondence and fresh binding | Correctness of the original English interpretation |

Keep the finite effect families and executable operation language. They are reviewed semantic/execution vocabularies, not synonym dictionaries. Open-ended English maps to them through bounded model interpretation.

## 2. Options considered

| Option | Assessment |
|---|---|
| **A. Typed extraction + mechanical validation** | Necessary, insufficient alone. An argument span can absorb a target while remaining exact and nonoverlapping. Schema and provenance cannot independently discover that omission. |
| **B. Complete typed partition/annotation** | Adopt as an audit and structural omission safeguard. Every source character must be accounted for, including punctuation/connectives. It exposes disappearance and residual text. It still relies on model judgment to distinguish neutral from material or argument from target. |
| **C. Authoritative residual text** | Retain full source and explicit residual annotations; never discard either. Residual material prevents executable admission until resolved and independently endorsed. Passing raw residual to M7 alone would move, rather than close, the safety gap. |
| **D. Independent semantic check** | Adopt as one additional bounded source-first extraction, not a yes/no approval of the first output. It directly addresses the accepted intent-loss defect without an English parser. Cost: another call, tokens, latency, correlated-error risk, and safe disagreement stops. |
| **E. Defer more decomposition to M7** | Do not adopt for material authored constraints. Browser-dependent identity remains deferred; source meaning must not change to fit convenient candidates. Any later semantic mapping to reviewed browser predicates needs independent endorsement, not M7 self-certification. |

Selected hybrid: A + B + bounded D, with C as a lossless stop condition. This adds one independent source gate, not a general multi-agent deliberation system. No unbounded repairs, majority vote, or model-created authority language is introduced.

## 3. Revised source representation

Introduce **ActionGoal goalVersion 2**, retaining TestSpec v6 as the isolated successor family. Keep v1 readable with its existing validator for stored source-only artifacts; do not silently convert it or authorize it for the revised grounding route. The new provider format must have a new identity rather than changing `qa_deferred_action_interpretation_v4` in place. Released/historical TestSpec v2-v5 contracts remain unchanged.

The reviewed source shape has three parts, not one schema variant per sentence:

1. **Immutable authored source:** goal/step IDs, exact clause and instruction spans, full original instruction, ordered clause linkage. Source and trusted metadata are supplied/checked by trusted code.
2. **Complete source accounting:** ordered nonoverlapping segments partition the entire clause into effect wording, literal argument, target description, contextual/relationship wording, prerequisite/reference wording, neutral material, or unresolved material. Every material segment references an obligation ID. A neutral annotation is an explicit semantic claim subject to the second extraction. Whitespace/punctuation are retained without needing an English connective table. Instruction-level connector/gap annotations likewise prevent the current `emptyGap` vocabulary from becoming a replacement bottleneck. VerificationGoal and navigation source semantics stay separate.
3. **Typed authored obligations:** stable IDs; effect; optional operation constraint and exact wording; literal purpose/text; explicit target role/name/context/uniqueness; relationship with distinct subject and anchor; prerequisites and resolved authored references; and source segment/span references. These are authored semantic statements, not accessible-name, computed-role, frame, DOM-value, or locator facts.

Constraints may use ordered multi-span references where the author expresses one fact in separated words. Nested semantic facts reference segments; the physical partition itself never overlaps. Effect/operation can share provenance by referencing the same effect segment. Context may reference both its connector and Country phrase while the Country designation references its own segment. This avoids inferring semantic ownership from whichever span happens to contain another.

A relationship obligation identifies **the target**, a separately source-grounded **anchor**, and the exact authored relational wording. `Email` cannot become a target-name obligation merely because the anchor's text is copied. No arbitrary executable relation is supplied: later translation is restricted to reviewed runtime predicates, or stops unsupported.

Retain polarity/contrast as semantic obligations or a typed authored-ambiguity decision. The initial successor may still stop on unsupported exclusions/alternatives, but the judgment comes from source interpretation and its independent check, not a general-English negation regex. Contradictory normalized obligation combinations can be rejected mechanically; whether a clause expresses that contradiction is semantic judgment.

**Residual rule:** unresolved material is preserved verbatim with its spans and reason category. It cannot be relabeled neutral by M7 or omitted from an accepted witness. Admission requires no unresolved *material* source segment. A structurally valid draft with residuals is not an accepted executable ActionGoal. This preserves uncertainty without claiming that unconstrained prose has a runtime proof.

Do not add selectors, scripts, Playwright expressions, compiler instructions, current refs, or browser-specific identity/value fields. Literal arguments are inert source data, including text resembling code. Closed data-only interfaces and downstream construction enforce non-execution; code-pattern screening is supplementary safety policy, never an English-completeness test.

## 4. Interpretation and omission gate

1. The primary interpreter produces the proposed source-goal extraction and complete accounting. Deterministic validation checks structure and exact provenance against trusted input.
2. A second bounded interpreter receives the **original source and the extraction contract**, without the first extraction, browser state, or candidate target. It independently extracts ordered effects, literals, mechanism constraints, target/anchor obligations, polarity, references, and complete source accounting. It may return authored ambiguity or semantic uncertainty.
3. Deterministic admission compares canonical projections: clause ownership/order; effect and operation policy; exact literal bytes and occurrence; source ownership classes; material/neutral classification; target versus anchor ownership; constraint kind/endpoints; polarity; reference links. Model IDs are remapped by source occurrence/structure. Ordering and harmless representational normalization are mechanical; differing boundaries or semantic classifications are **not** guessed equivalent by code.
4. Accept only strict agreement with no unresolved material. Build a trusted admission record linking source digest, goal-contract/prompt versions, both valid extraction digests, and the accepted obligation/accounting digest. It records that the checks ran; it is a **semantic endorsement record, not a proof of English meaning**. The provider cannot forge acceptance by returning `approved: true`.
5. Disagreement, uncertainty, or timeout stops before M7. No automatic older-format fallback or autonomous semantic weakening. A later explicit bounded correction policy would require its own review; it is not part of the initial fix.

In a malformed `Option 1 at the Country dropdown` argument output, a source-first second extraction identifying `Option 1` and Country separately produces a mismatch and prevents admission. Dropping Country produces an accounting/ownership or independently extracted obligation mismatch. Marking Country neutral is a materiality disagreement. Giving Email target-name ownership rather than anchor ownership is a typed semantic disagreement. Both-pass agreement on the same wrong classification remains probabilistic risk, retained visibly in immutable source/admission evidence.

This is why a partition alone is insufficient and why an independent check must not merely ask whether the incumbent output looks plausible. No source text is discarded by acceptance. All material meaning must have an endorsed obligation; all neutral classification is explicitly endorsed. This is the enforceable meaning of “constraints cannot silently disappear.” It does not claim deterministic detection of every jointly misinterpreted English phrase.

## 5. Target/argument, effect and relationship examples

The following are expected semantic extractions, **not implemented capabilities or assertions about real-model reliability**. No new sentence-specific schema or delimiter is needed.

| Source | Accepted authored meaning |
|---|---|
| `Choose Option 1 at the Country dropdown.` | choose; literal `Option 1`; Country target designation and authored dropdown description/context. `at` belongs to contextual accounting, not an argument delimiter in code. |
| `Choose Option 1 using Country.` | choose; literal `Option 1`; Country is the authored control/context designation. No invented role. |
| `Choose Option 1 on the Country selector.` | Same choice/literal; Country target designation with authored selector/control description. No CSS selector field. |
| `Pick Option 1 for Country.` | Same extraction if the source-first models agree Country designates the control. If the phrasing genuinely also admits a recipient/purpose interpretation, semantic uncertainty stops; no page candidate resolves an authored meaning conflict. |
| `Set Country to Option 1.` | choose; Country target designation; literal `Option 1`. Argument may follow target in source. No verb-position/preposition grammar in TypeScript. |
| `In Country, select Option 1.` | Same choice/literal; leading Country context retained. Context need not follow the argument. |
| `Select Option 1.` | choose; literal `Option 1`; no target designation or invented role; browser implementation unconstrained. One versus multiple suitable controls is later grounding ambiguity. |

For all six contextual variants, a wrong extraction that absorbs Country into the argument must fail agreement with a faithful second extraction. The source literal does not become a DOM value. Grounding still proves the selected control, owned option, label/value mapping, and complete uniqueness under **Country plus all other accepted constraints**, not whichever unique control contains Option 1.

| Effect wording | Source policy |
|---|---|
| `Click Save` | activate with authored click mechanism constraint and Save target designation. Both models must preserve it. |
| `Tap Save` | activate with Tap wording retained. It does not invent touch-event execution; if the author specifically demands a touch mechanism, preserve that constraint and stop unsupported unless reviewed. |
| `Press Save` / `Activate Save` / `Open Save` | activation intent with exact wording; no automatic browser mechanism unless materially authored. A source needing a specific key/button press must preserve that demand rather than treating it as generic activation. |

Explicit operation constraints remain bounded `click`, `fill`, and `select_option` where actually demanded, with source references. Models determine whether English demands a mechanism. Deterministic code checks effect/operation legality and that both extractions retain the same demanded operation; it cannot prove from arbitrary English that no mechanism was omitted. A tiny reserved machine-operation token check can remain for explicitly authored protocol identifiers; it must not grow into a synonym authority. Ordinary `select` means choice, not necessarily native `select_option`.

For `Click the button next to Email`, extraction is activation + explicit click; target role button; authored relation to anchor Email; **no target name Email**. Independent extraction must agree on target/anchor ownership. M7 cannot satisfy the goal by clicking a conveniently named Email button. It must obtain an endorsed mapping of that relation to a reviewed predicate and trusted facts. Literal spatial adjacency is not silently equivalent to label association or common containment: if the initial vocabulary cannot express the authored relationship, grounding stops unsupported. This clarifies the parent decision's conditional association example; convenient association alone does not prove “next to.”

## 6. M7 handoff and correspondence interface

M7 receives full clause/instruction, complete source accounting, spans, accepted typed obligations and their digest, operation constraints, and trusted semantic-admission linkage. It does not receive an executable goal with unresolved material. It may inspect unknown browser dimensions and propose reviewed predicates/operations; it may not revise source obligations, change literal text, reclassify neutral/material text, or treat browser uniqueness as permission to ignore Country.

The affected WP2 interface must require a **total source-obligation-to-grounding mapping**: every accepted material obligation ID has a proposed closed predicate/operation/argument/reference realization. M7 supplies this mapping, not semantic authority. Where realization requires a semantic inference beyond a reviewed exact typed mapping (e.g. translating authored context/relationship into containment versus label association), a bounded independent semantic endorsement against the immutable source/obligations is required **before action**. It rejects a weaker relation, changed endpoint, missing obligation, or altered mechanism. No details of the WP2 implementation are selected here.

Protected runtime then proves that the endorsed closed predicates are true, that all required obligation IDs are discharged, and that one current actionable target satisfies their conjunction. It records predicate/obligation IDs, admission/mapping digests, trusted observations, complete candidate proof, target/argument associations, state/frame provenance and execution facts. The runtime does **not** certify that raw English was understood. Model semantic endorsement and runtime fact witness are distinct records with distinct authority.

The fresh compiler consumes the immutable accepted goals, semantic endorsements and successful grounding correspondence. It requires the **same complete obligation mapping** and independently establishes its closed predicates, argument mapping, frame/scope and uniqueness in fresh state. Neither English parsing nor a new compiler model may rescue missing authored semantics. No durable representation => typed non-QA compilation stop. An accepted artifact carries the closed full-predicate guards for two fresh replays; no LLM/MCP below it. This preserves target-substitution safeguards while being honest about the interpretation layer's residual risk.

## 7. Failure semantics

All following stops are non-QA. Preserve distinct internal codes and sanitized external explanation; do not expose private payloads or collapse them into `MATERIAL_AMBIGUITY`.

| Failure | Owner / outcome |
|---|---|
| Malformed fields, unknown executable/browser-fact fields, invalid bounds, fabricated text/span, wrong order/linkage or changed literal bytes | Structural/source validation failure (`INVALID_SOURCE_REPRESENTATION` or existing invalid-spec category); not authored ambiguity. |
| Valid source copying but argument/target, target/anchor, effect, operation, polarity or materiality disagreement | `SEMANTIC_INTERPRETATION_DISAGREEMENT`; no accepted goal. Same classification can indicate candidate fabrication, but semantic judgment is not mechanical proof. |
| Omitted authored meaning found by independent extraction, including missing Country or click demand | `SEMANTIC_FIDELITY_MISMATCH` with a bounded omission/ownership category; no M7 admission. |
| Extractor cannot classify material wording or reconcile references | `SEMANTIC_INTERPRETATION_UNRESOLVED`; preserve residual source; no admission. |
| Source itself has incompatible requested effects/targets or genuinely unresolved authored alternatives/references | `AUTHORED_AMBIGUITY`; mapped to authored ambiguity only when independently endorsed. Contradictory normalized obligations can additionally reject deterministically. |
| Explicitly demanded mechanism outside the reviewed execution language | Unsupported authored operation, not a guessed substitute operation. |
| Multiple/zero matching controls, incomplete observations, unknown option ownership or stale state | Grounding ambiguity/unresolved/runtime stop; not interpretation ambiguity. |
| Closed grounding mapping omits/weakens an accepted obligation | Correspondence validation/endorsement failure before action, not browser ambiguity. |
| Fresh correspondence cannot be reproduced or represented | Non-QA compilation rejection; no resolved artifact or older-route fallback. |
| Provider/check deadline, refusal or transport failure | Typed provider/environment stop; the semantic gate cannot be skipped. |

These are proposed distinctions, not existing result-code changes. WP1 must review their closed wire/outcome representation and safe projection without modifying released route semantics.

## 8. Required WP1 rework and compatibility

**Priority 1: close accepted intent loss and remove the ordinary-English lexical authority together.** Do not patch `at`, add `tap`, or increase role/preposition tables as the fix.

- **WP1A (`typescript-pro`):** define ActionGoal v2 accounting/obligations/residual and trusted semantic-admission contract; implement mechanical schema/span/partition/graph/field checks. Remove effect synonyms, delimiter inference, role/context/relationship/neutral/negation semantic regex authority from the new goal validator. Keep v1 separately readable. Scope instruction-gap accounting to the new successor so conjunction variation is not blocked by [v6 emptyGap](../app/domain/test-spec-v6.ts:28). Retain approved absolute URL and existing VerificationGoal behavior; this decision does not widen navigation or verification capabilities.
- **WP1B (`ai-engineer`):** isolated new primary/independent extraction formats/prompts and bounded orchestration; source-first independent context; deterministic agreement/admission; precise failure mapping. Move new-route action coreference semantics out of the [pronoun heuristic](../app/interpretation/deferred-action-interpret.ts:94) into endorsed source links. Remove prompt lexical container restrictions. Preserve separate old formats/adapters; no v6-v1 automatic upgrade, no v5 fallback, no production cutover.
- **Independent gate (`test-automator`):** validate ordinary variation and adversarial semantic ownership through the actual adapter with two mocked outputs; update the expected-failure conflation regression to a normal rejection regression. Report structured/mechanical and semantic-model evidence separately.

Do not serialize acceptance as a caller-supplied model boolean. Trusted source-only schema validity and trusted **semantic admission** are different states; WP2 must consume the latter. TestSpec v6/ActionGoal v1 stored fixtures remain inspectable, not runnable successor authority. New format identity/goalVersion prevent cached artifacts or old adapter results from acquiring revised meaning. The parent migration's trace v5/compiler v4/resolved v9 numbering need not change before implementation, but their proposed correspondence interfaces must include accepted obligation/admission/mapping linkage.

Expected gain: ordinary synonyms and constructions become model interpretation issues; the confirmed source-loss defect gains an independent gate; downstream safety can verify obligation coverage mechanically. Costs: a second interpretation call, stricter agreement false stops, richer source artifacts, and later semantic-mapping endorsement where necessary. No claim of universal language support, no broad runtime rewrite, and no new action/assertion operation are justified by this review.

## 9. Regression and eventual proof strategy

Offline fixtures must exercise both primary and source-first check outputs through the actual new adapter/admission path. New ordinary phrases should need **only test fixtures**, not production regex, prompt vocabulary tables, or schema variants. Include effect synonyms and all argument-order/context variants above, Unicode/repeated occurrences, quoted literals, multistage goals, and old-route isolation.

Required accepted semantic cases: `Tap Save.`, `Activate Save.`, `Choose Option 1 at the Country dropdown.`, `Choose Option 1 using the Country dropdown.`, `In the Country dropdown, choose Option 1.`, `Select Option 1.`, and `Click the button next to Email.` Acceptance of the last proves source intent only; browser relation support is separate.

Required adversarial cases:

- Primary absorbs Country/dropdown into literal; faithful independent extraction disagrees => reject before M7.
- Primary drops Country or marks it neutral; independent material constraint => reject.
- Primary gives Email target-name ownership; independent anchor ownership => reject.
- Fabricated role/name text or changed literal => source validation rejects; copied-but-wrong semantic classification => independent mismatch rejects.
- Primary omits/weakens authored click/fill; independent mechanism constraint => reject.
- Argument and target illegally overlap, missing source segment, forged admission, dropped obligation in handoff => deterministic rejection.
- Both extractions unresolved, disagreement, deadline, or malformed output => stop without fallback.
- Both mocked extractions repeat the same semantic mistake => document that deterministic agreement cannot detect it; do not label this an intent-proof pass.

One normal path: correct unnamed `Select Option 1` survives two source extractions with no guessed native implementation. One failure path: the recorded absorbed-Country output stops when checked against faithful source-first extraction. One integration edge: valid source/admission but a proposed grounding mapping omits Country must fail obligation coverage/semantic correspondence before browser execution. These were reasoned against the proposed interface, not executed as new tests in this review.

Focused tests, typecheck and build are required for the eventual rework. Later authorized noncredentialed/captured evaluation and real-model provider evaluation must include unseen paraphrases and deliberate ownership errors, checking both model compliance and correlated mistakes. Mock agreement proves wiring, not independent semantic quality. Eventual grounding/compiler/replay proof must retain wrong-control, option-owner, relation, uniqueness, frame/scope drift and operation/argument substitution regressions. No provider workflow is authorized by this addendum.

## Recommendation and readiness

The lexical fidelity approach should be **narrowed to mechanical provenance/structure**, with ordinary-English semantic parsing removed from the revised route. Retain bounded schemas, source coverage, literal fidelity, immutable linkage, data-only executable boundaries and reviewed browser operation policies.

WP2 contracts are affected at admission and source-obligation correspondence, not by a new browser fact authority. Interface design may continue against this addendum. **WP2 implementation/integration must remain blocked** until WP1 rework and an independent gate close accepted semantic loss, accept the reviewed variations without lexical patches, and enforce the new admission/handoff boundary. The largest residual risk is correlated model misinterpretation; it requires empirical evaluation, not another deterministic English parser.

ACTION_GOAL_FIDELITY_BOUNDARY_REVIEW_COMPLETE
