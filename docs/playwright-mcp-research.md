# Playwright MCP and Playwright research

Checked 2026-09-19. Sources are the current official `microsoft/playwright-mcp` README and Playwright documentation. The MCP README is a moving `main` document; pin `@playwright/mcp` in production and recheck its release notes when upgrading.

## Executive findings

Playwright MCP is an exploration and browser control layer over Playwright. Its normal interaction model is a structured accessibility snapshot with ephemeral element references. It can then generate a Playwright locator and, with the testing capability enabled, expose assertion tools. The generated locator is an input to test generation, not a guarantee that the locator is durable or that the current session's `ref` can be reused in a test.

Playwright Test supplies the durable test runner, isolated BrowserContexts, web first assertions, authentication state, screenshots, video, and traces. The recommended conversion boundary is: use MCP to discover and exercise the user flow; retain the semantic locator and frame or shadow root context; generate ordinary Playwright code; then run it in a fresh isolated test and review the locator and assertions.

## MCP snapshot and locator tools

### Accessibility snapshots (documented)

The MCP server operates on the page accessibility tree. Tool results contain a structured representation with roles, accessible names, text, and MCP element references such as `ref=e5`. Actions accept the exact reference from a snapshot or a unique element selector. `browser_snapshot` is explicitly described as an accessibility snapshot and as preferable to a screenshot for actions. It supports `target`, `filename`, `depth`, and `boxes`; boxes are viewport relative CSS pixel rectangles from `Element.getBoundingClientRect()`.

References: [MCP README: accessibility snapshots](https://github.com/microsoft/playwright-mcp#accessibility-snapshots), [MCP tool definitions](https://github.com/microsoft/playwright-mcp/blob/main/README.md#tools) (`browser_snapshot`, approximately lines 1085-1093), [Playwright locator ariaSnapshot API](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot).

Playwright's AI optimized aria snapshot mode (`mode: 'ai'`, added in v1.59 in the current API docs) includes element references, does not wait for a matching locator, throws when no elements match, and includes snapshots of `<iframe>`s inside the target. This is Playwright API behavior; the MCP implementation's snapshot formatting and ref lifetime remain MCP behavior.

### `browser_find` (documented)

`browser_find` searches the current page snapshot, rather than the raw DOM. `text` performs a case insensitive substring search; `regex` performs a regular expression search and is case sensitive by default (flags can be supplied using slash syntax such as `/error/i`). Exactly one of `text` or `regex` is provided. It returns matching snapshot nodes with surrounding context and their paths, which is cheaper than fetching the complete snapshot. A match can therefore only be as good as what the accessibility snapshot exposes.

Reference: [MCP README: browser_find](https://github.com/microsoft/playwright-mcp/blob/main/README.md#tools) (approximately lines 1007-1013).

### `browser_snapshot` (documented)

`browser_snapshot` returns the current accessibility tree; optionally it scopes to a snapshot target, limits tree depth, adds bounding boxes, or writes the snapshot to a workspace relative file. It is read only. The snapshot references are for the active MCP page/session and should be treated as transient discovery handles.

Reference: [MCP README: browser_snapshot and screenshot](https://github.com/microsoft/playwright-mcp/blob/main/README.md#tools) (approximately lines 1085-1104).

### `browser_generate_locator` (documented)

`browser_generate_locator` is in the MCP test assertions capability. It takes a snapshot ref or unique selector (`target`) plus an optional human readable `element` description and generates a locator intended for use in tests. The README does not specify its ranking algorithm, stability proof, or a promise that the output is unique across future page versions. Treat output as a candidate locator to review and execute in a clean test.

Reference: [MCP README: test assertions and browser_generate_locator](https://github.com/microsoft/playwright-mcp/blob/main/README.md#tools) (approximately lines 1424-1431).

## Testing capability and `--caps=testing`

The README labels `browser_generate_locator`, `browser_verify_element_visible`, and related assertion tools as “Test assertions (opt-in via `--caps=testing`)”. The current generated CLI option table, however, lists `vision`, `pdf`, and `devtools` as the possible `--caps` values and the TypeScript config type likewise lists core/pdf/vision/devtools, without listing `testing`. This is an official-documentation inconsistency. Verify the installed MCP version with `npx @playwright/mcp --help` or `browser_get_config` before relying on `--caps=testing`; pin and test the version used by the system. The tool section is direct evidence that testing tools are capability gated, while the option table is evidence that the CLI reference may lag the implementation.

References: [MCP README CLI options](https://github.com/microsoft/playwright-mcp/blob/main/README.md#cli-options) (approximately lines 472-475), [MCP README config capabilities](https://github.com/microsoft/playwright-mcp/blob/main/README.md#configuration) (approximately lines 727-733), [MCP README test assertions](https://github.com/microsoft/playwright-mcp/blob/main/README.md#tools).

## Evidence and diagnostics

### Screenshots

MCP `browser_take_screenshot` captures the current page or a target element. It supports PNG/JPEG/WebP type, an optional full scrollable page, CSS or device scale, and an output filename. The README explicitly says screenshots are for visual verification and that actions should use `browser_snapshot`. Playwright's `page.screenshot()` supports image options and `fullPage: true`.

References: [MCP screenshot tool](https://github.com/microsoft/playwright-mcp/blob/main/README.md#tools), [Playwright screenshots](https://playwright.dev/docs/screenshots).

### Video

Playwright Test video is off by default. `video` may be `on`, `off`, `retain-on-failure`, or `on-first-retry`. Library usage is `browser.newContext({ recordVideo: { dir } })`; the context must be closed for the video to be saved. MCP's documented recording tool is `browser_start_recording`, which records user actions as Playwright code and is a code recording feature, not documented video capture. Do not infer that MCP exploration automatically yields a video artifact; configure Playwright video explicitly in the generated test or use the context API.

Reference: [Playwright videos](https://playwright.dev/docs/videos).

### Tracing

Playwright Test supports `trace: 'on-first-retry'`, `'on-all-retries'`, `'retain-on-failure'`, `'on'`, and `'off'`; the docs recommend first retry on CI and warn that tracing every test is performance heavy. Library usage starts `context.tracing.start({ screenshots: true, snapshots: true })` before page creation/navigation and stops to a `trace.zip`. Trace Viewer provides action locator, DOM snapshots, screenshots/filmstrip, logs, network, metadata, and attachments. MCP exposes `browser_start_tracing` and `browser_stop_tracing` in the DevTools capability; inspect the installed version for their exact output and lifecycle.

References: [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer), [MCP DevTools tools](https://github.com/microsoft/playwright-mcp/blob/main/README.md#tools).

## Contexts and authentication

### MCP persistent versus isolated sessions (documented)

MCP defaults to a persistent profile. Its README says logged-in information is stored in a workspace-derived profile, configurable with `--user-data-dir`; only one browser instance can use a persistent profile at once. `--isolated` starts a fresh isolated profile and loses its storage when the browser is closed. An isolated session can be initialized with `--storage-state` or `contextOptions`. The Chrome extension can attach to an existing Edge/Chrome browser and use its logged-in browser state. `--shared-browser-context` reuses one context between connected HTTP clients; this is a deliberate shared-state mode and should not be used for independent parallel explorations without a concurrency design.

References: [MCP README: user profile and initial state](https://github.com/microsoft/playwright-mcp#user-profile), [MCP README: configuration](https://github.com/microsoft/playwright-mcp/blob/main/README.md#configuration).

### Playwright Test isolation and auth (documented)

Playwright Test creates a BrowserContext per test. Contexts have separate cookies, local storage, session storage, and other state. The auth guide recommends creating authenticated state under `playwright/.auth`, adding it to `.gitignore`, and reusing it through `storageState`; state files can contain sensitive cookies and headers. A setup project can authenticate once before dependent projects. Tests that mutate shared server state should use separate accounts or worker-scoped auth.

References: [Playwright isolation](https://playwright.dev/docs/browser-contexts), [Playwright authentication](https://playwright.dev/docs/auth), [BrowserContext storageState](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state).

## Elements that snapshots may not expose

### Shadow DOM (documented Playwright behavior)

Playwright locators pierce open shadow roots by default. XPath does not pierce shadow roots, and closed-mode shadow roots are unsupported. The MCP README does not document a separate shadow DOM snapshot or locator contract. Therefore, an open shadow component may be reachable through normal Playwright locators, but whether MCP's snapshot contains the useful semantic node and whether `browser_generate_locator` emits the desired host or descendant locator must be verified against the installed MCP version.

Reference: [Playwright locators: shadow DOM](https://playwright.dev/docs/locators#locate-in-shadow-dom).

### Iframes (documented Playwright behavior; MCP caveat)

Playwright interactions default to the main frame. Content inside an iframe is accessed with `frameLocator()` or a `Frame` object. The current Playwright AI aria snapshot docs say AI mode includes snapshots of iframes inside the target, and MCP examples show iframe descendants can appear with a frame ref. The MCP README does not document a generated-locator format for nested frames. Generate and retain an explicit frame scope such as `page.frameLocator(...).getByRole(...)`, then validate it in a fresh test.

References: [Playwright frames](https://playwright.dev/docs/frames), [Playwright locator ariaSnapshot](https://playwright.dev/docs/api/class-locator#locator-aria-snapshot), [MCP README tools](https://github.com/microsoft/playwright-mcp/blob/main/README.md#tools).

### Custom components and canvas (documented limits plus inference)

Custom elements are locatable when they expose normal DOM semantics, labels, roles, text, or test ids; Playwright's recommended locators are role, text, label, placeholder, alt text, title, and test id. Canvas pixels do not themselves provide DOM descendants or accessible roles. The MCP README documents coordinate mouse tools, `browser_evaluate`, `browser_run_code_unsafe`, and screenshots, but does not promise semantic discovery or generated locators for canvas-rendered controls. This means canvas interaction normally requires an application-provided accessible surface, coordinate/pointer actions, or page evaluation; the latter two are less durable and require runtime validation. This last recommendation is an inference from the documented APIs and the absence of a canvas-specific MCP contract.

References: [Playwright locators](https://playwright.dev/docs/locators), [MCP README core tools](https://github.com/microsoft/playwright-mcp/blob/main/README.md#tools).

### Fallbacks when accessibility discovery misses an element

Documented MCP mechanisms include: resnapshot after state changes; target a unique selector where available; use `browser_evaluate` or `browser_run_code_unsafe` for arbitrary Playwright/page code; use coordinate mouse tools (available as core/vision tools); and use screenshot/annotation tools for visual diagnosis. Documented Playwright mechanisms include role/label/text/test-id/CSS locators, `frameLocator`, open-shadow traversal, `locator()`/evaluation, and `page.mouse`. Use a screenshot to diagnose layout, not as the locator source. MCP's README does not define a general “search raw DOM” tool or guarantee that arbitrary hidden/non-accessible nodes are represented in snapshots.

## Recommendations for the natural-language-to-test pipeline

The following are recommendations grounded in the cited Playwright guidance, with implementation choices marked as inference:

1. Preserve a structured step plus the exploration URL, browser/context mode, auth state identity, snapshot, frame path, and generated locator. Snapshot refs are session handles, so regenerate them after navigation or rerender (inference from their session-scoped API).
2. Ask MCP for `browser_generate_locator`, then review the returned code. Prefer user-facing and explicit contract locators (`getByRole`, `getByLabel`, `getByText`, `getByTestId`) and chain/filter to make a locator unique. Avoid CSS classes and XPath unless the app exposes no durable contract. This follows Playwright's locator and best-practices guidance.
3. Keep frame scope and shadow host scope as first-class fields in the specification. A locator without its frame context is incomplete.
4. Convert actions into Playwright Test code with web-first assertions (`await expect(locator).toBeVisible()`, `toHaveText()`, etc.), which wait and retry. Do not encode arbitrary sleeps from exploration unless a concrete external condition requires it.
5. Run generated tests in fresh per-test contexts, using a setup project and `storageState` for authentication. Never commit auth state files. Avoid relying on MCP's persistent profile for test isolation.
6. Attach evidence deliberately: screenshots at meaningful checkpoints or on failure, video `retain-on-failure`/`on-first-retry` as appropriate, and traces `on-first-retry` or `retain-on-failure`. Keep the MCP exploration trace or screenshots as discovery evidence, separate from deterministic test artifacts.
7. Require an execution validation pass. A locator generated from one DOM state is only durable if it is unique and passes after a fresh navigation, a fresh context, and the intended auth bootstrap. This is an engineering acceptance rule, not an MCP guarantee.

References: [Playwright best practices](https://playwright.dev/docs/best-practices), [Playwright locators](https://playwright.dev/docs/locators), [Playwright assertions](https://playwright.dev/docs/test-assertions), [Playwright auth](https://playwright.dev/docs/auth), [Playwright trace viewer](https://playwright.dev/docs/trace-viewer).

## Ambiguities and required runtime checks

- Resolve the `--caps=testing` documentation mismatch against the exact `@playwright/mcp` version used by the system.
- Test snapshot and generated-locator behavior for the application's custom elements, open/closed shadow roots, nested/cross-origin iframes, and canvas UI. Official docs establish Playwright primitives but do not promise MCP coverage for every component implementation.
- Test whether a generated locator remains unique after rerender and in a new BrowserContext. The MCP docs do not define a stability score or formal durability guarantee.
- Verify trace/video output paths, artifact retention, and whether MCP recording tools are enabled in the chosen capability set.

Confidence is high for the explicitly documented Playwright APIs and MCP tool signatures; medium for cross-boundary MCP behavior because the current MCP README documents the core accessibility model and tools but does not specify every shadow DOM, iframe, custom-element, or canvas case.
