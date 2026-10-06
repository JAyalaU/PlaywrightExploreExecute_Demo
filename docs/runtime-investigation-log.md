# Runtime investigation log

## 2026-10-05 — Local viewer navigation-time capture recovery

- The local-Windows viewer's first CDP JPEG attempt could time out during root navigation, detach correctly, then incorrectly end viewing while QA continued. Viewer-only main-document lifecycle tracking now skips unstable pages, and a bounded timeout or document replacement resumes at the 750 ms cadence after detach. Offline fixtures observe post-navigation frames, no late/stale pixels, terminal browser/context/channel failures, and unchanged five-step QA with view on/off. No public target or provider was contacted.

## 2026-10-05 — Destination readiness experiment

- See [destination-readiness-experiment.md](destination-readiness-experiment.md). Six view-off local-Windows sessions reached `/dropdown` with HTTP 200; one immediate same-document sample had zero selects, but all six had one native select by DOMContentLoaded. No document replacement. Classification: `SELECT_RELIABLY_APPEARS_BY_DOMCONTENTLOADED`.

## 2026-10-05 — Local frame-capture A/B experiment

- See [local-frame-capture-ab-experiment.md](local-frame-capture-ab-experiment.md). Six local-Windows OFF/ON/ON/OFF/OFF/ON sessions completed. Every ON viewer timed out once during root navigation, detached, and became unavailable; no capture was active at root or destination sampling. Zero-select immediate destination reads occurred in both arms, and an OFF root received HTTP 503 with zero links. Classification: `PUBLIC_TARGET_INSTABILITY_SUPPORTED`.

## 2026-10-05 — Browser backend A/B experiment completed after Docker recovery

- See [browser-backend-ab-experiment.md](browser-backend-ab-experiment.md). After the earlier Docker preflight block, all six read-only D/W/W/D/D/W sessions completed with HTTP 200, 46 root links and one exact `Dropdown` link; classification `BACKENDS_BEHAVE_EQUIVALENTLY` for root content. The trusted Docker profile is headed while the derived Windows profile is headless.

## 2026-10-05 — Docker versus Windows differential audit

- Source-only baseline-to-working-tree comparison: see [docker-vs-windows-regression-audit.md](docker-vs-windows-regression-audit.md). The `poc-live-view-e2e-pass` tag is current HEAD; migration and later diagnostic/navigation changes are uncommitted. The best next discriminator is one read-only root navigation under each backend with passive main-document lifecycle evidence. No public workflow, provider call, or browser/network integration test ran for this audit.

## 2026-10-05 — Missing root links after completed bootstrap

- **Run/problem:** `local-165b54ba-a4c1-4f95-83fe-9cae69f55bc2` stopped at step-2 link enumeration (`NO_CANDIDATES`); the tracker attached after root navigation, leaving its response and lifecycle unknown.
- **Instrumentation/change:** Attach the existing session-owned private tracker before root navigation. Correlate request start, response status class, commit/failure, redirect count, document generation, lifecycle/ready state, and the first candidate query by owner/page/main frame. No navigation or matching decisions use these records.
- **Validation:** 11 focused readiness tests, 31 grounding tests, local-Windows five-step view-off/view-on closures, `npm test` (188), typecheck, and build passed. Fixtures include 2xx/4xx/5xx, redirect, failed navigation, and error-document/recovery replacement.
- **Next unresolved question:** On the next authorized public recurrence, did the root main document commit with a 2xx response and complete lifecycle in the same generation queried at step 2, or did navigation fail, return an error response, or replace the document?

## 2026-10-05 — Primary interpretation provider stop

- **Run/problem:** `local-e4b895d1-e1ea-4c3e-8ef2-6373fcbf6472` stopped in the first primary provider attempt after 4,294 ms (`PROVIDER_ERROR`, response state `unavailable`); no valid primary extraction or fidelity request followed. Closed cause: `UNKNOWN_PROVIDER_FAILURE` because the retained attempt lacks HTTP status, provider type/code, and transport category.
- **Instrumentation/change:** None; read-only authenticated stop and private timing review. The active deferred route does not persist its existing transport diagnostic callback, and opt-in live provider debug was not present for this run.
- **Validation:** Authenticated terminal/accounting readback succeeded. The local `.env` has a nonempty key assignment; the failed process's effective key source and validity cannot be established after exit. The route uses the fixed Responses endpoint and default `gpt-5.6-terra` model.
- **Next unresolved question:** Was the primary failure an HTTP rejection, provider response error, or transport exception? Capture a bounded, run-correlated private transport diagnostic before another authorized run; do not treat a blind rerun as evidence of a transient condition.

## 2026-10-05 — Committed-document DOMContentLoaded gate

- Active `poc_v1` exploration, compiler v4, and runner v9 now wait for the same committed document's DOMContentLoaded before DOM reads or candidate proof, while URL-only checks remain immediate. See [current-status.md](current-status.md). The unrelated offline `PoC resulting URL passes after two deterministic replays` fixture still stops `VERIFICATION_UNRESOLVED` when the new wait is bypassed.
