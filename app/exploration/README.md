# M6 MCP exploration boundary

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
Rejected attempts remain in M5 evidence and never produce a runnable resolved
artifact. An accepted artifact is replayed twice through the fixed M4 runner
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
