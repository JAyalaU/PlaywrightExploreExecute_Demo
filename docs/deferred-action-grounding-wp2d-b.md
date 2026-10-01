# Deferred Action Grounding WP2D-B: protected execution and successful grounding witness

WP2D-B adds an isolated execution route to the WP2D-A preparation controller. The deferred-action architecture and semantic-fidelity addendum remain authoritative. This package executes supported admitted goals against a protected current session and issues a successful grounding witness only after fresh effect proof. It does not assemble trace v5, compile v4, create resolved v9, replay, select a production route, or produce a QA verdict.

## Changed boundary

`app/domain/action-grounding-execution.ts` adds separate closed version-1 execution-attempt, post-effect, and successful `ActionGroundingWitnessV1` contracts. `PreparedActionGroundingV1` remains read-only preparation with `executed: false`; it is never reinterpreted as an execution witness. The successful witness contains original preparation, an independently renewed final complete conjunction, actual execution accounting, and fresh post-effect facts. Digests retain the exact admitted source goal, unchanged total correspondence, independent endorsement, candidate/label/option facts, profile/fingerprint, session/page/frame, state and mutation epochs, exact operation, and authored/runtime-derived argument.

`ActionCandidateGroundingSessionV1.executePreparedGrounding` accepts only an exactly issued, unconsumed prepared record and its retained in-process trusted mapping. Operation and argument come from that record and renewed trusted facts. The caller supplies no action callback, executable argument, locator, or effect-success flag. Protected final-check, execution, post-effect, and successful-witness readback use separate private journals. Integrity parsing or recomputing a digest cannot manufacture runtime origin.

The smallest coherent runtime change reuses WP2D-A's conjunction composition inside the existing protected exclusive lease. It keeps the broad complete WP2A domain, WP2C owned-label sets, WP2B native options, source endorsements and pending-obligation rules intact. Preparation now privately retains actual candidate, label-source and option node handles. Final composition compares those identities, including same-markup replacements, then renews every complete predicate and argument mapping. Short-lived prepared records are single-use, including rejected, failed and unproved execution attempts; retained handles are retired on consumption or session close.

Scrolling/readiness is preparatory and happens before the renewed complete conjunction. Drift during scrolling fails before dispatch and requires a new complete query/preparation. Runtime actions use the retained exact `ElementHandle` with reviewed force mode after visibility/enabled/editability checks, so actionability retries cannot retarget a replacement locator. The inherited ten-second expiry and shared deadline are checked immediately before dispatch, after all awaited capability/state reads. Browser scripting can still race a final read and dispatch: the exclusive lease provides trusted-client coordination and drift detection, not an atomic browser transaction.

## Effect truth and execution accounting

The supported effect predicates use existing Playwright utility-world property reads and WP2B isolated native option readers. Page-world property overrides, model prose, snapshots and arbitrary state changes cannot establish an effect.

| Reviewed operation | Capability required before mutation | Fresh successful effect |
| --- | --- | --- |
| `fill` | Unique current visible/enabled/editable native `input` or `textarea` | Same owned node's native input value equals the exact admitted entered literal. |
| `select_option` | Unique current actionable single native `select`; complete uniquely owned exact-label-to-value mapping | Same control and all option nodes/ownership/order/label/value/disabled facts renewed; exactly the admitted mapped option is selected with the runtime-derived value. |
| `click` | Unique native checkbox/radio whose actual type agrees with the reviewed selected role | Exactly one trusted native click delivered to that retained input during this execution, plus a checkbox checked-state change or unchecked radio becoming checked on the same owned node. |

Generic button/link activation and custom editable textboxes stop unsupported **before mutation**, because this package has no reviewed fresh-effect primitive for them. A button click returning successfully, navigation, arbitrary DOM mutation or a changed snapshot is not substituted for an activation effect. Already checked radios also lack the required transition and stop before action. Custom controls and new effect primitives remain outside this package.

`app/exploration/action-activation-execution.ts` supplies a bounded native delivery receipt for execution accounting, not a new model query or semantic/spatial grounding relation. A fixed isolated utility-world listener is armed on the retained native input with the runtime-generated execution ID. It accepts only an `isTrusted` click whose actual event target is that same input, caps the event count at an ambiguity sentinel, and is read and removed inside the exclusive execution lease. The post-effect contract retains the exact execution ID, native type, one-delivery count and owned target. An overlay can receive the pointer and assign `checked` or call the input's synthetic `.click()`, but those effects have no trusted owned delivery receipt and cannot produce a successful witness. Receipt proves native delivery to the input, including legitimate browser-forwarded native activation; it does not claim pointer-coordinate identity. Page-world event/getter/method overrides cannot forge the isolated listener's facts.

Execution accounting distinguishes:

- `rejected`: no operation invoked; no mutation is attributed to the authored action.
- `failed`: operation invoked and threw; partial mutation is possible and explicitly retained as unknown.
- `executed_unproven`: operation returned, but fresh effect/identity/ownership/provenance or successful-witness validation was not established.
- `succeeded`: operation returned and all fresh post-effect and successful-witness checks were committed to the private journal.

The ledger preserves attempt start, dispatch, return and finish phases without requiring different millisecond timestamps. Final-check time precedes dispatch within expiry, and post evidence is captured only after the operation resolves. Invocation is marked before dispatch, so browser closure, parser faults or cleanup errors cannot relabel an attempted mutation as a pre-action rejection. Successful accounting is committed only after witness validation; failure/abandonment never leaves successful witness/post evidence. Cleanup failures cannot override mutation accounting. Raw browser/provider errors and page payloads are absent from these closed outcomes.

Post-effect proof renews same-node identity both before property reads and immediately before publication. Native choice additionally preserves option identities and full owned collection. A replaced control/option, changed mapping, reset value, prevented checkbox default, no-op command return, or unavailable post observation yields no successful witness.

## Fresh retries and stop handling

`app/interpretation/action-grounding-execution-controller.ts` adds `executeActionGoalGroundingV1`. It composes WP2D-A with execution and validates exact private readback. At most three execution rounds share a 45-second budget, with WP2D-A's separately bounded three model/preparation attempts inside each round. The shared deadline is forwarded through model calls, complete query, preparation and execution leases; browser read budgets remain cooperative at existing browser API boundaries.

Only demonstrably pre-dispatch `STALE_STATE`, `QUERY_UNEVALUABLE`, or `BUSY` stops can retry. Every retry starts a new source correspondence/required independent endorsement, complete WP2A query and whole-conjunction preparation. It does not reuse a ref or browser-discovered argument. If a fresh complete option collection proves a changed DOM value for the same authored label, the **new preparation** supplies that new value; an old prepared mapping is rejected. There are no implemented preparatory browser mutations beyond scrolling; trusted integration that waits or mutates must invalidate and reprepare rather than reuse evidence.

Any attempted operation, including partial/unknown failure or unproved returned mutation, stops without automatic repetition. Structural, unsupported, unresolved and provider/environment outcomes remain distinct non-QA stops. Protected readback becoming unavailable after session close produces a typed environment stop retaining actual attempted accounting; it cannot yield a detached successful handoff.

## Compatibility and later trace handoff

The new contracts/controller are additive. WP2A/B/C request/observation/binding families, old action preconditions, M7 v3/v4/v5 contracts, ActionGoal v1, old interpretation/trace/compiler/resolved/replay families and production selection stay separate. Optional trusted deadline parameters retain existing defaults. A new Country-constrained successful witness does not waive old WP2A/B uniqueness requirements or enter an older trace as an upgraded identity witness. No credential, public-browser approval, provider transport, or MCP tool schema changes were made.

Later trace v5 assembly must receive:

1. The actual trusted WP1 admission and actual trusted total mapping authority retained through `protectedGroundingMapping(preparation.strategyId)`.
2. The complete successful witness and exact matching private `protectedActionGroundingWitness` readback.
3. Exact protected final-check, execution and post-effect journal records, matching their linked IDs/digests and full immutable source/profile/frame/state/argument chain.
4. Ordered successful strategy/state correspondence checked against the original source step. Rejected attempts and retries are restricted diagnostics outside the successful strategy; neither a prepared record nor a pre-action check grants successful-action truth.

Readback must be validated while the owner session is available. This package does not persist trace evidence or define later immutable storage. Future fresh compilation still must reconstruct the whole endorsed source predicate and option/label ownership in a new protected context, and future replay must use its accepted closed guards. Live external MCP/provider checks and production activation remain separately authorized subsequent work.

## Validation

Focused fixtures exercise the actual protected loopback browser and in-memory MCP path with mocked source/strategy adapters, not a credentialed provider. Coverage includes unnamed native fill/choice, Country plus independently endorsed context, exact role/name/literal, checkbox/radio delivery and effects, overlay checked assignment and synthetic-click rejection, page-world event/prototype spoofing, unsupported generic/custom controls, broad-domain drift, hidden/replaced/wrong-frame controls, scrolling mutation, expiry/deadline boundaries, changed option values requiring new preparation, page getter spoofing, no-op return, partial mutation plus throw, reset/replaced post targets/options, post query failure, witness-validation and cleanup faults, forged counts/owners/roles/source/phases, single-use issuance, source-first fresh retries and closed-session handoff.

The final full focused compatibility command passed **234 tests, zero failures/skips**. The final WP2D-B suite passed **37 tests, zero failures/skips** locally and **37/37** in the parent's independent rerun, including the late overlay/synthetic-click activation regressions. Both implementation and parent `npm.cmd run typecheck` and `npm.cmd run build` passed. No credentialed provider, live external MCP/public-browser proof or production workflow ran.

```text
npx.cmd playwright test tests/deferred-action-grounding-wp2d-b.spec.ts tests/deferred-action-grounding-wp2d-a.spec.ts tests/deferred-action-grounding-wp2c.spec.ts tests/deferred-action-grounding-wp2b.spec.ts tests/deferred-action-grounding-wp2a.spec.ts tests/deferred-action-goal-v2-wp1a.spec.ts tests/deferred-action-interpretation-v2-wp1b.spec.ts tests/deferred-action-grounding-wp1-v2-independent-gate.spec.ts tests/goal-directed-observation-wp2.spec.ts tests/agentic-current-state-wp2a.spec.ts tests/structured-action-identity-wp2.spec.ts tests/m6-mcp.spec.ts --workers=1
npm.cmd run typecheck
npm.cmd run build
```

DEFERRED_ACTION_GROUNDING_WP2D_B_COMPLETE
