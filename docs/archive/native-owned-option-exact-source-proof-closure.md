# Exact-source native selected-option proof blocker closure

Date: 2026-09-29. This closes the exact-source harness and stale runbook-documentation blockers recorded in the [native owned-option independent gate](native-owned-option-verification-independent-gate.md). It is not an independent regate, public-target approval, live-provider result, selector change, or production-readiness decision. The historical independent gate remains marked blocked until it is rerun.

## Offline exact-source regression

Added one test-only regression to `tests/native-owned-option-verification.spec.ts` for the exact authored task:

1. `Go to https://the-internet.herokuapp.com/dropdown.`
2. `Select Option 1.`
3. `Verify that Option 1 is selected.`

The test executes the integrated mocked-provider and protected-context path. Both primary and independent extraction calls receive the exact complete task and use the current formats `qa_deferred_action_interpretation_v6` and `qa_deferred_action_source_first_v2`. The persisted TestSpec source, source digest, start URL, navigation text, and exact navigation source span are checked against the same input. The independent input remains independent under the existing adapter contract.

The browser context is still opened by `ProtectedContextFactory` under the test's profile/configuration and protected browser proxy. A test-only DNS mapping pins the exact target host to `127.0.0.1`, and throws on every unexpected DNS hostname. The profile's only destination is `the-internet.herokuapp.com:443 -> 127.0.0.1`. A route is installed on every opened browser context; it fulfills only an exact `GET https://the-internet.herokuapp.com/dropdown` using bytes fetched from the existing loopback fixture and aborts any other browser request. The regression observed four or more distinct protected browser-context objects with the exact-URL route installed, and no denied or unexpected browser requests. It made no public DNS lookup, external request, public-target approval, or provider call.

Authenticated trace and replay readback then confirms the exact source and URL survived navigation, two distinct replay runs/sessions completed with verified cleanup, native selected-option assertions were true in both, replay agreement was `agreed`, and the external terminal was `QA_ASSERTION_PASSED`. The authored option is still `Option 1`; the authored source has no dropdown name or executable DOM value.

The hostname-to-loopback alias exists only in the test fixture and does not authorize changing the operator's approved profile or public URL. The real-provider procedure still requires a separately approved exact public target, and no live proof is inferred.

## Runbook correction

Updated the [live gate procedure](deferred-action-grounding-live-release-gate.md) to describe the implemented deferred-only native selected-state observation and replay semantics, remove the obsolete unsupported/ARIA limitation, and list verified current source, prompt, decision, observation, strategy, comparison, and assertion versions. The exact three-step task and public approval/isolation workflow are unchanged. Optional linguistic variation now explicitly requires independent extraction agreement and complete trusted source accounting; it remains a separate run.

## Validation

- Exact-source regression alone: **1 passed, 0 failed**.
- Native source and end-to-end selected-option suite: **54 passed, 0 failed, 0 skipped**. This includes the new exact-source case and the authenticated restart/tamper coverage.
- Typecheck: passed.
- Build: passed.
- No production code, workflow selector, route, or public approval changed.
- Root's before/after SHA-256 comparison found all **178 `app/` and `src/` production files byte-identical**.
- The prior WP1A–WP5A deferred compatibility result (**334 passed**) and historical verification/provider result (**83 passed**) remain from the independent gate. They were not rerun for this test-and-documentation-only closure task. The full independent gate must rerun before changing its status.

Commands run on this closure tree:

```powershell
node_modules/.bin/playwright.cmd test tests/native-owned-option-verification.spec.ts --grep "exact authored public live-gate source" --workers=1
npx.cmd playwright test tests/native-option-verification-source.spec.ts tests/native-owned-option-verification.spec.ts --workers=1 --output=test-results-native-option-exact-source-closeout
npm.cmd run typecheck
npm.cmd run build
```

**Conclusion:** the independent selected-option offline gate may now be rerun unchanged against this tree. It has not yet been rerun, so its prior blocked result remains in effect until that gate completes. Exact public URL approval and a separately authorized real-provider proof remain later, separate steps.

## Independent regate result

The full independent gate subsequently reran on the frozen final tree and passed. It recorded 54 native cases, 334 deferred compatibility cases, 83 historical verification/provider cases, 7 Python deferred cases, typecheck/build success, and a separate post-build blocked-import restart pass. The three Node suites comprise 471 unique tests; the restart rerun is an additional repeated smoke case. See the [independent gate report](native-owned-option-verification-independent-gate.md) for findings and the unchanged public-approval/live-proof boundary. No live provider or public-target workflow was run.
