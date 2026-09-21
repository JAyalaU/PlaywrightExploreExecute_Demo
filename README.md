# Playwright UI validation MVP

This repository contains a TypeScript/Node.js MVP for turning natural-language UI validation tasks into deterministic Playwright execution.

The implemented flow is:

```text
natural-language task
  -> validated TestSpec
  -> bounded Playwright MCP exploration
  -> durable locator and prerequisite validation
  -> deterministic Playwright replay
  -> typed results and persisted evidence
```

The project is currently a library and test suite. It does not expose a command-line service or product UI.

## Prerequisites

- Node.js 24 (`>=24 <25`)
- npm
- Chromium installed for Playwright

The repository also contains an experimental Python scaffold under `src/`; it is not the production runtime.

## Setup

```text
npm ci
npx playwright install chromium
```

Callers configure an execution profile, network policy, and private artifact directory in code. There are no required environment variables in the repository. Artifact storage must not be placed under a public static directory.

## Validate the repository

```text
npm run typecheck
npm test
npm run build
```

`npm test` runs the Playwright test suite under `tests/`. The suite covers the domain contracts, locator handling, protected browser boundary, deterministic runner, evidence, MCP exploration, interpretation, orchestration, handoff, and M8 regression controls.

## Project structure

```text
app/
  domain/          TestSpec and resolved-test contracts and validation
  locator/         Locator AST parsing, quality checks, and binding semantics
  profile/         Execution profiles, protected browser contexts, and network policy
  runner/          Deterministic Playwright interpreter
  exploration/     Bounded MCP exploration and prerequisite capture
  interpretation/  Natural-language interpretation, step orchestration, and handoff
  evidence/        Immutable local artifacts, redaction, capture, and reports
tests/             Playwright contract, browser, integration, and regression tests
docs/              Architecture, schema, runbook, spike, and implementation documents
spikes/            Isolated feasibility-spike fixture and artifacts
```

`app/index.ts` is only a package entry placeholder. The workflow APIs are exported from the module indexes, especially `app/interpretation/index.ts`, `app/exploration/index.ts`, `app/profile/index.ts`, and `app/evidence/index.ts`.

## Architecture and execution flow

The system is one modular monolith. Interpretation and MCP exploration are bounded, agentic stages. Once a `ResolvedTestSpec` is accepted, the runner executes its ordered steps in fresh protected browser contexts without an LLM or MCP dependency.

The same versioned execution profile is used for exploration, locator validation, and replay. MCP references are temporary; persisted tests contain validated locator data and ordered prerequisite steps. Runtime binding failures, browser failures, and QA assertion failures remain separate result types.

See:

- [Architecture](docs/architecture.md)
- [TestSpec and resolved-test contracts](docs/test-spec-schema.md)
- [MVP runbook](docs/runbook.md)
- [Implementation plan](docs/implementation-plan.md)

## Operational notes

- Browser traffic, including iframe and secondary requests, is governed by the protected network policy. There is no direct-network fallback.
- Non-loopback destinations require an approved `ExternalTargetGate`; local targets can use explicitly configured policies.
- Authentication state is supplied through protected references. Credentials and storage-state contents are not ordinary artifacts.
- The artifact store redacts metadata and restricts screenshots, traces, and videos. Binary evidence requires explicit capture approval, and expired artifacts are removed through the explicit pruning operation.
- A stale accepted locator produces `LOCATOR_BINDING_FAILED`. Locator regeneration is a new MCP exploration attempt; deterministic replay never repairs locators silently.
- Execution is headless. noVNC is not implemented and is not required for resolution or replay. A future viewer must remain an observation layer attached to the existing isolated session.

For setup, profile construction, execution, evidence access, troubleshooting, and release checks, use the [runbook](docs/runbook.md).
