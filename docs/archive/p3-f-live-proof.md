# P3-F live stakeholder proof

P3-F was completed through the guarded, loopback-only Streamlit UI using the
production Python-to-Node path and the real OpenAI/MCP adapters. This record
contains only the sanitized result supplied by the operator; it contains no
credentials, raw report, page content, or artifact path.

## Recorded result

- Safe host stages: `admission_approved` → `engine_finished` with success and
  `QA_ASSERTION_PASSED` → `projection_finished` with an available projection.
- Admission: approved for `admitted-public-9d69…@1`.
- Effective profile fingerprint: `c5818a77c85f9ed9f4326c468aec682b80b0066effeec37571fe085136b22759`.
- TestSpec: `local-f8b0188f…`.
- Exploration: `explore-7b3ef6a9…`.
- Resolved spec: `resolved-e83f5859…`.
- Outcome: `success`, terminal `QA_ASSERTION_PASSED`.
- Deterministic replay: two distinct execution runs, `run-450cc5a4…` and
  `run-916e816f…`; both passed.
- Safe report projection: available, with 10 redacted evidence descriptors.
- Screenshot: `capture_disabled`.
- Provenance: headless, `no_intervention`, `autonomousEligible: true`.
- Cleanup: the operator's post-run Docker container query was empty (successful
  exit).

The operator's later UI run also enabled the opt-in safe host diagnostics. The
observed event sequence was `submitted` → `admission_approved` → `engine_started`
→ `engine_finished` (`success`, `execution`, `QA_ASSERTION_PASSED`) →
`projection_started` → `projection_finished`. These events correlated to the
same TestSpec ID above and contained no key, task text, provider body, page
content, or raw child stderr.

The correlation IDs above are abbreviated as they were supplied to this
record. The operator retains the complete safe output locally. This proof
confirms the P3-F live path and expected result; it does not grant access to
Node-owned raw artifacts or restricted evidence bytes.
