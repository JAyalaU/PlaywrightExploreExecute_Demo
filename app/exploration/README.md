# M6 MCP exploration boundary

## WP2A current-state action path

`CurrentStateExploration` is a separate, not-yet-cut-over path over the same
protected MCP session. A caller observes a full MCP snapshot, binds one unique
`aria-ref` to the current page/frame, source goal, profile fingerprint, and
closed action, then acts only after a fresh snapshot and actionability check.
Bindings expire after ten seconds and are invalidated by a new observation,
navigation, page/session transition, mutation detected in a fresh snapshot,
or first use. An authored role/name or scope contradiction fails target
resolution. The MCP action uses the bound ref directly; no replay locator is
generated or accepted for authorization. Successful action and observation
facts remain in a private in-memory journal. WP2B supplies a separate
`SuccessfulTraceAssembler` and immutable store methods: a future M7 controller
must feed observed navigation/wait/assertion facts, read the complete WP2A
journal, and finalize a validated `SuccessfulExplorationTrace v1` before any
compiler can use it. The journal and trace are not report, UI, or replay
artifacts and do not classify QA.
The existing `resolveAndReplay` path below remains active until reviewed cutover.

`McpExplorationSession` attaches the pinned `@playwright/mcp` server to the
`ProtectedContextFactory` browser context through the package's programmatic
`contextGetter`. The in-process MCP client can call only the adapter's named
navigation, snapshot, find, locator-generation, click, fill, select, and text
wait methods. No browser evaluation, arbitrary code, selector argument, host
command, upload, or coordinate tool is exposed to the scripted resolver.

`resolveAndReplay` accepts an already validated and stored TestSpec plus a
bounded scripted decision function. The function receives the current MCP
snapshot and authored step. It may choose only a ref present in the current
snapshot, request a snapshot find/text wait, record a prerequisite action, or
declare the target unresolved. General model-driven decisions belong to M7.
Every targeted operation gets its own MCP-generated locator. M2 parses and
checks durability; a live check in the same M3 context checks match count and
intersects the generated locator with the selected ephemeral `aria-ref` node.
The ref is kept only in attempt evidence. The accepted ResolvedTestSpec contains
the normal declarative Playwright locator and ordered prerequisite operations.
MCP's automatically named output files go to a private temporary directory
that is removed when the exploration session closes. Persisted evidence goes
through M5's redaction and immutable artifact store.

An exploration text wait does not create a replay step when the following
targeted operation's bounded locator wait recreates the same state. A required
state-changing interaction always becomes an ordered prerequisite. One
alternative locator-generation attempt is allowed after a quality rejection.
The version 2 M7 rejection feedback keeps a uniquely bound, selected
`WEAK_IDENTITY` node as the default retry candidate. M7 may choose a different
node when the selection or binding is wrong or ambiguous; repeating a candidate
without new semantic evidence fails closed. M6 continues to own locator quality.
Each M7 decision branch writes a closed private developer diagnostic in
`developer-diagnostics/<attemptId>/decision-<ordinal>.json` beneath the job.
These records contain IDs, snapshot digest, closed codes and branch outcomes;
they are absent from evidence refs and the P4 event stream.
Rejected generated locators remain in M5 evidence. A versioned, independently
verified semantic projection may use the same MCP-selected node after a reviewed
quality rejection; its accepted declarative form and raw rejection provenance
enter the resolved artifact. Other rejections never produce a runnable locator.
An accepted artifact is replayed twice through the fixed M4 runner
in fresh M3 contexts through M5's capture adapter; any QA or binding failure
remains a typed runner outcome. Replay always records redacted step metadata.
Screenshots, traces, and video require an explicit M5 evidence policy that
approves restricted binary capture.

The MCP integration pins `@playwright/mcp` 0.0.82 and the MCP client SDK 1.30.0.
The MCP package currently bundles a newer Playwright prerelease than the root
Playwright Test 1.63.0 dependency. The `contextGetter` cast is limited to this
boundary, and live tests cover connection, snapshot refs, locator generation,
actions, frame scope, and cleanup. Recheck those compatibility tests on either
Playwright or MCP upgrade. The tool inventory and both runtime versions are
recorded with each attempt. The M3 network proxy and profile remain authoritative;
MCP's own origin filtering is not used as a substitute.
