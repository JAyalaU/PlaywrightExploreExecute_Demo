# Playwright Demo

A local Windows proof of concept for natural-language UI tests. It interprets **supported** instructions into a semantic test, grounds actions and checks against a live page, compiles proven mechanics into deterministic replay data, then checks them in two fresh Playwright browser sessions.

The current compiler produces a **ResolvedTestSpec v10 declarative data artifact** consumed by this repository's deterministic Playwright runner. It **does not generate a Playwright Test `.spec.ts` source file**.

```text
Natural language -> semantic TestSpec v7 -> grounding v1 -> compiler v5
  -> ResolvedTestSpec v10 -> runner v10 twice -> replay pair v2 -> QA result
```

[docs/architecture.md](docs/architecture.md) is the current architecture authority. Current source wins if documentation and code differ. The [supported capabilities](docs/supported-capabilities.md) define the implemented instruction vocabulary.

## Runtime and setup

The product has one workflow, `semantic-general-v1`, and one browser runtime: a native schema-5 `local-windows` profile using bundled Playwright Chromium. It requires Windows; Docker is not used. The Streamlit UI is a loopback-only, single-operator host for the Node workflow.

Requirements are Node.js 24, npm, Python 3.12 or newer, and `uv` ([package.json](package.json), [pyproject.toml](pyproject.toml)). From the repository root:

```powershell
npm ci
npx playwright install chromium
uv sync
npm run build
```

For a public-target run, supply `PLAYWRIGHT_DEMO_TRUSTED_CONFIG` pointing to a native schema-5 trusted configuration with an **exact approved target URL, profile reference, and profile fingerprint**. Supply `OPENAI_API_KEY` in the process environment or the gitignored repository `.env` file. The [operator runbook](docs/operator-runbook.md) explains admission and launch. `PLAYWRIGHT_DEMO_LIVE_VIEW=1` and `PLAYWRIGHT_DEMO_ACTION_PAUSE_MS` are optional presentation settings. Do not set a workflow or browser-backend selector for normal use.

```powershell
uv run playwright-demo-ui
```

The UI binds only to `127.0.0.1` and rejects conflicting Streamlit bind settings. The local Chromium runtime does **not** enforce DNS pins or network egress restrictions; reviewed DNS addresses in target approval are approval metadata.

## Validate

```powershell
npm run typecheck
npm run build
npm test
```

`npm test` runs the current TypeScript product suites, including frame-v2 and cancellation, then the bounded Python host/UI suite. `npm run test:semantic:integration` runs just the deterministic local end-to-end fixture; it needs a prior build. `npm run test:reproducibility-stores` is opt-in coverage for experiment-only stores. Offline fixtures do not establish live public-site reliability. See the [runbook](docs/operator-runbook.md) for result meanings and troubleshooting.

Historical architectures are in [docs/archive/](docs/archive/README.md). Bounded experiment reports and opt-in tools are in [docs/experiments/](docs/experiments/README.md) and [tools/experiments/](tools/experiments/README.md); they are secondary evidence, not product instructions.
