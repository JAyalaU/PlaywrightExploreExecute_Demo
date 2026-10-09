# System overview

> Historical agentic-exploration architecture. That workflow was retired in Cleanup B3. For the current semantic-general product graph, use [the current-state audit](cleanup/current-state-architecture-staleness-audit.md) and verify against source. A full documentation rewrite is deferred to Phase D.

This is a short map of the **released local PoC**. Read [current status](current-status.md) next, then open only the detailed contract for your task. The [agentic-v2 release record](agentic-v2-release-gate.md) records the automated gate and operator-reported real-provider proof. The original [MVP architecture](architecture.md) and earlier plans describe historical designs.

## Purpose and current flow

The PoC turns a natural-language browser test for an operator-approved public site into a reproducible QA result. The LLM can solve the browser task through bounded Playwright MCP exploration, but its observations are not QA verdicts. Trusted code preserves the successful path, proves it can be compiled in a fresh protected browser, and runs the compiled test twice from fresh states. Streamlit is local, loopback-only and single-operator.

The supported agentic workflow is selected before launch by trusted `PLAYWRIGHT_DEMO_WORKFLOW_VERSION=agentic-exploration-v1`:

```text
Streamlit -> trusted Python admission/host -> subprocess-v2 Node CLI
 -> OpenAI interpretation -> validated TestSpec goals
 -> bounded M7 + Playwright MCP exploration -> current-state target bindings
 -> immutable SuccessfulExplorationTrace v2
 -> fresh protected compiler -> immutable ResolvedTestSpec v6
 -> fresh deterministic replay 1 -> fresh deterministic replay 2
 -> Node ResultRecordV2 + safe report projection v2
 -> Python validation -> Streamlit outcome
```

Exploration may act on a grounded current MCP reference without first finding a durable replay locator; it must observe the consequence before marking a goal achieved. Failed choices and recovery branches remain private diagnostics outside the successful trace. The compiler later proves frame, target, locator, operation and witnessed passive-condition correspondence in a separate context. The runner consumes only accepted v6, with no LLM/MCP repair. Only two agreeing completed deterministic assertion outcomes produce authoritative QA pass/fail. Other stops identify automation, environment, cancellation or reproducibility limits.

The legacy workflow remains separate for compatibility and the P4 visual-observation path. It uses subprocess/report projection v1 and resolved versions 2–5. A job cannot switch families or silently fall back. Headed execution is observational (`autonomousEligible: false`); separate fresh headless execution establishes autonomous equivalence. The agentic-v2 terminal timeline and live image/viewer channels are unavailable pending reviewed correlation and authorization integration. Legacy P4 events cannot be used as v2 terminal truth.

## Component map

| Subsystem | Responsibility and principal implementation | Detailed documentation |
|---|---|---|
| Interpretation / TestSpec | `app/interpretation/interpret.ts`, `openai-wire.ts`; closed goals in `app/domain/schema.ts` and `validate.ts`. Reject unsupported/ambiguous requests before exploration. | [TestSpec schema](test-spec-schema.md), [agentic contracts](agentic-exploration-contracts.md) |
| OpenAI adapters | `app/interpretation/openai-responses.ts`, `openai-adapters.ts`, `model-failure.ts`; bounded provider calls and typed failures. Credentials stay with trusted host/Node. | [Agentic contracts](agentic-exploration-contracts.md), [external outcomes](agentic-external-outcome-mapping.md) |
| M7 agentic exploration | `app/interpretation/agentic-controller.ts`; closed inspect/decide/act/observe/evaluate/recover loop and fixed budgets. `agentic-production.ts` composes later stages. | [Agentic contracts](agentic-exploration-contracts.md) |
| Playwright MCP | `app/exploration/mcp.ts`; allowlisted, bounded tools and protected-session snapshots/actions. Page and model content are untrusted. | [Agentic contracts](agentic-exploration-contracts.md), [MCP research](playwright-mcp-research.md) |
| Current-state binding | `app/exploration/current-state.ts`; ties selected ref to live session, page/frame, snapshot, goal, operation and node; rejects stale/drifting bindings. | [Agentic contracts](agentic-exploration-contracts.md) |
| Trace assembly/storage | `app/exploration/trace-assembly.ts`, `app/evidence/store.ts`; ordered successful facts, immutable trace v2 and separate restricted branches. Schemas/validation in `app/domain/agentic-contracts.ts`, `agentic-validate.ts`. | [Agentic contracts](agentic-exploration-contracts.md) |
| Fresh compiler | `app/exploration/trace-compiler.ts`; reconstructs successful path in new protected context, persists checks and accepts v6 only after full verification. | [Agentic contracts](agentic-exploration-contracts.md) |
| Locator semantics | `app/locator/parse.ts`, `quality.ts`, `binding.ts`; closed forms, shared authored role/name witness, scope, uniqueness and quality. `app/exploration/resolve.ts` is the legacy M6 resolver. | [TestSpec schema](test-spec-schema.md), [agentic contracts](agentic-exploration-contracts.md) |
| Deterministic runner | `app/runner/run.ts`, `locator.ts`; v6 frame paths, ordered waits/actions/assertions and typed outcomes, without LLM/MCP. Legacy entry point remains separate. | [Agentic contracts](agentic-exploration-contracts.md) |
| Evidence / reports | `app/evidence/store.ts`, `capture.ts`, `report.ts`; `app/interpretation/agentic-external-v2.ts` and `app/subprocess/report-projection-v2.ts` verify immutable provenance and expose bounded safe fields. | [External outcomes](agentic-external-outcome-mapping.md) |
| Protected browser | `app/profile/context.ts`, `isolated-browser.ts`, `network.ts`, `browser-environment.ts`; disposable mountless container, private control/proxy bridge, proxy-only egress and cleanup. | [Public admission](p3-a-public-admission.md), [headed viewer decision](p4-g2-headed-viewer.md) |
| Admission / profiles | `app/profile/admission.ts`, `admission-cli.ts`, `contracts.ts`; trusted operator approval binds canonical URL, DNS pins, policy, profile/fingerprint and separate headed authority. | [Public admission](p3-a-public-admission.md), [headed viewer decision](p4-g2-headed-viewer.md) |
| Subprocess v1/v2 | `app/subprocess/agentic-cli.ts`, `agentic-entry.ts`, `protocol-v2.ts` for agentic; `cli.ts`, `entry.ts`, `protocol.ts` for legacy. One bounded final JSON response on stdout. | [External outcomes](agentic-external-outcome-mapping.md), [v1 protocol](p2-3-subprocess-protocol.md) |
| Projection v1/v2 | `app/subprocess/report-projection-v2.ts` and its CLI for agentic; `report-projection.ts` and its CLI for legacy. Read-only projection cannot reclassify the terminal. | [External outcomes](agentic-external-outcome-mapping.md), [v1 projection](p3-b-report-projection.md) |
| Python host | `src/playwright_demo/host.py`, `public_admission.py`, `protocol_v2.py`, `report_projection_v2.py`; trusted selection, supervision/cancellation and closed validation. | [External outcomes](agentic-external-outcome-mapping.md), [operator guide](phase-3-operator-guide.md) |
| Streamlit UI | `src/playwright_demo/ui_workflow.py`, `ui_shell.py`, `ui_launcher.py`; loopback launch, form, distinct v2 outcome categories and safe report; no log-derived truth. | [Release procedure](agentic-v2-release-gate.md) |
| P4 observability/viewer | `app/observability/`; Python `live_events.py`, `live_images.py`, `live_viewer.py`. Sanitized events, restricted ephemeral images and private view-only headed viewer for **legacy** workflow. | [G0 events](p4-g0-live-events.md), [G1 images](p4-g1-live-images.md), [G2 viewer](p4-g2-headed-viewer.md) |

## Invariants

1. **Authority:** MCP/model solve tasks only in exploration; current-state binding authorizes those actions. Only the fresh compiler accepts replay identity. Only the runner executes v6; no model, MCP, locator regeneration or repair below it.
2. **QA:** Exploration and compiler acceptance are not verdicts. Two fresh same-profile replays must agree. Binding, wait, compilation, provider, network, budget, cancellation and cleanup uncertainty remain non-QA outcomes.
3. **Artifacts:** Validate and preserve source/profile/fingerprint links across TestSpec, binding, trace, compiler, v6, runs and terminal. Failed/recovery branches never enter replay. Rejected compilation yields no runnable v6.
4. **Isolation:** Public authority comes from trusted inspected approval and pinned policy, never form/task text. Browser container has no host mounts, provider credentials, direct egress or published management port. Forced termination leaves cleanup unverified.
5. **External boundary:** Node owns execution truth and safe projection. Python validates closed contracts; Streamlit displays them. Keep v1/v2 separate. Never expose private traces, locators, MCP/model payloads, page text, credentials, developer diagnostics or unrestricted artifacts.
6. **Headed observation:** Viewer/images confer no browser control. Headed cannot substitute for fresh headless autonomous proof. Agentic P4 needs its own review before enablement.

## Version map

| Current contract | Why it exists |
|---|---|
| TestSpec `schemaVersion: "2"`; reviewed `"3"` link collection | Closed authored operations/assertions; no general existence/count assertion yet. |
| Target `bindingVersion: "1"`; M7 `decisionVersion: "3"` | Current-state action authorization and bounded agent decisions. |
| Successful trace `traceVersion: "2"` | Current immutable path with cross-context frame provenance and witnessed passive conditions; v1 remains readable historical data. |
| `compilerVersion: "1"`; ResolvedTestSpec `schemaVersion: "6"` | Fresh checks and accepted declarative replay. Legacy resolved 2–5 remain separately readable/executable. |
| ResultRecordV2; subprocess `protocolVersion: "2"`; `reportProjectionVersion: "2"` | Agentic terminal, wire and safe report. Legacy v1 family is unchanged. |
| Headless admission v1; headed admission v2/profile schema v4 | Separate public-target and observational headed approvals. |
| P4 `eventStreamVersion: "1"`, `liveImageVersion: "1"`, `liveViewerVersion: "1"` | Separate legacy observation contracts, not agentic-v2 terminal authority. |

## Read next by task

- **Interpretation, TestSpec or assertion vocabulary:** [TestSpec schema](test-spec-schema.md), then [agentic contracts](agentic-exploration-contracts.md). Check [current status](current-status.md) for the active design topic.
- **Agentic exploration, binding or trace capture:** [agentic contracts](agentic-exploration-contracts.md), then the relevant controller or `app/exploration/` code.
- **Compiler, frame correspondence or locator quality:** [agentic contracts](agentic-exploration-contracts.md), [TestSpec schema](test-spec-schema.md), `app/exploration/trace-compiler.ts` and `app/locator/`.
- **Runner or QA classification:** [agentic contracts](agentic-exploration-contracts.md), [external outcomes](agentic-external-outcome-mapping.md), `app/runner/`.
- **Public URL admission, profiles, network or isolation:** [public admission](p3-a-public-admission.md), [headed viewer decision](p4-g2-headed-viewer.md), `app/profile/`.
- **Subprocess, safe report, Python host or UI:** [external outcomes](agentic-external-outcome-mapping.md), [release procedure](agentic-v2-release-gate.md); open [v1 protocol](p2-3-subprocess-protocol.md) or [v1 projection](p3-b-report-projection.md) for legacy tasks.
- **Legacy events/images/viewer:** [G0](p4-g0-live-events.md), [G1](p4-g1-live-images.md), [G2](p4-g2-headed-viewer.md). Agentic observability needs separate review.
