# P2-3 subprocess protocol v1

This contract is shared by the P2-3B Node entry and P2-3C Python caller. It is separate from the human-facing `npm run local` output. The TypeScript source of truth is `app/subprocess/protocol.ts`; this document fixes wire framing and interpretation before either process entry is implemented.

## One process, one exchange

The host writes one UTF-8 JSON document to child stdin and closes stdin. The child writes exactly one UTF-8 JSON response document to stdout, followed by an optional newline, then exits. No progress, logs, prompts, browser output, or second JSON document may appear on stdout. Sanitized diagnostics may use stderr, which is never interpreted as a QA outcome. JSON objects are closed; unknown fields and incompatible `protocolVersion` values fail before the engine runs. The host must validate both the response and the exit code.

The maximum request and response size is **65,536 bytes each**, including framing whitespace. The Python host drains stdout and stderr concurrently; it retains at most **16,384 bytes** of stderr. A host deadline defaults to **300,000 ms** and must not exceed **900,000 ms**. The deadline is host supervision, never a task-controlled request field. Exceeding an output limit invalidates the exchange. The Node entry must bound its read before parsing and must not echo raw task, URL, page content, provider errors, credentials, or restricted evidence in either channel. B and C own runtime enforcement of these limits.

The only request data are `taskText` (1–16,384 characters), `targetUrl` (absolute HTTP(S), at most 2,048 characters), and `executionProfileRef` (ID at most 128 characters; version at most 64). The entire request is validated using `LocalWorkflowRequestSchema`. A trusted launch-only configuration path chooses profiles, policy, artifacts, and capture settings; `OPENAI_API_KEY` stays outside JSON. The profile reference selects only from that trusted configuration. The target URL cannot grant egress permission. No request field chooses a provider, browser mode, credentials, policy, artifact root, timeout, or injected model.

```json
{"protocolVersion":"1","request":{"taskText":"Select Save.","targetUrl":"http://127.0.0.1:4173/","executionProfileRef":{"id":"desktop","version":"2"}}}
```

## Result variants

`kind` is a closed discriminator:

| Kind | Meaning | Exit code |
|---|---|---:|
| `success` | Both fresh replays completed without QA or automation failure. | 0 |
| `typed_stop`, `stopKind: qa_failure` | A replay evaluated an assertion and it failed. | 1 |
| `typed_stop`, `stopKind: automation_stop` | The engine returned a typed non-QA stop, possibly after a replay began. | 2 |
| `bridge_error` | Node could not produce a trustworthy local workflow outcome. | 64, or 130 for `CANCELLED` |

A valid `typed_stop` with exit code 1 or 2 is a Node result, not a child-process failure. Any mismatch between a valid response and the specified exit code is an `UNEXPECTED_EXIT` host failure. `bridge_error` uses only the closed `LocalWorkflowError` codes plus protocol codes. Protocol errors occur before engine work. `cleanup` is `not_started`, `verified`, or `unverified`; the bridge must never claim verified cleanup without observing it.

Engine results include a safe terminal `phase`, `status` from the existing closed `ResultStatusSchema`, and an optional reason from the closed `SafeTerminalReasonSchema`. An unrecognized, free-form, or private `ResultRecord.reason` maps to `REDACTED_REASON`; uppercase spelling alone is insufficient to expose it. `context` contains the TestSpec ID, selected profile reference and fingerprint, presentation mode, the existing P2-2 observation state, progress, and report availability. Progress is exactly one of `not_started`, `exploration` with an attempt ID, or `replayed` with attempt ID, resolved-spec ID, and **two distinct** run IDs. Exploration and replay progress require an available report. The `report` field is either `unavailable` or `available` with a TestSpec ID matching the context. It is a Node-owned report reference, not an artifact path, capability, permission to read protected contents, or copy of evidence. The trusted Node configuration identifies the artifact root. No TestSpec, locator, page text, evidence bytes, storage state, or provider response crosses this channel. For an engine result, the response profile reference must exactly match the request profile reference; `responseMatchesRequest` encodes this host check.

Headed results always carry `observation: {"state":"observational","inputProvenance":"unverified","autonomousEligible":false,...}`. An empty `eventIds` array does not prove absence of operator input. A separate fresh headless run is required for autonomous proof. Headed and headless profile fingerprints remain distinct.

Successful QA replay:

```json
{"protocolVersion":"1","kind":"success","context":{"testSpecId":"local-1","executionProfileRef":{"id":"desktop","version":"2"},"profileFingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","presentationMode":"headless","observation":{"state":"no_intervention","autonomousEligible":true,"eventIds":[]},"progress":{"stage":"replayed","explorationAttemptId":"attempt-1","resolvedSpecId":"resolved-1","executionRunIds":["run-1","run-2"]},"report":{"kind":"available","testSpecId":"local-1"}},"terminal":{"phase":"execution","status":"QA_ASSERTION_PASSED"}}
```

Evaluated QA assertion failure uses the same context and `kind: "typed_stop"`, `stopKind: "qa_failure"`, `terminal: {"phase":"execution","status":"QA_ASSERTION_FAILED","reason":"NO_MATCH"}`. It retains both run IDs and the report reference. A runtime binding failure instead uses `stopKind: "automation_stop"` and `status: "LOCATOR_BINDING_FAILED"`.

An interpretation stop has `progress: {"stage":"not_started"}` and may have no report:

```json
{"protocolVersion":"1","kind":"typed_stop","stopKind":"automation_stop","context":{"testSpecId":"local-2","executionProfileRef":{"id":"desktop","version":"2"},"profileFingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","presentationMode":"headless","observation":{"state":"unobserved","autonomousEligible":false,"eventIds":[]},"progress":{"stage":"not_started"},"report":{"kind":"unavailable"}},"terminal":{"phase":"interpretation","status":"AMBIGUOUS_INSTRUCTION","reason":"MATERIAL_AMBIGUITY"}}
```

A resolution stop changes progress to `{"stage":"exploration","explorationAttemptId":"attempt-2"}`, makes the report available for the same TestSpec ID, and uses the appropriate exploration or locator terminal status. No resolved-spec or run IDs are invented.

Local configuration failure and destination denial are bridge errors, never QA failures:

```json
{"protocolVersion":"1","kind":"bridge_error","code":"INVALID_TRUSTED_CONFIGURATION","cleanup":"not_started"}
```

```json
{"protocolVersion":"1","kind":"bridge_error","code":"DESTINATION_DENIED","cleanup":"not_started"}
```

## Host process failures

The Python host has a separate closed `process_failure` outcome when no trustworthy Node response exists: launch failure, missing/malformed/multiple response, output limit, unexpected exit, cancellation, or deadline expiry. This is **not** serialized by the Node child as a successful QA result. The host may retain a bounded sanitized diagnostic and exit code separately, but must not parse stderr into engine status. It must terminate/reap the child on cancellation or deadline and inspect descendants where feasible. Forced termination always sets `cleanup: "unverified"`, even if no browser descendants are found.

For example, forced deadline expiry is represented by the host as:

```json
{"kind":"process_failure","code":"DEADLINE_EXCEEDED","cleanup":"unverified","forcedTermination":true}
```

An invalid versioned response is a `MALFORMED_RESPONSE` host failure. A request with an unsupported version receives a Node `bridge_error` with `PROTOCOL_UNSUPPORTED_VERSION` and exit code 64 if the child can write a valid v1 response; otherwise the host records a process failure. Protocol changes require a new version and coordinated Node/Python migration; silent widening of v1 is forbidden.
