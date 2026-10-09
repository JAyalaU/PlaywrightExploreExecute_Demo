# Deferred Action Grounding WP2 independent gate

## Verdict and scope

The independent WP2 gate passes for the implemented WP2A through WP2D-B boundary. This gate inspected ActionGoal v2 admission, the WP2D-A correspondence/admission controller, WP2A candidate grounding, WP2B native-option membership, WP2C accessible-label association, and WP2D-B protected execution and witness readback. It added only `tests/deferred-action-grounding-wp2-independent-gate.spec.ts` and this report; production code was not changed.

The boundary exercised is:

```text
two mocked source extractions -> trusted ActionGoal v2 admission
 -> primary/independent total grounding correspondence
 -> complete candidate + applicable label/option facts
 -> renewed protected action-time conjunction
 -> exact operation/argument -> fresh post-effect
 -> private successful grounding witness
```

No credentialed provider, live public browser, trace/compiler implementation, or production workflow ran. The source adapters were the actual mocked OpenAI Responses adapters; their transport returned fixture outputs. The browser tests used the protected loopback fixture and in-memory MCP path.

## Primary end-to-end regression

For the authored goal `Select Option 1.` with one unnamed native `<select>` containing displayed `Option 1` and DOM value `dom-choice-1`, the complete route succeeds. Both source extraction calls receive the original source independently. The accepted goal contains only the effect and choice argument; no target name, role, fabricated identity, locator, or caller approval field is added. Grounding's candidate predicate has no names. The runtime enumerates the control's complete owned options, derives `dom-choice-1`, performs the reviewed `select_option`, and returns a private witness only after fresh selected-option proof for that same control.

Running the identical admitted goal and grounding strategy against two eligible unnamed dropdowns, each containing `Option 1`, stops with `NON_UNIQUE` before either control changes. Option membership cannot shrink the complete target domain.

The Country fixture starts with two eligible dropdowns. Independent mapping endorses the authored Country context as the exact source span; trusted label association finds one owning control; the owned option maps to its current DOM value. The other dropdown remains unmodified. A deliberately disagreeing independent mapping stops before mutation. This proves that browser evidence narrows an already endorsed predicate and cannot choose source meaning.

The gate also drives `Click Save.` on a button and `Open Add/Remove Elements.` on a link through the actual mocked source-adapter/admission and grounding-controller route. Both are currently typed `UNSUPPORTED_OPERATION` before dispatch: text, URL and mutation stay unchanged, attempt accounting says `attempted: false`, and no witness is returned.

## Obligation and evidence integrity

Every admitted obligation remains linked through the primary mapping, independent endorsement when semantic mapping is required, complete query and prepared correspondence. WP2D-A rejects omitted, changed, substituted, unresolved, or non-total correspondence and preserves target versus argument ownership. The source-first mapper has no incumbent mapping, candidate, snapshot, selected ref, or browser state. Deterministic grounding does not parse ordinary English to infer roles, labels, or relationships.

At execution, the prepared record is single-use. The runtime renews the complete endorsed conjunction, candidate and source-node identity, frame/page/session/state ownership, label evidence, owned options, operation capability and exact source/runtime argument inside the protected exclusive lease. Stale retries rebuild source mapping and complete grounding; attempts that may have dispatched are not retried. `fill` uses the exact admitted literal; choice execution uses only the runtime-derived value for the exact uniquely owned authored label.

The tests confirm that partial or thrown execution, returned no-op, stale or replaced targets/options, post-query failure, reset state, page getter spoofing, forged readback, cleanup fault, or failed witness validation cannot produce a successful witness. Success requires fresh post-action facts tied to the same execution and node. Native checkbox/radio activation additionally requires one trusted click delivered to the retained native input and its checked-state transition. Private readback is journal-backed; recomputing a digest or constructing matching JSON does not mint runtime origin. Failed/rejected/abandoned attempt records stay outside successful witness readback.

## Generic activation assessment

Generic button/link activation is a **safe current MVP limitation**, not a reason to invent page-specific postconditions. The current WP2D-B implementation has closed effect predicates for entered native value, uniquely owned native selection, and native checkbox/radio transition. It intentionally stops generic button/link activation before mutation because no generic delivery receipt is currently implemented.

A future general criterion exists for a goal whose admitted obligation is activation: a protected receipt could prove that one trusted click was delivered to the exact retained target during the execution. That would prove `Click Save` as an activation, without claiming that an application saved data. It could also discharge `Open Add/Remove Elements` only when the accepted source obligations classify it as activation. Delivery alone cannot discharge a separately authored destination, visibility, or business-result obligation; those need their own reviewed postcondition or verification goal. State change by itself is not proof that the requested activation occurred, while a target-owned trusted delivery receipt is direct operation evidence. No such generic button/link receipt exists in WP2D-B today, and this gate did not add one.

The architecture's anti-taxonomy examples identify `Click Save` as the same core semantics, so generic activation remains an explicit capability follow-up before that example can execute. It does not block trace v5 work for the presently supported successful witness kinds, provided v5 consumes only those kinds and does not treat unsupported generic activations as successful. A future generic receipt needs a separately reviewed witness effect type and corresponding trace/compiler guard; it must not be inferred from a click command returning or from arbitrary page mutation.

## Existing adversarial coverage

| Risk | Evidence in focused suites |
|---|---|
| Source fidelity, obligation omission/neutralization, malformed provenance, v1 isolation | `deferred-action-goal-v2-wp1a`, `deferred-action-interpretation-v2-wp1b`, `deferred-action-grounding-wp1-v2-independent-gate` |
| Unique/zero/multiple targets, unnamed controls, exact role/name, frames, state drift, truncation/incomplete errors, forged refs | `deferred-action-grounding-wp2a` |
| Option owner/value mapping, displayed label/value difference, missing/duplicate/disabled options, stale/mutated/truncated lists, wrong owner, two controls containing the choice | `deferred-action-grounding-wp2b` and `wp2d-a`; independent identical-goal ambiguity regression in this gate |
| Native label/wrapped label/ARIA association, duplicate and nearby unassociated text, hidden/replaced/wrong-frame owners, forged association, Country narrowing, Email anchor ownership | `deferred-action-grounding-wp2c` and `wp2d-a` |
| Total correspondence, independent endorsement, changed/omitted obligations, operation legality, fresh retries, pending relationship | `deferred-action-grounding-wp2d-a` |
| Exact execution and argument, action-time renewal, partial/failure/no-op accounting, post-effect absence, private authority, fresh successful witness, native activation, old-route handoff | `deferred-action-grounding-wp2d-b` |
| Older current-state/M6/structured-action routes | `goal-directed-observation-wp2`, `agentic-current-state-wp2a`, `m6-mcp`, `structured-action-identity-wp2` |

## Validation

The full focused command passed **240 tests, zero failures and zero skips** in 3.4 minutes. That includes the six independent end-to-end gate cases and the previously reported 234 WP2 compatibility tests.

```text
npx.cmd playwright test tests/deferred-action-grounding-wp2-independent-gate.spec.ts tests/deferred-action-grounding-wp2d-b.spec.ts tests/deferred-action-grounding-wp2d-a.spec.ts tests/deferred-action-grounding-wp2c.spec.ts tests/deferred-action-grounding-wp2b.spec.ts tests/deferred-action-grounding-wp2a.spec.ts tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-interpretation-v2-wp1b.spec.ts tests/deferred-action-grounding-wp1-v2-independent-gate.spec.ts tests/goal-directed-observation-wp2.spec.ts tests/agentic-current-state-wp2a.spec.ts tests/structured-action-identity-wp2.spec.ts tests/m6-mcp.spec.ts --workers=1
npm.cmd run typecheck
npm.cmd run build
```

The independent gate suite passed **6/6** in the parent rerun. Typecheck and build passed in both the independent run and the parent rerun. The parent verified that the application source-file hash baseline was unchanged; this gate introduced no production edits.

No live provider/browser proof is claimed. The shared mock extraction fixtures demonstrate contract wiring and source ownership, not real-model semantic accuracy. Correlated extraction errors and browser races after the final check remain architectural confidence limits. Trace v5 may begin against the successful WP2D-B witness subset and exact handoff in the WP2D-B report; generic button/link activation remains unsupported until a general delivery-receipt contract is reviewed and implemented.

DEFERRED_ACTION_GROUNDING_WP2_COMPLETE
