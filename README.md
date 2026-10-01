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

The project includes a TypeScript/Node.js workflow, a thin Python subprocess host,
and a local, single-operator Streamlit PoC. The UI binds only to loopback; this
repository does not provide hosted or multi-user service access.

## Prerequisites

- Node.js 24 (`>=24 <25`)
- npm
- Python 3.12 or newer and `uv` for the local Streamlit UI
- Docker Desktop or another supported Docker runtime for protected browser sessions
- Chromium installed for Playwright

The repository also contains a thin Python host adapter under `src/playwright_demo/`.
It supervises the Node subprocess; Node remains the production runtime and owns
validation, model/MCP orchestration, browser policy, replay, evidence, and cleanup.

## Setup

```text
npm ci
npx playwright install chromium
uv sync
npm run build
```

Callers configure an execution profile, network policy, and private artifact directory. Offline tests need no credentials. Put `OPENAI_API_KEY=...` in the repository-root `.env` for the guarded Streamlit UI, direct Node commands, or Playwright tests. Existing process environment values take precedence. The file is gitignored. Artifact storage must not be placed under a public static directory.

For the Phase 2 Node command and trusted configuration, see the [runbook](docs/runbook.md#phase-2-local-developer-command). For the Phase 3 Streamlit PoC, see the [Phase 3 operator guide](docs/phase-3-operator-guide.md).

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
src/playwright_demo/ Python host API for bounded Node subprocess calls
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

## Local headed and headless workflow

The local command accepts a target URL, natural-language task, and trusted
versioned profile. A headed profile opens the protected Playwright sessions so
the developer can observe exploration and replay:

```text
npm run local -- --config jobs/trusted-local.json --profile desktop-headed@2 --mode headed --url http://127.0.0.1:4173/ --task 'Select Save.'
```

Use a separate headless profile for autonomous execution proof:

```text
npm run local -- --config jobs/trusted-local.json --profile desktop-headless@2 --mode headless --url http://127.0.0.1:4173/ --task 'Select Save.'
```

The selected trusted profile owns browser mode and network policy; `--mode`
only validates that the requested mode matches the profile. A headed run is
always observational with unverified input provenance and
`autonomousEligible=false`, even when no input event is detected. A separate
fresh headless run is the authoritative autonomous-equivalence path. See the
[runbook](docs/runbook.md#phase-2-local-developer-command) for configuration,
exit codes, artifact inspection, and troubleshooting.

## Operational notes

- Browser traffic, including iframe and secondary requests, is governed by the protected network policy. There is no direct-network fallback.
- Non-loopback destinations require an approved `ExternalTargetGate`; local targets can use explicitly configured policies.
- Authentication state is supplied through protected references. Credentials and storage-state contents are not ordinary artifacts.
- The artifact store redacts metadata and restricts screenshots, traces, and videos. Binary evidence requires explicit capture approval, and expired artifacts are removed through the explicit pruning operation.
- A stale accepted locator produces `LOCATOR_BINDING_FAILED`. Locator regeneration is a new MCP exploration attempt; deterministic replay never repairs locators silently.
- Headed observation uses the same protected browser/session boundary as normal
  execution. noVNC is not implemented and is not required for resolution or
  replay.
- Detectable input is stored as append-only observation evidence. It never
  becomes a TestSpec step, prerequisite, QA result, or replay instruction; an
  empty observation log is not proof that no operator interaction occurred.
- The target URL must already be allowed by the trusted network policy. The
  local command does not grant network access from task input, and non-loopback
  targets require the existing external-target approval boundary.

For setup, profile construction, execution, evidence access, troubleshooting, and release checks, use the [runbook](docs/runbook.md).

## Python host integration

The supported Python integration is an embeddable host API, not a service or a
second execution engine. Build the Node application first, then call
`playwright_demo.call_node` with a task request, the built Node entry, and a
trusted configuration path:

```python
from playwright_demo import call_node

result = call_node(
    {
        "protocolVersion": "1",
        "request": {
            "taskText": "Select Save.",
            "targetUrl": "http://127.0.0.1:4173/",
            "executionProfileRef": {"id": "desktop-headless", "version": "2"},
        },
    },
    node_entry="dist/subprocess/cli.js",
    config_path="jobs/trusted-local.json",
)
```

The request carries only task text, target URL, and a profile reference. The
host-controlled configuration supplies profiles, network policy, artifact
location, capture policy, and other trusted settings. Provider credentials stay
in the child environment and never enter the JSON request or result. The Node
child writes one versioned JSON response to stdout; diagnostics are bounded and
kept separate. See [the P2-3 protocol](docs/p2-3-subprocess-protocol.md) and
[the runbook](docs/runbook.md#phase-2-python-host-integration) for outcome,
timeout, cleanup, and evidence handling.

## Phase 3 local Streamlit PoC

The local UI accepts a public HTTP(S) URL and a natural-language task. A
separate Node admission command requires explicit operator approval before a
URL can run. Start it with `uv run playwright-demo-ui`; it is guarded to bind
only to `127.0.0.1:8501`. The UI uses the existing Python-to-Node workflow and
Node-owned safe report projection. It does not expose raw artifact files or
restricted screenshot bytes.

Follow the [Phase 3 operator guide](docs/phase-3-operator-guide.md) for setup,
target approval, key handling, execution, results, and cleanup. P3-F passed on
the approved Challenging DOM target with two fresh `QA_ASSERTION_PASSED`
replays and an available report projection; see the [live proof record](docs/p3-f-live-proof.md).
