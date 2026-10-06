# Runtime investigation log

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
