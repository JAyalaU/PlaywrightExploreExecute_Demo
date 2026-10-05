# Deferred live browser view: recovery audit

**Scope and repository state (2026-10-05).** This is a read-only audit of the interrupted `deferred-action-v1` live-view work. The pre-existing five-step PoC and its authoritative public QA pass are the baseline; the working tree contains 12 modified and five new files for an uncommitted live-view addition. No existing PoC action, assertion, trace, compiler, replay, or result schema was redesigned by this work. `docs/system-overview.md` and `docs/current-status.md` still describe agentic live viewing as unavailable, so they are historical context for this diff rather than the current implementation.

## Recovery finding

The live-view path is **wired and passes bounded offline tests**, including one protected exact five-step fixture that compares the same isolated profile with viewing disabled and enabled. It is **not yet a demonstrated Streamlit/noVNC visual path**: the tests authenticate lifecycle notices and preflight the real headed Docker/RFB service, while Python UI tests mock the viewer handle and no test confirms that an operator actually sees pixels in each phase. No provider or public-site run was performed during this audit.

The highest-confidence defect is presentation truth. With `PLAYWRIGHT_DEMO_LIVE_VIEW=1`, `ProtectedContextFactory` launches physical headed Chromium but retains the accepted profile's `presentationMode: "headless"` and fingerprint. `ResultRecordV2` and the UI still treat that value as headless metadata; the UI does not explain the physical headed runtime. This preserves the current two-replay QA rule and accepted artifact identity, but a viewer can reasonably misread the displayed result as proof of headless browser execution. The offline fixture proves the same QA classification for one local page, not physical headed/headless equivalence on every site.

## Capability state

| Capability | State | Current evidence and limit |
|---|---|---|
| Headed, viewable Chromium | **NEW, offline proven** | Trusted deferred flag selects the headed isolated image for each session; the effective profile and fingerprint stay fixed. Real Docker fixture opened four sessions. |
| VNC/noVNC endpoint | **HISTORICAL, adapted** | Legacy `ViewerGateway` already serves loopback noVNC assets and a view-only RFB WebSocket. New runtime-headed gate permits the deferred profile; a 20-minute optional lifetime and failure callback were added. Pixel rendering in Streamlit remains unverified. |
| Lifecycle channel | **NEW, offline proven** | Dedicated authenticated Node/Python v1 side channel, separate from P4 event sequences, carries bounded `ready`, `closed`, `transition`, and `unavailable` notices. Unit and local integration tests cover normal ordering. |
| View-only controls | **HISTORICAL, reused** | Gateway RFB parser rejects keyboard/pointer/clipboard input and the noVNC client sets `viewOnly`; new code grants no browser control. The legacy security proof was not rerun in this audit. |
| Session ownership | **NEW, offline proven** | Factory attaches the gateway to the exact protected session; exploration/compiler use attempt IDs and replays use run IDs. The fixture matches all four notice owners to the final result IDs and sees four distinct contexts. |
| Streamlit embedding | **PARTIAL** | A 500 ms fragment renders the new buffer through existing noVNC markup, clears old handles, and names the phase. Python tests mock UI calls; actual browser pixels, iframe behavior, and how long fast replay phases remain visible are unverified. |
| Phase/status display | **NEW, partial visual proof** | The buffer enforces exploration → compilation → replay 1 → replay 2 and reports preparing, switching, closed, or unavailable. It is observation status only, never terminal QA truth. |
| Exploration view | **NEW, offline proven** | The viewer starts before initial navigation; the exact fixture receives its `ready` and `closed` notices. |
| Compilation view | **NEW, offline proven** | Production sets the phase before the fresh compiler opens its browser; the fixture receives compiler `ready`/`closed`. |
| Replay 1 and Replay 2 view | **NEW, offline proven** | The replay loop sets each ordinal before the runner opens a fresh browser; both owners and closures appear in the fixture. |
| Cleanup | **HISTORICAL with NEW hooks, offline proven** | Protected session close revokes the gateway; cancellation and host exit close the channel; preflight failure is non-QA and records verified/unverified session cleanup. The normal fixture reports verified cleanup. Forced-exit residual-container behavior was not retested here. |

## Actual data flow

```text
trusted Streamlit workflow + PLAYWRIGHT_DEMO_LIVE_VIEW=1
  → UiRun creates DeferredViewerBuffer; 500 ms fragment reads it
  → ui_workflow passes buffer to host.call_node(protocol v2)
  → host opens authenticated loopback DeferredViewerChannel and passes
    port/stream UUID/capability in child environment
  → agentic CLI selects deferred-action-v1; local deferred workflow connects
    the Node DeferredViewerLifecycle and builds ManagedFactory(viewOnlyHeaded)
  → production marks exploration, compilation, then replay_1/replay_2
  → each factory.open creates the actual protected headed isolated session
  → ViewerGateway preflights its RFB service on that session, then Node publishes
    a temporary view-only endpoint with phase, owner and TestSpec ID
  → Python validates sequence/owner/phase and Streamlit embeds noVNC
  → session close revokes endpoint; host/UI close remaining channel and handle
```

The trace, compiler artifact, resolved test, replays, and ResultRecord remain the QA authority. Viewer notices are private, volatile display state. A channel or gateway loss after browser work starts removes the view; it cannot produce a QA failure. Preflight failure before browser work stops as an environment/bridge condition. The UI receives the viewer through a trusted launch flag, not through task text.

## Exact working-tree inventory

| File | Live-view change |
|---|---|
| `app/profile/context.ts` | Adds a trusted `viewOnlyHeaded` factory option and checks actual isolated headed runtime before exposing RFB. The same returned protected session is used for automation and viewing. |
| `app/profile/isolated-browser.ts` | Exposes actual headed state and lets deferred viewing omit the historical 750 ms headed `slowMo`. The legacy default remains. |
| `app/observability/viewer-gateway.ts` | Reuses the historical view-only endpoint, gates on actual headed isolation, and adds bounded lifetime/unavailability callbacks. Its noVNC/RFB parser is otherwise inherited. |
| `app/observability/deferred-viewer-channel.ts` **new** | Defines the closed notice schema, authenticated launch handshake, per-session endpoint lifecycle, reconnect rotation, and preflight cleanup marker. It is separate from legacy P4 event correlation. |
| `app/local/deferred-workflow.ts` | Reads the trusted flag, connects the side channel, creates a headed-view factory only for the deferred route, and attaches the gateway before each session is returned to its caller. |
| `app/interpretation/deferred-action-production.ts` | Emits phase callbacks before exploration and compilation, and passes replay ordinal callbacks. It recognizes first-session viewer preflight cleanup without promoting an environment stop to QA. |
| `app/interpretation/deferred-action-replay.ts` | Adds an optional per-run callback before each existing fresh deterministic replay. Replay agreement logic is unchanged. |
| `app/exploration/deferred-trace-compiler-v4.ts` | Carries an unverified viewer preflight cleanup into the compiler's non-QA rejection record. Compilation correspondence is unchanged. |
| `app/runner/deferred-v9.ts` | Carries an unverified viewer preflight cleanup into a non-QA runner stop. Deterministic action and assertion execution is unchanged. |
| `src/playwright_demo/deferred_live_viewer.py` **new** | Authenticates the separate loopback stream, validates strict notice fields and phase order, and holds only the current endpoint in memory. It clears the prior handle on close/transition/unavailability. |
| `src/playwright_demo/host.py` | Allows this deferred-only v2 channel while retaining the prohibition on legacy P4 agentic channels. It passes the private launch capability to Node and closes the channel on normal, failure, and cancellation paths. |
| `src/playwright_demo/ui_workflow.py` | Accepts the deferred buffer only for trusted deferred live-view selection and passes it through to the host. It leaves the result/projection decision path unchanged. |
| `src/playwright_demo/ui_shell.py` | Creates a per-run deferred buffer and renders phase/status with the inherited noVNC markup. It closes the display at run completion; the final result does not yet explain the physical headed/runtime-profile distinction. |
| `tests/deferred-live-view-channel.spec.ts` **new** | Checks Node handshake, capability consumption, invalid acknowledgement, and closed notice schema. |
| `tests/deferred-live-view-runtime.spec.ts` **new** | Checks the same isolated session can open a gateway, disabled mode stays headless, timeout leaves the browser alive, and non-isolated profiles are denied. |
| `tests/python/test_deferred_live_viewer.py` **new** | Checks Python channel, strict ordering, reconnect/expiry, EOF, trusted UI plumbing, and clearing old handles. UI output is mocked. |
| `tests/deferred-poc-functional-closure.spec.ts` | Adds one real isolated, locally routed comparison of view-off versus view-on exact five-step QA. It checks four fresh contexts, four phase owner IDs, notices, and verified cleanup without provider/public traffic. |

There are no relevant literal `TODO` or `FIXME` markers in the changed live-view files. `app/subprocess/agentic-cli.ts` and `app/local/agentic-workflow.ts` are untouched but already delegate to the modified deferred workflow; they are not missing route links. `docs/system-overview.md` and `docs/current-status.md` are untouched and now stale on agentic viewing. The legacy P4 viewer/event/image stack still exists for its separate route; it is not used as deferred QA evidence. After a deferred `unavailable` notice, Python intentionally refuses further handles, while Node may try to publish at a later phase; the observation stays unavailable and QA continues. No cross-process reconciliation of viewer owner IDs against the final ResultRecord is implemented; the stream is authenticated and private but observational.

## Bounded validation and residual risk

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed.
- Node viewer channel/runtime tests: 7 passed.
- Python deferred viewer tests: 9 passed.
- Protected local exact five-step view-off/view-on integration: 1 passed in 32.9 seconds; both runs reached `QA_ASSERTION_PASSED`, and the viewed run emitted four ordered session lifecycles with verified cleanup. This required Docker access outside the command sandbox. All public-looking URLs were fulfilled by local protected fixtures; no provider or public-site request ran.

The remaining release risk is the unobserved human-facing pixel path, especially brief replay phases, plus the misleading headless presentation label. The protected fixture proves one local equivalence case; it cannot prove that a site's responsive layout behaves identically under physical headed Chromium. A live provider/public run and actual Streamlit rendering have not been performed for this live-view diff.

## Exactly one next atomic implementation task

**Make runtime presentation explicit in the deferred UI without changing QA authority.** In `src/playwright_demo/ui_shell.py`, render a trusted note when deferred live view is enabled that physical Chromium is headed and `ResultRecord.presentationMode` records the accepted headless profile, then add focused assertions in `tests/python/test_deferred_live_viewer.py`. Keep the result schema, profile fingerprint, replay agreement, and historical headed route unchanged. This removes the confirmed user-facing ambiguity with a small, testable change; a separate operator-visible pixel proof remains a release validation gate after that task.

## Replay and navigation differential (2026-10-05)

Authenticated artifacts for TestSpec `local-bf832a09-7641-4c28-b9b8-2313aab9536b` show a successful five-step exploration trace, accepted compiler/resolved artifacts, and replay-pair agreement `not_established`. The public terminal was `REPLAY_EXECUTION_FAILED`, not a QA assertion failure; both runner cleanups were verified. The two replays used the same resolved v9 artifact and fresh contexts.

| Boundary | Replay 1, `run-573d53d2-9e6c-49f0-a0a2-bfc7eef633a3` | Replay 2, `run-6f6595ad-9c68-4ec1-a122-daac203734c2` |
|---|---|---|
| Root navigation | Completed | Completed |
| Link binding/click | Exact main-frame link named `Dropdown`, unique guard; click returned in 137 ms | Same resolved guard; click returned in 143 ms |
| URL assertion | Actual URL exactly `https://the-internet.herokuapp.com/dropdown`; true | Same exact URL; true |
| State reacquisition | `rich_after_url` produced full state epoch 4, then select execution continued | `rich_after_url` produced full state epoch 4; the next full read produced epoch 5 and a different state digest, with mutation epoch still 3 |
| Select binding/action | Unique native select; value `1` selected; native effect witnessed | **First stop:** `STATE_CONTINUITY_MISMATCH` at the initial state comparison inside `execute()`, before candidate proof or locator binding; invocation `not_invoked`. No run-2 select cardinality was recorded. |
| Selected-option assertion | Selected `Option 1` observed true, one owner and one label match; completed with two true assertions | Not reached; one true URL assertion persisted |
| Persistence/cleanup | Completed in 33,767 ms; verified cleanup | Non-QA stop in 63,678 ms; verified cleanup |

The failing predicate is `same(await this.state(), before)` in `app/runner/deferred-v9.ts` before `prove(action)`. `state()` hashes bounded frame content and control values with page and mutation identity. The page ID and mutation epoch did not change across these reads; the state digest did. The artifact does not preserve the differing DOM/control field, a network response, a console error, a post-step-3 URL, or a page count. It therefore establishes state drift between two reads, not a stale select, an ambiguous select, a failed click, or a specific DOM cause. Replay 1 proves that the resolved locator and select assertion can complete on this public page in one fresh run.

The latest exploration startup recorded a 30,651 ms initial MCP root navigation. After it returned, the authored root navigation and a uniquely actionable `Dropdown` link were observed within roughly 0.85 seconds; the click returned successfully. Compiler root navigation and replay start-to-click intervals also occupied tens of seconds. Replay 1 and replay 2 start-to-click were 31,890 ms and 62,225 ms respectively. The runner implicitly navigates to the trace start URL and then executes the identical authored root navigation. Exploration and compiler do the same two navigations through MCP. MCP `browser_navigate` uses `domcontentloaded` in the installed package; runner `page.goto` omits `waitUntil` and therefore waits for Playwright's default `load`. Per-navigation elapsed times and the instant the link first became actionable are not persisted, so neither the duplicate request's individual cost nor earlier link readiness can be quantified.

The 30/60-second start-to-click pattern also appeared in an earlier headless run without live viewing (about 29.4/61.6 seconds). There is no persisted viewer failure or timing evidence that attributes this replay stop or navigation delay to headed presentation. A physical headed effect remains unmeasured. The smallest targeted readiness change to evaluate is to skip the implicit bootstrap navigation when the first authored navigation is to the identical URL, retaining the authored navigation and fresh target proof. Aligning runner navigation with MCP's `domcontentloaded` wait is a separate bounded optimization. Validate either change on same-URL, different-URL, redirect, and delayed-content fixtures before another public run; neither change by itself explains the observed step-4 state drift.
