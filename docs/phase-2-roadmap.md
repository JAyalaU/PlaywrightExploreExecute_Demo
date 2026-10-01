# Phase 2 roadmap: usable integrations and real-web validation

## Purpose and fixed boundaries

M1–M8 provide the validated TestSpec, bounded Playwright MCP resolver, locator gate, protected browser sessions, deterministic runner, and typed evidence. Phase 2 makes that library usable with a real model, a local operator workflow, and a primarily Python host. [Architecture](architecture.md), [TestSpec contracts](test-spec-schema.md), and the [MVP implementation plan](implementation-plan.md) remain authoritative. The runner continues to consume only accepted `ResolvedTestSpec` data; model calls and MCP references stay outside deterministic execution.

Detailed work packages are defined immediately before each milestone against the repository state then. Any change to an approved execution or security boundary requires an explicit architecture revision.

## Decisions before implementation

Record a short integration decision before Phase 2 coding:

- Select the model provider and decide which task text and bounded page excerpts may leave the local environment. Keep provider credentials outside TestSpecs and ordinary evidence.
- Attach the local headed view to the protected browser session and put presentation mode in a new versioned execution profile without changing legacy fingerprints. Treat every headed run as observational with unverified physical-input provenance and `autonomousEligible: false`, even when no input was detected. Keep detectable input as append-only observation evidence; a separate fresh headless run establishes autonomous execution. The view must preserve the existing network and authentication boundaries.
- Agree on the Node/Python invocation boundary, ownership of process lifecycle and authorization, and the typed request/result envelope. Node retains TestSpec validation, exploration, execution, and evidence ownership. The Python host remains thin.
- For optional `.spec.ts` export, decide whether the file is a review artifact or a runnable entry point. A runnable export must use the same accepted resolved data, profile, network policy, and result semantics as the deterministic runner.

These are integration choices, not a reopening of M1–M8. If a proposed choice changes an approved boundary, resolve that through architecture review before implementation.

## Milestones and dependency order

| Milestone | Outcome and completion signal | Depends on |
|---|---|---|
| **P2-1 — Real model adapters** | Real provider adapters satisfy the existing interpretation and step-decision interfaces. A natural-language task completes the bounded workflow on a controlled local target, or returns the existing typed rejection/failure. The model has no browser-tool or runner access. | Integration decision; M7 contracts. |
| **P2-2 — Local interactive/headed demo** | A developer can enter a task and target URL locally, observe the protected browser session, and inspect its typed result and evidence. Headed input provenance is unverified and the run is never autonomous-eligible; a separate fresh headless run proves autonomous execution. Compare normalized engine behavior under compatible non-presentation settings while preserving each profile fingerprint. | P2-1 for the full live demo; M3/M6/M7 session and handoff boundaries. |
| **P2-3 — Thin Python-host integration** | The Python host can submit a task through the agreed Node boundary and receive typed outcomes, immutable IDs, and artifact references. Node owns browser policy, model orchestration, replay, and cleanup; the host does not duplicate them. | Agreed invocation contract and a stable P2-2 workflow entry point. |
| **P2-4 — Optional `.spec.ts` export** | An accepted `ResolvedTestSpec` can be rendered into reviewable Playwright source without model-generated code or ephemeral MCP refs. Any runnable export preserves the approved execution and policy boundary. | Existing resolved-spec contract; export-use decision. Independent of P2-1 through P2-3. |

**Phase 2 acceptance gate — real public-web validation:** Treat the public-web example as a cross-cutting acceptance gate, not a standalone milestone. After P2-1 through P2-3, run one documented natural-language validation through the Python-facing path against an approved public site. Require a real model, protected MCP exploration, accepted locators and prerequisites, fresh deterministic replay, and a reconstructable typed report with evidence. Prepare the site's external-target approval and browser-wide destination policy before the run; record site variability and any denied secondary traffic. P2-4 is optional and does not block this gate.

## Critical path and parallel work

**Critical path:** integration decisions → real model adapters → stable local Node workflow entry point → Python-host handoff → public-web acceptance gate. Headed observation can proceed alongside the Python caller once that entry point exists; the final gate waits for both completed integrations. A headless integration proof can run before headed observation is finished.

The Python-side caller can be prepared alongside P2-2 after the invocation contract is fixed, with final integration waiting for the Node entry point. Public-site selection, approval, and destination-policy preparation can proceed alongside P2-1 and P2-2. P2-4 can proceed independently once its export-use decision is made and the existing resolved-spec contract is confirmed.

## Delivery risks and controls

- **Model output quality or provider failure:** validate on the controlled local target first; retain schema rejection and typed model failures. Escalate a provider or contract mismatch before the public-web gate.
- **Headed mode bypasses protection or changes state:** use the established protected session boundary, record detectable input events, and keep headed outcomes observational regardless of an empty event log. Compare normalized behavior with a separate fresh headless run. Stop the demo milestone if observation requires a second uncontrolled browser or a bypass of network/authentication policy.
- **Public-site volatility or unapproved secondary traffic:** select a stable site and a backup in advance, document the allowed destinations, and treat policy denial as an environment outcome rather than relaxing enforcement during a run.
- **Python or exported source duplicates execution logic:** keep one Node-owned workflow and deterministic runner. Review the bridge and export against the accepted profile, locator, failure, and evidence contracts before acceptance.

**Recommended first milestone:** P2-1, after the short integration decision. It activates the existing M7 model interfaces and provides the live interpretation needed by the demo and final gate.
