# Minimal Adaptive UI Agent

This repository's current proof of concept runs natural-language UI checks in Chromium. The **Minimal Adaptive UI Agent** observes a page through accessibility data, DOM facts, and screenshots; asks an OpenAI model for bounded browser actions; and learns an approach during discovery. It then opens a fresh browser context, executes the task again using current observations, and independently evaluates the clean attempt against the original instruction. The result is **PASS**, **FAIL**, or **INCONCLUSIVE**. Its primary output is a verdict with browser evidence, not a generated Playwright test script.

The [public benchmark](tests/adaptive-minimal-public-benchmark.spec.ts) is the current way to run this agent against a public site. There is no generic URL/instruction CLI or graphical operator interface for the minimal agent.

## Current capabilities

The supported browser actions are navigate, click, check, uncheck, fill, select a native option, press a bounded key, hover, handle an expected JavaScript alert/confirm/prompt, select an opened page/window, and set a native range slider. The agent can request screenshots for visual grounding. Actions use current page evidence and are limited to allowed origins and execution budgets.

The action vocabulary does not cover arbitrary browser interactions, frames, or custom widgets. A screenshot does not guarantee that every visual relationship or outcome can be established.

## Architecture

```text
Natural-language task -> discovery -> fresh clean execution -> independent evaluation -> verdict
```

[`controller.ts`](app/adaptive-minimal/controller.ts) coordinates the attempts, reset proof, budgets, evidence, and verdict. [`browser-tools.ts`](app/adaptive-minimal/browser-tools.ts) translates bounded choices into browser operations and manages dialogs and pages. [`model.ts`](app/adaptive-minimal/model.ts) is the OpenAI Responses adapter for action choice and independent evaluation; [`types.ts`](app/adaptive-minimal/types.ts) defines the contracts. The minimal agent reuses [`app/adaptive/browser.ts`](app/adaptive/browser.ts) for browser observation, screenshots, navigation, and grounded interactions. The benchmark supplies the browser factory, scenarios, and diagnostic artifacts.

The older adaptive/Phase 3A controller and tests remain in `app/adaptive/` and `tests/adaptive-phase*.spec.ts`. The separate **semantic-general-v1** workflow remains the current Python UI/Node CLI product route; it uses native public-target admission and deterministic replay. Its [architecture](docs/architecture.md), [capabilities](docs/supported-capabilities.md), and [operator runbook](docs/operator-runbook.md) apply to that route, not the minimal benchmark. Historical material is under `docs/archive/`; experiments are under `docs/experiments/`, `tools/experiments/`, and `spikes/`.

## Prerequisites

- Windows 11 with a desktop session for visible Chromium.
- Node.js **24.x** (`package.json` requires `>=24 <25`) and npm.
- Playwright Chromium installed for this repository.
- An OpenAI API key and access to an image-capable model for real-model runs.
- Git to clone the repository.

Python 3.12+ and `uv` are needed for the separate semantic-general UI and its Python tests, but not for the minimal public benchmark.

## Installation (PowerShell)

Replace the quoted clone URL with one supplied by the repository owner; this checkout has no configured Git remote.

```powershell
git clone '<REPOSITORY_URL>' Playwright_Demo
Set-Location Playwright_Demo
npm.cmd ci
npx.cmd playwright install chromium
Copy-Item .env.example .env
# Edit .env with your own OPENAI_API_KEY and ADAPTIVE_LIVE_MODEL values.
npm.cmd run build
```

The Playwright config loads root `.env` without overriding shell variables. Keep `.env` local; Git ignores it. Choose an OpenAI model available to your account that accepts the screenshots used by the test. No global Playwright installation is required.

## Quick start

With `.env` configured, run one existing public scenario (scenario 2, adding an element):

```powershell
$env:ADAPTIVE_MINIMAL_PUBLIC_BENCHMARK = '1'
npx.cmd playwright test tests/adaptive-minimal-public-benchmark.spec.ts --grep 'opt-in public minimal benchmark 2$' --workers=1 --reporter=line
```

To watch both phases in actual Chromium windows:

```powershell
$env:ADAPTIVE_MINIMAL_PUBLIC_BENCHMARK = '1'
$env:ADAPTIVE_MINIMAL_HEADED = '1'
$env:ADAPTIVE_MINIMAL_SLOW_MO_MS = '75'
npx.cmd playwright test tests/adaptive-minimal-public-benchmark.spec.ts --grep 'opt-in public minimal benchmark 2$' --workers=1 --reporter=line
```

The discovery context opens and closes first. A separate clean context then opens, runs the task again, and closes. The console labels both phases and prints the final evaluator verdict. Slow motion is presentation pacing only; omit it for no added delay. Without `ADAPTIVE_MINIMAL_HEADED=1`, the browser is headless. Playwright Test's `--headed` flag is not the control documented for this benchmark browser factory.

## Public benchmark

The benchmark defines **19** behavioral scenarios on [the-internet.herokuapp.com](https://the-internet.herokuapp.com/): navigation and text, dynamic and form controls, visual layout and images, keyboard input, hover, JavaScript dialogs, multiple windows, and a range slider. Scenarios are numbered in the [test source](tests/adaptive-minimal-public-benchmark.spec.ts). All live scenarios require `ADAPTIVE_MINIMAL_PUBLIC_BENCHMARK=1`, `OPENAI_API_KEY`, and `ADAPTIVE_LIVE_MODEL`.

```powershell
# One scenario (2)
npx.cmd playwright test tests/adaptive-minimal-public-benchmark.spec.ts --grep 'opt-in public minimal benchmark 2$' --workers=1 --reporter=line

# A subset (1, 2, and 3)
npx.cmd playwright test tests/adaptive-minimal-public-benchmark.spec.ts --grep 'opt-in public minimal benchmark (1|2|3)$' --workers=1 --reporter=line

# All 19 scenarios
npx.cmd playwright test tests/adaptive-minimal-public-benchmark.spec.ts --grep 'opt-in public minimal benchmark' --workers=1 --reporter=line
```

Set the live opt-in and credentials as in [Quick start](#quick-start) before these commands. A Playwright test can complete successfully while the agent returns `FAIL` or `INCONCLUSIVE`; read the `ADAPTIVE_MINIMAL_PUBLIC_<number>` console record and final evaluator verdict. The latest development results were **18 PASS and 1 INCONCLUSIVE across 19 scenarios**, collected over multiple development runs. This is a development observation, not a measured reliability rate.

## Evaluation results

- **PASS:** cited clean browser evidence supports all material parts of the instruction.
- **FAIL:** reliable clean evidence contradicts a material part.
- **INCONCLUSIVE:** evidence is insufficient, the evaluator cannot complete, or an execution/reset/budget issue prevents a supported verdict.

Discovery informs the second attempt, but the evaluator sees only clean execution evidence. The executing model's completion claim is not the verdict. Each attempt has a separate browser context and current page references. For public scenarios, a fresh context plus navigation to the exact start URL is verified; that does **not** prove the website's server-side state was reset.

## Configuration

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | Required credential for live model calls. |
| `ADAPTIVE_LIVE_MODEL` | Required OpenAI model identifier; use an image-capable model available to your account. |
| `ADAPTIVE_MINIMAL_PUBLIC_BENCHMARK=1` | Enables the 19 public scenarios. Otherwise they are skipped. |
| `ADAPTIVE_MINIMAL_HEADED=1` | Opens the benchmark's Chromium browser visibly; otherwise headless. |
| `ADAPTIVE_MINIMAL_SLOW_MO_MS=<non-negative integer>` | Optional Playwright action delay in milliseconds; defaults to `0`. |
| `ADAPTIVE_MINIMAL_BROWSER_SELFTEST=1` | Enables local offline browser/context and popup smoke tests. |
| `ADAPTIVE_MINIMAL_ARTIFACT_SELFTEST=1` | Enables the local offline artifact self-test. |
| `ADAPTIVE_MINIMAL_LIVE=1` | Enables the separate real-model local fixture test. |

The semantic-general route has its own trusted admission configuration. Its approval variables are not prerequisites for the minimal public benchmark.

## Repository structure

| Path | Role |
|---|---|
| `app/adaptive-minimal/` | Minimal controller, browser tools, model adapter, and contracts. |
| `app/adaptive/` | Shared browser observation/action code and retained older adaptive implementation. |
| `tests/adaptive-minimal*.spec.ts` | Offline minimal tests, opt-in local live test, public benchmark, and offline self-tests. |
| `tests/support/` | Local browser fixtures for offline tests. |
| `app/interpretation/`, `app/exploration/`, `app/runner/`, `src/` | Separate semantic-general route and Python host/UI. |
| `docs/`, `tools/experiments/`, `spikes/` | Current route documentation, history, and experiment evidence. |

## Testing

These minimal-agent and benchmark checks run locally without OpenAI calls. They still require Playwright Chromium:

```powershell
npx.cmd playwright test tests/adaptive-minimal.spec.ts --workers=1 --reporter=dot
$env:ADAPTIVE_MINIMAL_BROWSER_SELFTEST = '1'
$env:ADAPTIVE_MINIMAL_ARTIFACT_SELFTEST = '1'
npx.cmd playwright test tests/adaptive-minimal-public-benchmark.spec.ts --grep 'offline' --workers=1 --reporter=dot
Remove-Item Env:ADAPTIVE_MINIMAL_BROWSER_SELFTEST,Env:ADAPTIVE_MINIMAL_ARTIFACT_SELFTEST
npm.cmd run typecheck
npm.cmd run build
```

`npm.cmd test` runs the existing semantic-general and older adaptive TypeScript suites, then the Python suite; it requires Python and `uv` and does not replace the minimal-agent commands above. The opt-in public benchmark and `tests/adaptive-minimal-live.spec.ts` make provider calls only when their flags, model, and credential are present.

## Limitations and future work

The evaluator can make semantic mistakes, including misreading visual or textual evidence. Some applications need a trusted application reset beyond a fresh browser context. Browser actions remain limited to the vocabulary above, and public-site loading can be unstable. The current minimal model adapter uses OpenAI Responses. AWS Bedrock / Claude Opus integration is planned but has not been implemented.

## Troubleshooting

- **Live scenario skipped:** set `ADAPTIVE_MINIMAL_PUBLIC_BENCHMARK=1` and provide nonempty `OPENAI_API_KEY` and `ADAPTIVE_LIVE_MODEL` in `.env` or the shell. The local fixture live test uses a different opt-in flag.
- **Missing API key or model access:** check `.env` and your provider account. Existing shell values take precedence.
- **Chromium executable missing:** run `npx.cmd playwright install chromium` from the repository root.
- **Browser not visible:** set `ADAPTIVE_MINIMAL_HEADED=1` and run in an interactive Windows desktop session. The default is headless.
- **Public page navigation delay:** retry the individual scenario and inspect the bounded browser diagnostic under `test-results/`; a public-site delay is not an agent PASS or FAIL.
- **Playwright says passed, but the task did not:** inspect the agent's printed verdict. The harness records the experiment even when the adaptive result is FAIL or INCONCLUSIVE.
