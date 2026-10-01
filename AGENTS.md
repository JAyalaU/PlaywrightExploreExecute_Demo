# Repository instructions

- Read [docs/system-overview.md](docs/system-overview.md) for current architecture and [docs/current-status.md](docs/current-status.md) for active work. Then read only detailed contracts relevant to the task.
- Current code and reviewed contracts are authoritative. Older plans and `docs/architecture.md` may describe historical boundaries; verify against current contracts before using them as the released agentic workflow.
- Preserve the exploration/compiler/replay authority split, protected public-browser approval/isolation and separate legacy v1 versus agentic v2 external contracts. Never turn automation or environment stops into QA failures.
- Keep credentials, private traces, model/MCP payloads and restricted evidence out of stakeholder-safe outputs.
