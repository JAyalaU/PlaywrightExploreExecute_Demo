# P2-2 local headed workflow release gate

## Status

**Complete.** The credentialed manual run of `npm run test:p2-2-live` reported:

- controlled headed/headless semantics test: passed
- denial, profile, legacy-fingerprint, and QA-isolation test: passed
- real OpenAI headed local-command proof: passed
- overall: `3 passed (25.2s)` with a successful process exit

This status records the operator-supplied result. It does not contain or
require an API key. Safe correlation data belongs in the Playwright test
attachment `p2-2-headed-live-proof.json` when the operator retains the test
artifacts with `P2_2_KEEP_ARTIFACTS=1`.

## What the gate proves

The gate exercises the local P2-2 workflow through the protected Playwright
session and the existing P2-1 adapter path. It checks that:

- headed and headless runs preserve normalized engine behavior while retaining
  distinct execution-profile fingerprints;
- headed results remain observational with unverified input provenance and
  `autonomousEligible=false`;
- a separate fresh headless run is the autonomous-equivalence path;
- trusted profile and browser-wide network controls remain enforced;
- accepted locators, discovered prerequisites, two fresh replay contexts,
  typed results, cleanup, and stored evidence remain intact.

## Safe evidence handling

The test attachment may contain only correlation metadata such as the TestSpec
ID, profile fingerprint, exploration-attempt ID, resolved-spec ID, and the two
execution-run IDs. Keep the artifact root private. Do not publish the API key,
raw Responses API output, page snapshots, cookies, storage state, screenshots,
traces, videos, or unrestricted artifact bytes.

An empty observation log is not proof that no operator interaction occurred.
Detected input is append-only observation evidence and never becomes a
deterministic step, prerequisite, or QA result.

## Scope and deferred work

This is a controlled local-fixture release gate. It does not establish public
web reliability or complete the Python host, noVNC, or optional `.spec.ts`
export milestones.
