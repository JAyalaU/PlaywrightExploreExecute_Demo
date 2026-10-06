# Browser backend A/B experiment

## Method

**State:** six-arm experiment completed (2026-10-05). The current checkpoint is `9f1a8611aecd0607dc23f74e05c40d862baa5dd3` plus the existing uncommitted Windows-native implementation. No production browser semantics were changed.

The dedicated [harness](../scripts/browser-backend-ab-experiment.mjs) reads the active trusted configuration, checks that its public approval is for `https://the-internet.herokuapp.com/`, selects the real versioned Docker or derived `local-windows` profile through `selectActivePocBrowserProfile`, and opens each fresh session with `ProtectedContextFactory`. It sets `PLAYWRIGHT_DEMO_BROWSER_BACKEND` before constructing each factory; runs are sequential in one Node process. Viewing is off for both arms. It does not invoke interpretation, OpenAI, MCP orchestration, candidate grounding, screenshots, compiler, runner, replay, or QA.

The run order was Docker, local Windows, local Windows, Docker, Docker, local Windows. Each arm created one page, made exactly one `page.goto('https://the-internet.herokuapp.com/', { waitUntil: 'domcontentloaded', timeout: 90000 })`, and closed its context/browser. The pinned MCP implementation behind the active exploration bootstrap also calls `page.goto` with `waitUntil: 'domcontentloaded'`; the harness used the same explicit boundary without invoking MCP. A passive main-document response listener captured status and redirect count. DOMContentLoaded and load event flags were snapshotted when `goto` returned. One immediate post-navigation document evaluation read `readyState`, whether the document URI was a Chromium error document, and counts of `a` and root `select` elements. Two Playwright locator counts read all link roles and exact-name `Dropdown` links. These were sequential measurements within one sampling phase, not an atomic DOM snapshot. The harness retained only bounded metadata; it did not read or store HTML, body/link text, headers, cookies, response bodies, or images.

The trusted configuration selects a **headed Docker v4** profile. Its derived local-Windows v5 profile is **headless**. No approved headless Docker source profile was found in the active configuration. Thus physical mode was an additional runtime difference; this experiment cannot isolate OS/network from head mode if a future result differs. Live viewing was off in both arms.

## Execution and results

An earlier preflight attempt found Docker Desktop's Linux engine unavailable and made no browser navigation. After Docker was restored, `docker info` passed (server 29.8.0), and the same harness ran all six arms sequentially. It exited 0. Each used a fresh protected browser/context, made one root request, and verified cleanup. There were no retries, reloads, screenshots, provider calls, or deferred workflow phases. The harness also passed `node --check`.

| Arm | Run | HTTP | Nav ms | readyState | `<a>` | link-role | Dropdown count | Outcome |
|---|---:|---|---:|---|---:|---:|---:|---|
| Docker | 1 | 200 | 31,235 | complete | 46 | 46 | 1 | Healthy root |
| local-windows | 2 | 200 | 3,760 | complete | 46 | 46 | 1 | Healthy root |
| local-windows | 3 | 200 | 37,806 | complete | 46 | 46 | 1 | Healthy root |
| Docker | 4 | 200 | 31,199 | complete | 46 | 46 | 1 | Healthy root |
| Docker | 5 | 200 | 60,836 | complete | 46 | 46 | 1 | Healthy root |
| local-windows | 6 | 200 | 30,674 | complete | 46 | 46 | 1 | Healthy root |

All six main-document responses were received: HTTP 200 (`2xx`), final sanitized URL exactly `https://the-internet.herokuapp.com/`, zero redirects, one main-frame navigation, and no Chromium error document. All had DOMContentLoaded observed by `goto` return and `readyState=complete` at the following document read. **The load event flag differed at `goto` return:** yes in all three Docker runs, no in all three Windows runs. This does not contradict `readyState=complete` at the later evaluation; the lifecycle event flag and evaluation were sampled at different instants. Root native `select` count was 0 in all six. All used Playwright 1.63.0 and reported browser version 153.0.8010.12. The Docker sessions used the Linux container/headed profile, and Windows sessions used direct Windows Chromium/headless profile. Navigation duration varied from 3,760 to 60,836 ms; three runs per arm do not establish a timing distribution.

## Classification and next action

**`BACKENDS_BEHAVE_EQUIVALENTLY`** for the measured root response and link inventory. Every arm produced the same healthy 200 root document with 46 anchors, 46 link-role elements and exactly one `Dropdown` link. The previous zero-link behavior was not reproduced, so these six observations do not identify its intermittent cause or rule out a backend-specific intermittent failure. Load-event timing differed at the navigation-return boundary, and the headed/headless profile difference limits broader runtime attribution. No document replacement, HTTP error, navigation failure, Chromium error document, or healthy 2xx document with zero links occurred.

Next action: on the next authorized zero-link recurrence, inspect the already added passive pre-bootstrap main-response, commit and document-generation records for that exact owned root page before changing navigation or grounding behavior.
