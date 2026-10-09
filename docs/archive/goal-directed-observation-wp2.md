# Goal-directed verification: trusted observation WP2

This is an additive private observation contract. The released M7 action loop, SuccessfulExplorationTrace v2, compiler, ResolvedTestSpec v6, two-run QA authority, and external v1/v2 result/projection contracts do not consume it yet. A TestSpec v4 `verification_goal` can supply later M7 reasoning, but WP2 does not evaluate a goal or issue a QA verdict.

## Request and result

`TrustedObservationRequestV1` is a strict union:

| Request | Closed input | Complete output |
|---|---|---|
| `semantic_query` | semantic query | exact match count, including zero |
| `target_property` | semantic query and one reviewed property | one uniquely matched target's typed property |
| `current_url` | none | current protected page URL |
| `semantic_snapshot` | none | at most 16,384 model-facing characters, truncation flag, full snapshot digest; **never evidence grade** |

A semantic query requires a reviewed role and a `main` or nested frame path. It may include an exact accessible name and up to four ordered scopes. Scopes are exact named `dialog`, `menu`, or `region`, or a `row` containing an exact named cell. A nested frame path has at most eight exact `title`/`data-testid` anchors. Each iframe anchor must uniquely identify the actual child frame; the result records an owner-frame snapshot digest and one observed match. Opaque runtime frame IDs are not semantic identity. Invalid, absent, ambiguous, or drifting frame/scope resolution is an error, never zero matches.

`TrustedObservationResultV1` is a strict, versioned private record. Trusted code sets its observation ID, TestSpec/attempt/session ownership, page ID, exact profile reference/fingerprint, state and mutation epochs, state digest, frame proof, time, request, typed result or typed error, and witness digest. The request has no provenance fields for M7 to fill. `currentEvidence()` accepts only the exact runtime-owned record still in memory, rechecks the protected session and current page state, and rejects tampering, errors, snapshots, and stale records. A schema-valid model-made record has no evidence authority.

## Completeness and properties

`semantic_query` uses the protected Playwright semantic locator directly with hidden elements included; it never counts lines in an MCP snapshot. Its `count` is complete for the defined query or the request returns a typed error. A zero count is a valid fact. Counts above 10,000 return `RESULT_LIMIT` rather than a capped value. A failed query, browser read, or invalid scope never returns count zero.

`target_property` requires exactly one match. Zero yields `NO_MATCH`; multiple matches yield `NON_UNIQUE` with the observed count. It never chooses the first match. Supported properties are semantic role/name, text content, form value, visible, enabled, checked, and explicit boolean `aria-expanded`/`aria-selected` when those attributes have a valid value. Unsupported target/property combinations return `UNSUPPORTED_PROPERTY`. Strings are capped at 2,048 characters, and role/name facts are bounded. Presence and visibility are separate observations: a hidden button can have count one and visible false.

## Freshness and boundedness

The observation session belongs to one protected MCP session and the active `CurrentStateExploration` owner. Before and after each read, it checks the current page, all frames, approved profile, action mutation epoch, current-state snapshot epoch, navigation/frame lifecycle epoch, and a digest of bounded frame DOM content plus full semantic snapshots. A changed key advances its observation state epoch. Evidence from an earlier epoch is retained as provenance but cannot pass `currentEvidence()`. A navigation, frame/scope drift, replacement current-state owner, closed session, or relevant DOM change also invalidates it. Transient mutations that return to exactly the same observable DOM between checks are treated as the same observable state; the action mutation epoch still invalidates records for reviewed exploratory actions.

The session permits at most 80 observation records, eight frames, 80 iframe candidates per frame level, 262,144 document characters and 131,072 semantic snapshot characters per frame. Oversized material returns a typed limit error; it is never silently truncated into evidence. The model-facing snapshot alone may be truncated at 16,384 characters and cannot establish absence even when it is not truncated. Only the complete semantic query can establish zero matches.

The request schema rejects extra fields, including JavaScript, CSS/XPath, Playwright expressions, network requests, and file paths. The runtime uses fixed reviewed Playwright reads inside the protected session. It does not accept a model-authored selector or script. Raw page content stays in private runtime memory; this API does not add it to the successful trace, stakeholder report, or external protocol.

## Next dependency

M7 needs a separately reviewed decision/strategy loop that chooses these closed requests, gathers multiple current records, evaluates a VerificationGoal against their typed facts, and records only a supported successful strategy in a future trace version. WP2 supplies observations and current-evidence validation; it does not supply that reasoning or a replay assertion.
