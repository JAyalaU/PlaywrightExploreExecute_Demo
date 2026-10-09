# Repository guidance

Start with [README.md](README.md) and the [current architecture](docs/architecture.md). Then read only the source, contracts, and tests for the boundary you are changing. [Supported capabilities](docs/supported-capabilities.md) and the [operator runbook](docs/operator-runbook.md) cover their respective questions.

Current source is the final authority. Use current docs to orient yourself, then current tests to verify behavior. Experiment reports provide experiment-specific evidence; [archived documents](docs/archive/README.md) provide history. **Do not preload** `docs/archive/`, `docs/experiments/`, or `tools/experiments/` for ordinary implementation. Read them only when a task concerns historical evidence or reproducing an experiment. Cleanup snapshots under `docs/archive/cleanup/` are not product instructions.

## Small reading map

| Task boundary | Start with |
|---|---|
| Interpretation | `app/interpretation/semantic-intent-v3-boundary.ts`, `app/interpretation/semantic-intent-v3-relations.ts`, `app/domain/semantic-intent-v3.ts`, `tests/semantic-intent-v3.spec.ts` |
| Grounding | `app/exploration/semantic-grounding-v1.ts`, `app/domain/semantic-resolved-v10.ts`, `app/exploration/mcp.ts`, `tests/semantic-grounding-v1.spec.ts` |
| Compiler | `app/exploration/semantic-trace-compiler-v5.ts`, `app/domain/semantic-resolved-v10.ts`, `app/evidence/semantic-compiler-store-v5.ts` when persistence matters, `tests/semantic-trace-compiler-v5.spec.ts` |
| Runner and replay | `app/runner/semantic-v10.ts`, `app/domain/semantic-runner-v10.ts`, `app/interpretation/semantic-replay-v2.ts`, `app/evidence/semantic-replay-store-v2.ts` when persistence matters, `tests/semantic-runner-v10.spec.ts` |
| Browser and approval | `app/profile/native-profile.ts`, `app/profile/native-admission.ts`, `app/profile/local-context.ts`, `tests/native-product-boundary-c1.spec.ts` |
| UI and host | `src/playwright_demo/ui_workflow.py`, `src/playwright_demo/host.py`, `src/playwright_demo/protocol_v2.py`, `src/playwright_demo/ui_shell.py`, `app/subprocess/protocol-v2.ts` as needed |
| Local viewer | `app/observability/local-frame-channel.ts`, `src/playwright_demo/local_frame_viewer.py`, `src/playwright_demo/local_frame_ui.py`, their focused tests |

Read a narrower slice if the task requires less. Some live filenames and wire provenance still contain `agentic` or `deferred`; verify their current importers before treating them as retired code. Do not rename a wire field or contract just to update terminology.

Preserve the semantic interpretation/grounding/compiler/replay authority split, native schema-5 public-target approval, and protocol/result v2. Never turn automation or environment stops into QA failures. Keep credentials, private traces, model/MCP payloads, and restricted evidence out of stakeholder-safe outputs.
