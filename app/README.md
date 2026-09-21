# Production module ownership

All directories in `app/` belong to one Node.js package and one modular monolith. The directories reserve ownership boundaries; contracts and behavior arrive in their implementation milestones.

| Directory | Future responsibility |
|---|---|
| `domain/` | TestSpec and resolved-test contracts, validation, and IDs. |
| `locator/` | Locator AST, parsing, quality, and deterministic binding. |
| `profile/` | Versioned execution profile, browser context, and network boundary. |
| `runner/` | Fixed Playwright Test interpreter for accepted resolved steps. |
| `result/` | Typed operation and phase outcomes. |
| `evidence/` | Immutable artifact persistence and reporting. |
| `exploration/` | MCP exploration, prerequisite capture, and later bounded orchestration. |

The experimental `spikes/playwright-mcp/` package and Python starter under `src/` are outside this production tree.
