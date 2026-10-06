# Local frame-capture A/B experiment

## Method

The six-run browser-only experiment used the current checkpointed code on 2026-10-05. The dedicated [harness](../scripts/local-frame-capture-ab-experiment.mjs) selected the real local-Windows v5 profile from the active trusted configuration and opened each fresh browser/context through `ProtectedContextFactory`. All six sessions used bundled Playwright Chromium in the same Node process and closed with verified cleanup. The order was **OFF, ON, ON, OFF, OFF, ON**. No deferred workflow, provider, MCP exploration, candidate grounding, compiler, runner, replay, QA, or production browser edit was involved.

Each session created one page and made one root `page.goto` with `waitUntil: 'domcontentloaded'` and the profile's 90-second ceiling. At the first post-navigation sampling point, the harness recorded the main-document response, `readyState`, anchor count, link-role count, and exact-name `Dropdown` link count. The same single document evaluation also counted root native selects (zero in all six); this extra sanity count was identical in both arms and did not start a locator inventory loop. It clicked the link once with the ordinary Playwright role locator only when its count was exactly one. At the immediate post-click sampling point it recorded the sanitized URL, main-document response, `readyState`, native `select`, combobox, and listbox counts. The document evaluation and locator counts are sequential reads within each sampling phase, not an atomic DOM snapshot. Passive main-response and lifecycle listeners were identical in both arms. There was no reload, retry, readiness polling, whole-body ARIA, high-volume grounding inventory, or screenshot in OFF.

In ON, a minimal authenticated loopback sink discarded frame payloads while the actual `DeferredViewerLifecycle` ran in `frame_stream` mode. It opened for the protected exploration owner **after the session opened and before page creation/root navigation**, matching production. This used production's initial 100 ms schedule, 750 ms cadence, `captureViewportJpeg` CDP session, 1,000 ms capture timeout, detach/late-result behavior, and stop-on-unavailable rule. The sink retained only notice counts; pixels were not persisted. Bounded viewer diagnostics supplied capture-attempt intervals and safe outcomes. An attempt skipped for no page or `about:blank` was not counted as an active CDP capture.

## Results

| Capture | Run | Root HTTP | Root nav ms | Root links | Dropdown | Destination | Select | Combobox | Capture result | Outcome |
|---|---:|---:|---:|---:|---:|---|---:|---:|---|---|
| OFF | 1 | 200 | 33,170 | 46 | 1 | `/dropdown` 200, loading | 0 | 0 | None | Click returned; immediate destination had no select |
| ON | 2 | 200 | 30,459 | 46 | 1 | `/dropdown` 200, loading | 0 | 0 | 1 timeout, detached, unavailable | Same immediate destination inventory |
| ON | 3 | 200 | 30,472 | 46 | 1 | `/dropdown` 200, loading | 0 | 0 | 1 timeout, detached, unavailable | Same immediate destination inventory |
| OFF | 4 | 200 | 30,567 | 46 | 1 | `/dropdown` 200, loading | 0 | 0 | None | Click returned; immediate destination had no select |
| OFF | 5 | 503 | 30,348 | 0 | 0 | Not reached | — | — | None | Root HTTP error; no click |
| ON | 6 | 200 | 30,057 | 46 | 1 | `/dropdown` 200, loading | 1 | 1 | 1 timeout, detached, unavailable | Click returned; native select present |

Root anchors equaled link-role counts: 46 in runs 1–4 and 6, zero in run 5. Root `readyState` was `complete` in runs 1–4 and `interactive` in runs 5–6. All root navigations returned at DOMContentLoaded; the root 503 was an observed main-document HTTP response with zero links in **OFF**. The experiment retained no headers or body, so it cannot assign the 503 to the origin versus an intermediary. Five successful clicks returned in 129–153 ms, reached the exact sanitized `/dropdown` URL, and had destination HTTP 200 with zero redirects. Each click returned before destination DOMContentLoaded/load was observed. All five immediate destination reads saw `readyState=loading`; native select and combobox were both zero in four, both one in ON run 6. Listbox count was zero in all five. Thus `loading` did not by itself imply that the select was absent.

Each ON run recorded **two scheduled attempts**: one skipped while the page was not ready and one actual CDP capture. The actual capture overlapped **root navigation**, timed out once, completed CDP detach, produced zero frames, emitted one `unavailable` notice, and stopped the loop. There was **no active capture overlap** with root sampling, the click, the click-to-destination transition, or destination sampling. OFF runs had zero capture attempts. The six browser sessions all cleaned up successfully. No navigation or click failed due to a browser exception.

## Classification and conclusion

**`PUBLIC_TARGET_INSTABILITY_SUPPORTED`**. A zero-link root document occurred with capture **OFF** and a main-document HTTP 503. Zero-select immediate destination observations occurred in both OFF and ON arms, while an ON run with the same capture timeout reached `/dropdown` with a native select present. The ON capture timeouts were real viewer failures, but they preceded sampling and did not prevent healthy root responses, successful clicks, or the run-6 select. These results do **not** support frame capture as the cause of the observed missing browser controls. The immediate post-click destination samples are an early lifecycle boundary, so four zero-select reads do not establish permanently missing controls. The six runs cannot exclude an intermittent capture effect outside the sampled intervals, particularly because production stopped capturing before every click.

**Next action:** on the next authorized zero-control recurrence, correlate its main-document HTTP status and document generation with the exact candidate-read instant before changing capture or grounding behavior.
