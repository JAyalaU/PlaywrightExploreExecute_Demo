# Operator runbook: semantic-general PoC

This runbook covers the **single** current product route. The [architecture](architecture.md) explains authority and QA; [supported capabilities](supported-capabilities.md) describe valid instructions. Current source is authoritative if a command or contract changes.

## Prepare

Use Windows with Node.js 24 (`>=24 <25`), npm, Python 3.12+, and `uv` ([package.json](../package.json), [pyproject.toml](../pyproject.toml)). From the repository root:

```powershell
npm ci
npx playwright install chromium
uv sync
npm run build
```

The browser is bundled Playwright Chromium under a native schema-5 `local-windows` profile. Docker is not involved.

## Approve the target and configure the run

Create a trusted config by inspecting the exact public HTTP(S) URL, reviewing it, and explicitly approving it in an interactive terminal. For example:

```powershell
node dist/profile/admission-cli.js inspect 'https://your-approved-host.example.org/path'
```

Replace the example URL with the exact public target. Save only the CLI JSON output to a **private UTF-8 local file** for the next command; an ordinary `npm run` banner must not be included. Then run `npm run admit:public -- approve <inspection.json> <new-trusted-config.json> <private-artifact-root>` (or `approve-headed` for a headed profile). The CLI requires a TTY, repeats the inspection, prompts for the **complete canonical URL**, and creates the output file exclusively. See [`admission-cli.ts`](../app/profile/admission-cli.ts) for arguments and [native admission](../app/profile/native-admission.ts) for validation. Keep configuration and artifact paths private. The config contains a schema-5 profile, native fingerprint-bound `publicTargetApproval`, evidence policy, artifact root, and retention; it contains no provider credential. A separately prepared config must satisfy the same strict [trusted-config contract](../app/local/product-contracts.ts). The approved URL must match the request exactly. Both Python selection and direct Node execution verify target, profile reference, and fingerprint **before browser creation**.

Reviewed DNS addresses and the inspection digest are operator approval metadata. **Local Chromium does not enforce DNS pins or network egress restrictions.** Only approve targets appropriate for this local process and network environment.

Set `PLAYWRIGHT_DEMO_TRUSTED_CONFIG` to the config path and `OPENAI_API_KEY` in the process environment or the gitignored repository `.env` file. Existing environment values take precedence over `.env` ([project environment loader](../app/local/project-env.ts), [Python loader](../src/playwright_demo/project_env.py)). Never paste credentials into task text, config examples, reports, or screenshots.

Optional settings:

| Variable | Use |
|---|---|
| `PLAYWRIGHT_DEMO_LIVE_VIEW=1` | Enable the private local frame-v2 viewer. The trusted config must also authorize display where required. |
| `PLAYWRIGHT_DEMO_ACTION_PAUSE_MS` | Bounded presentation pause between actions; it does not affect QA authority. |
| `PLAYWRIGHT_DEMO_UI_DIAGNOSTICS=1` | Opt-in closed local UI/host diagnostic events. Keep private. |

Do not set `PLAYWRIGHT_DEMO_WORKFLOW_VERSION`, `PLAYWRIGHT_DEMO_BROWSER_BACKEND`, or historical route gates for normal use. An explicit retired workflow or any nonempty backend selector fails closed.

## Launch and demonstrate

```powershell
uv run playwright-demo-ui
```

The launcher checks Streamlit bind configuration and serves only on `127.0.0.1` (the port may follow Streamlit configuration); it accepts no binding arguments ([launcher](../src/playwright_demo/ui_launcher.py)). Enter the **exact approved URL** and a supported natural-language test. The form cannot select a profile or backend.

For a successful request, expect: (1) primary semantic interpretation and independent fidelity review; (2) protected browser grounding and action receipts; (3) a fresh compiler session and authenticated ResolvedTestSpec v10; (4) two fresh runner-v10 replays; (5) replay-pair agreement and a v2 terminal result. Frame-v2 live view, when enabled, shows observational JPEG frames for exploration, compilation, replay 1, and replay 2. It cannot control the browser or decide QA. The ordinary semantic result shows a typed terminal and lineage; rich safe report details are currently unavailable.

## Read outcomes

| UI category | Meaning |
|---|---|
| QA passed / `QA_ASSERTION_PASSED` | Two completed fresh runs agreed on passing deterministic assertions and cleanup was verified. |
| QA failed / `QA_ASSERTION_FAILED` | Two completed fresh runs agreed on a failed deterministic assertion. |
| Request could not be interpreted | Semantic meaning, model output, normalization, or fidelity did not yield trusted TestSpec v7. No QA verdict. |
| Path not established | Browser grounding could not uniquely prove a target/mechanic or encountered an unsupported capability. No QA verdict. |
| Compilation failed | Fresh compiler evidence did not support deterministic Resolved v10. No QA verdict. |
| Replay / reproducibility failed | Replay stopped, or fresh runs disagreed. No QA verdict. |
| Environment/runtime failure | Provider, browser, trusted environment, viewer preflight, or cleanup failed. No QA verdict. |

The UI also shows bounded provenance and cleanup status. A missing optional projection does not change the typed terminal ([UI projection](../src/playwright_demo/ui_shell.py), [v2 terminal contract](../app/domain/agentic-result-v2.ts)). Keep private traces, model payloads, MCP data, and restricted evidence out of stakeholder-safe output.

## Troubleshoot

- **No launch or provider configuration error:** Check Node build, Python environment, `OPENAI_API_KEY`, and trusted config path. Do not put the key in the request.
- **Approval denied or profile mismatch:** Reinspect and approve the exact URL; confirm profile reference and native fingerprint. A changed profile requires new approval/config. Direct Node calls enforce the same approval.
- **Browser unavailable:** Confirm Windows and the Playwright Chromium installation. Browser creation/cleanup errors are environment stops, not QA failures.
- **Path not established or replay drift:** Check the instruction against [supported capabilities](supported-capabilities.md) and whether the page presents stable, uniquely identifiable controls. Do not treat a browser stop as a failed assertion.
- **Viewer unavailable:** Confirm opt-in setting and trusted display authorization. Preflight failure can stop the request as non-QA; later frame loss remains observational.
- **Public target unstable:** The target is external to this repository; navigation and page state can vary. Use deterministic local fixtures for engineering regression, and a separately approved live target for live integration proof.
