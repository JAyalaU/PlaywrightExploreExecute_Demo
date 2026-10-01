# P3-B report projection v1

`reportProjectionVersion: "1"` is a separate read-only Node exchange. It does not change the [P2-3 subprocess protocol](p2-3-subprocess-protocol.md). The trusted Python host may invoke `node dist/subprocess/report-projection-cli.js --config <trusted-config-path>` after it validates a v1 engine result. It sends one UTF-8 JSON document on stdin:

The request object has exactly two fields: `reportProjectionVersion: "1"` and
`result: <validated subprocess-v1 result envelope>`.

The CLI emits one closed JSON projection on stdout. The config path is a trusted launch argument, never a task or UI field. `call_report_projection` in `playwright_demo` validates the result and response, supervises the child, and does not read the artifact directory itself. The P3-D UI host consumes this projection after validating the Node result.

## Available projection

Node reconstructs the report from its private artifact root, then checks the TestSpec ID, profile reference and fingerprint, attempt ID, resolved-spec ID, both run IDs, and terminal result against the supplied v1 envelope. The response contains only those correlation IDs; profile/observation and terminal state; per-outcome phase, status, closed safe reason, step IDs and assertion type; expected/actual value states; and evidence descriptors with type, sensitivity, time, byte count, owner and step IDs. It excludes task text, page text, locator expressions, raw report objects, artifact paths/references, hashes, provider output, credentials, and binary bytes.

Expected and actual values are `absent`, `withheld`, or `displayable`. All strings, including URLs and page text, are withheld. Only finite numbers, booleans, and null may be displayed. Phase, status, and reason fields use the existing closed subprocess vocabularies; unknown reasons are redacted by Node and rejected if received outside that vocabulary. The UI must retain the v1 engine result as the QA authority; projection availability never changes its classification.

Screenshot state is `capture_disabled`, `not_captured`, or `stored_restricted`. A stored screenshot appears only as restricted metadata. This contract never authorizes its bytes, even if binary capture was enabled. Separate trusted capture and restricted-evidence access approval would be needed for image display.

## Limits and failure behavior

The request is at most **8 KiB** and the response at most **64 KiB**. One projection contains at most **128 outcomes** and **64 evidence descriptors**; other permitted strings are at most **256 UTF-8 bytes**. Before reconstruction, Node checks a **16 MiB / 512-file** stored-job read budget and rejects unsafe links or file types. An over-limit report becomes `kind: "unavailable"` with `reason: "REPORT_TOO_LARGE"`; outcomes are never silently truncated.

Unavailable reasons are closed: `REPORT_UNAVAILABLE`, `REPORT_NOT_FOUND`, `REPORT_EXPIRED`, `CORRELATION_MISMATCH`, `REPORT_INVALID`, `REPORT_TOO_LARGE`, `INVALID_REQUEST`, and `CONFIGURATION_UNAVAILABLE`. The response contains no raw exception or path. Missing, expired, corrupt, or mismatched reports do not turn an engine success or QA failure into a different QA result. Restricted evidence remains metadata only. The Python host treats malformed projection output or child failure as a projection retrieval failure, not an engine outcome.
