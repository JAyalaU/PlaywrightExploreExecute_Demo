# D4 developer-surface checkpoint

This records the final developer-command curation. It is cleanup history, not product architecture. Use the [current architecture](../../architecture.md) and checked-out source for implementation.

| Package command | Classification | Purpose |
|---|---|---|
| `build` | PRODUCT | Compile current `app/` TypeScript into `dist/`. |
| `typecheck` | PRODUCT | Check current app and test TypeScript. |
| `test` | DEFAULT_TEST | Run current semantic, native admission/browser, diagnostics, frame-v2, cancellation, and Python host/UI suites. |
| `test:semantic:integration` | LOCAL_INTEGRATION | Run the one provider-free loopback fixture through Python host, Node workflow, two replays, and QA. Requires a build. |
| `test:python` | DEFAULT_TEST helper | Run the bounded current Python host/UI/protocol suite; called by `test`. |
| `test:reproducibility-stores` | EXPERIMENT | Test authenticated admitted-v7 and grounded-trace-v1 stores used by fixed-input tools, outside the normal product path. |
| `admit:public` | PRODUCT | Native schema-5 target inspection/approval CLI. |

Removed redundant `test:fast`, `test:current`, `test:release`, and `test:all` aliases. The default excludes the two experiment-only store suites and all experiment cohort drivers. No package command launches an experiment cohort.

The sole checked-in config guidance is [config/README.md](../../../config/README.md). A trusted approval and profile fingerprint are issued by the interactive CLI; a static checked-in approval example would imply authority it cannot have. `PLAYWRIGHT_DEMO_TRUSTED_CONFIG` and `OPENAI_API_KEY` are live-run inputs; `PLAYWRIGHT_DEMO_LIVE_VIEW` and `PLAYWRIGHT_DEMO_ACTION_PAUSE_MS` are optional presentation inputs. `PLAYWRIGHT_DEMO_UI_DIAGNOSTICS` and provider live-debug flags are diagnostic-only. Workflow/backend selectors remain only as explicit fail-closed migration checks. The `PLAYWRIGHT_DEMO_DEFERRED_VIEWER_*` names are private frame-v2 channel wiring, not a deferred workflow selector. The obsolete `PLAYWRIGHT_DEMO_DEFERRED_ACTION_GATE` test setting was removed.

Current product names still bearing history: `app/local/agentic-workflow.ts`, `app/subprocess/agentic-{cli,entry}.ts`, and `app/domain/agentic-result-v2.ts` are semantic-general v2 host/result code; `app/domain/deferred-browser-diagnostics.ts` and frame-v2 `deferredViewerVersion`/`PLAYWRIGHT_DEMO_DEFERRED_VIEWER_*` are current diagnostics/wire labels. The `qa_deferred_*` prompt/provenance literals are current contract identity. Python `public_admission.py` and `protocol_v2.py` retain v1/agentic wording while serving current admission/protocol. Filename/API renames need a separate lineage review; wire and provenance values must not be changed casually.

`app/index.ts` was an unimported empty milestone stub and was removed along with its orphan `dist/index.js`. Current barrels export product APIs; the two experiment-only stores are imported by explicit paths in tools/tests and are not exported from `app/evidence/index.ts`.

Validation: `npm test` passed 163 current TypeScript tests and 32 bounded Python tests; `test:semantic:integration` passed its one end-to-end fixture; opt-in `test:reproducibility-stores` passed 32 tests. Typecheck, build, package JSON syntax, `git diff --check`, and link validation passed (346 relative Markdown-document links across 129 documentation files, none missing). A broader archival-code-link scan reported references to files intentionally removed in earlier cleanup phases; those historical source links are not current product guidance.
