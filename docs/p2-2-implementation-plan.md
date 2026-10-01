# P2-2 implementation plan: local interactive/headed demo

## Purpose and fixed boundaries

P2-2 adds one local developer workflow around the completed M1-M8 engine and P2-1 OpenAI adapters. A developer supplies a target URL and natural-language task, selects trusted local runtime configuration, observes the existing protected Playwright sessions in headed mode, and receives a typed terminal outcome plus references to persisted evidence. The same workflow remains available in a separate fresh headless run with equivalent interpretation, exploration, locator acceptance, replay, and result semantics. Every headed run is observational with unverified physical-input provenance; only the fresh headless path can establish autonomous execution.

The approved [architecture](architecture.md), [TestSpec contract](test-spec-schema.md), [Phase 2 roadmap](phase-2-roadmap.md), and [integration decisions](phase-2-integration-decisions.md) remain authoritative. `handoffTask` remains the engine boundary, `ProtectedContextFactory` remains the only browser-creation boundary, and `ResolvedTestSpec` remains the canonical deterministic executable artifact. P2-2 adds no browser authority to the model, no alternate runner, no second viewing browser, and no implicit network approval derived from a user-supplied URL.

P2-2 is a local developer tool, not a product UI or service. P2-3 stdin/stdout envelopes and Python supervision, the public-web acceptance gate, noVNC, and `.spec.ts` export are outside this milestone.

## Pre-implementation decision gate

This decision gate records the reviewed integration contracts. P2-2A and P2-2B already exist; the headed-provenance correction requires a narrow A contract update and B wiring update before their downstream gates are considered closed.

1. **The versioned profile owns presentation mode.** A new execution-profile version explicitly records `headed` or `headless` in its effective settings and fingerprint. The local command may select an existing trusted profile ID/version or validate that a requested presentation preference agrees with that profile; it cannot override browser launch mode. Exploration, locator validation, and both replays use the selected effective profile unchanged. Existing profile versions and persisted artifacts retain their original headless semantics and fingerprints; loading a legacy artifact must use its original version rules, not add a mode and recalculate its fingerprint. A material mode change creates a new profile version and requires validation under that version.
2. **Headed provenance is unverified by contract.** Every headed attempt/run is observational and `autonomousEligible: false`, including when no input events were detected. This eligibility is separate from the normal typed QA/automation result, which is preserved with its evidence. An empty log never proves absence of operator input. A separate fresh headless run is the authoritative autonomous-equivalence path; its eligibility remains subject to the existing execution and evidence rules.
3. **Detectable input is append-only observation evidence.** Persist each detected input event with an immutable event ID, timestamp/order, effective profile ID/version, and exploration-attempt or execution-run ID. Include a bounded automation-action scope ID and origin step/action ID only when known; scope membership or event trust does not prove physical origin. Record input category and attribution uncertainty without input payloads, credentials, or protected page data. Missing or uncertain event attribution cannot make a headed run autonomous. Earlier events are never rewritten or promoted into TestSpec, `ResolvedTestSpec`, runner steps, prerequisites, or QA results. P2-2C must stop if headed observation bypasses the protected session or if it would label a headed run autonomous based on event detection.
4. **Input cannot grant policy.** The target URL becomes the request's start state. It must already be allowed by the selected trusted profile/network policy. The local tool never constructs or widens a policy from the URL, and non-loopback targets still require the existing `ExternalTargetGate`.
5. **Untrusted request and trusted configuration remain separate.** The local request contains only task text, target URL, and a reference to a trusted profile. The profile catalog, network policy, artifact root/evidence restrictions, provider credentials, and protected auth contents are resolved from trusted local configuration, never supplied or altered by task text or URL. Human-oriented console output is P2-2 scope; the machine-readable subprocess protocol remains P2-3.

P2-2A records the closed contract and version rules; P2-2C enforces observational headed provenance and protected-session use. Physical-input attribution is not a P2-2 exit criterion. Page content cannot use observation events to expand model, MCP, network, or runner authority.

## Work packages

### P2-2A — Local workflow and observation contracts

**Suggested owner:** TypeScript contract specialist.

**Scope**

- Define separate closed, locally validated untrusted request and trusted configuration types. The request contains task text, target URL, and a trusted execution-profile reference; the trusted configuration owns profile selection/lookup, the versioned profiles that define presentation mode, evidence policy, artifact destination, credentials, and network policy.
- Define a closed local outcome that preserves the existing `HandoffOutcome` and typed result records while exposing correlation IDs, report availability, artifact location, and observation/intervention state.
- Define the append-only observation-event contract and its immutable attempt/run, profile-version, and applicable bounded-action correlation. Define headed provenance as unverified and headed autonomous eligibility as false even with an empty event log. Keep provenance and detected-intervention state separate from QA assertion and runner failure status. The completed A contracts need only this bounded correction.
- Add explicit presentation mode only in a new version of the execution-profile contract, with that version's fingerprint covering mode. Preserve legacy version validation, headless behavior, and recorded fingerprints without rewriting legacy artifacts; new headed/headless fixtures use explicit versioned profiles.
- Specify target URL handling as `startState.url`; keep the user's task text unchanged and do not infer network permission from either field.

**Dependencies**

- Approved P2-2 pre-implementation decision gate.
- Existing M1 domain/result contracts, M3 effective-profile fingerprint, M5 evidence correlation, M7 `InterpretationRequest`/`HandoffOutcome`, and P2-1 provider configuration.

**Exit criteria**

- Closed schemas reject unknown fields, invalid URLs, invalid presentation values in trusted profiles, unsafe evidence combinations, and request-supplied credentials, artifact roots, evidence controls, or policy data.
- New profile versions have explicit mode and distinct fingerprints; legacy artifacts read back under their original version rules with unchanged fingerprints and headless semantics. Missing or mismatched versions fail closed.
- Observation events append without overwrite, carry immutable attempt/run and profile-version correlation, and cannot alter TestSpec, locator, operation, or result vocabularies. Contract tests prove headed `autonomousEligible: false` regardless of detected event count, and preserve the typed result separately.
- Contract tests prove versioned serialization/readback and that no implicit profile migration or fingerprint rewrite occurs.

**Deferred**

- Browser launch behavior, interaction detection, CLI parsing, Python envelopes, and public targets.

### P2-2B — Local Node workflow service

**Suggested owner:** Node/backend specialist.

**Scope**

- Add one application-level local workflow function that validates the untrusted P2-2A request, resolves trusted profile, policy, credential, and artifact configuration separately, constructs the existing OpenAI adapters, and invokes `handoffTask` unchanged.
- Use `LocalArtifactStore` and `readStoredJobReport` to return an interpretable typed summary and artifact references when a job exists. Preserve typed interpretation stops that occur before job creation. Wire the P2-2A provenance contract through the workflow so every headed outcome is observational without changing the underlying typed engine result; the completed B service needs only this bounded wiring update.
- Generate immutable request/TestSpec correlation IDs locally and ensure diagnostics never include provider credentials, protected auth contents, raw restricted evidence, or unsanitized provider bodies.
- Own cleanup and cancellation around the full handoff without duplicating interpretation, MCP exploration, locator quality, replay, or evidence behavior.

**Dependencies**

- P2-2A.
- P2-1 adapters and the existing M3/M5/M6/M7 boundaries.

**Existing components consumed**

- `createOpenAIModelAdapters`, `handoffTask`, `ProtectedContextFactory`, `ProfileCatalog`, `LocalArtifactStore`, and `readStoredJobReport`.

**Exit criteria**

- A credential-free integration fixture using injected test adapters proves target URL plus task flows through the existing engine and returns its typed stopped or executed outcome with correct IDs and artifact references. It also proves an empty headed observation log still yields unverified provenance and `autonomousEligible: false`.
- Invalid local input, missing trusted configuration, denied destination, and provider configuration failure stop with bounded diagnostics and do not create an alternate browser path.
- Cleanup is proven for success, typed stop, cancellation, and thrown setup failure.

**Deferred**

- Native headed launch, interactive terminal UX, stdin/stdout subprocess envelopes, and any Python caller.

### P2-2C — Protected headed observation and provenance accounting

**Suggested owner:** Playwright/Node runtime specialist.

**Scope**

- Make `ProtectedContextFactory` launch the browser according to the selected effective profile's versioned presentation mode while retaining the existing proxy, auth-state, context, permissions, download, cleanup, and external-target controls. The caller cannot override mode at launch.
- Ensure M6 exploration, locator validation, and both M4 replay contexts consume the same effective mode through the same factory. Fresh contexts and the existing explore/replay separation remain intact; headed mode may show successive protected sessions, not create a viewer browser.
- Mark every headed attempt/run as observational with unverified physical-input provenance and `autonomousEligible: false` before execution; an empty event log cannot change this. Preserve the normal typed outcome and evidence. Do not infer a human or automation origin from DOM event trust or action timing.
- Record detectable input events as append-only observations through the P2-2A contract, correlated with the effective profile and active attempt/run. If an existing action scope provides a reliable correlation, include its ID; do not treat scope membership as proof of physical-input origin. These observations never feed target selection, locator generation, TestSpec construction, prerequisites, or deterministic execution.
- Keep the protected headed browser as the only observed browser. Stop P2-2C if it cannot maintain that boundary, if input observations can change engine behavior, or if any path can label a headed run autonomous. Physical-input attribution and a comprehensive input-event log are not prerequisites for the observation-only workflow.

**Dependencies**

- The bounded P2-2A headed-provenance contract correction. C can proceed in parallel with the bounded P2-2B wiring update after A closes the contract.
- Existing M3 protected session, M4 observer hook, M5 evidence store, and M6 MCP call boundary.

**Exit criteria**

- Browser integration tests prove headed and headless modes both use the protected proxy and exact profile fingerprint, enforce auth/network restrictions, and close browser/context/proxy resources.
- Observation instrumentation cannot issue browser actions, alter decisions, add tools, read protected credentials, or suppress the quality gate.
- Detectable input is appended as correlated evidence without becoming an authored or prerequisite execution step. Tests prove both a nonempty and an empty observation log leave headed `autonomousEligible: false`, with typed QA/automation outcomes unchanged. Detection does not claim complete physical-input coverage or reliable human-versus-automation attribution.
- Headed execution retains the same typed engine semantics as headless execution under compatible non-presentation profile settings. Each run keeps its distinct profile identity and fingerprint; headed results remain observational.

**Deferred**

- Remote viewing, noVNC, collaborative control, selector repair, and accepting manual actions into replay.

### P2-2D — Developer-facing local command

**Suggested owner:** CLI specialist.

**Scope**

- Add a minimal Node command that accepts a target URL and task, selects an existing trusted explicitly versioned profile/configuration, and invokes the P2-2B workflow. A headed/headless preference may validate the selected profile or select a separately configured compatible profile, but cannot override its mode.
- Resolve the OpenAI key through the established external configuration mechanism. Keep trusted profile/policy, evidence restrictions, and artifact-root configuration outside untrusted request input.
- Print a concise typed summary: terminal phase/status, reason when present, TestSpec/attempt/resolved/run IDs, headed observational provenance/autonomous eligibility, detected-input state, and artifact/report location. Restricted evidence bytes remain behind existing access controls.
- Define documented exit-code behavior that distinguishes successful QA completion, QA assertion failure, typed automation/configuration stop, and command misuse without changing domain result statuses. An observational headed provenance flag or empty input-event log does not rewrite the QA result.

**Dependencies**

- P2-2B and P2-2C.

**Exit criteria**

- One documented command can run the same controlled local task in headed or headless mode.
- Missing key, invalid URL/task, unknown profile, denied network target, ambiguous interpretation, and QA/automation failure yield bounded, non-secret output and predictable exit codes. Every headed result identifies its unverified input provenance and `autonomousEligible: false`, regardless of detected input.
- The command does not expose a general browser console, selector input, arbitrary JavaScript, raw MCP tools, or a P2-3 subprocess protocol.

**Deferred**

- Python invocation, product UI, job scheduling, multi-user use, and generalized configuration administration.

### P2-2E — Headed/headless equivalence and local release gate

**Suggested owner:** Test automation specialist.

**Scope**

- Add credential-free end-to-end regressions using deterministic adapters against a controlled local fixture for both presentation modes.
- Compare normalized typed outcomes, accepted locator quality, ordered prerequisites, two fresh replays, non-presentation effective-profile fields, and stored evidence relationships for controlled headed and separate fresh headless runs. Ignore only intentionally unique IDs/timestamps and presentation mode for this semantic comparison; retain and assert each run's distinct profile ID/version and fingerprint in its own evidence. The comparison checks engine semantics, not headed autonomous provenance. The fresh headless run is the authoritative autonomous-equivalence path.
- Prove network denial, profile mismatch, unchanged legacy profile fingerprints, cleanup, typed failure isolation, headed observational status, and append-only recording of detectable input. An empty event log must not confer autonomous eligibility.
- Add an opt-in manual headed proof using the real P2-1 adapter path. A skipped run or unavailable display/key remains unverified and must not be reported as milestone completion.

**Dependencies**

- P2-2D and the already verified P2-1 provider path.

**Exit criteria**

- Offline typecheck, tests, and build pass with no provider credential.
- The manual headed proof demonstrates visible protected exploration and replay, accepted durable locators, two fresh replay contexts, a typed terminal result, reconstructable stored evidence, and explicit observational provenance with `autonomousEligible: false`.
- A detectable-input fixture or controlled observation proof records an append-only event with attempt/run correlation and action-scope correlation when available. The event log, whether empty or nonempty, never makes a headed run autonomous. Physical-input attribution is not a release gate.
- A separate fresh headless run proves autonomous execution under the existing rules and remains a release-blocking path independent of a display or viewer. The headed/headless comparison retains distinct profile fingerprints and checks normalized engine behavior only.

**Deferred**

- Public Columbia validation, external-site reliability claims, Python hosting, and export.

### P2-2F — Operator documentation and milestone closure

**Suggested owner:** Technical writer after E supplies observed behavior.

**Scope**

- Update the README/runbook with actual install, configuration, headed/headless commands, artifact inspection, exit semantics, cleanup, headed observational provenance, detectable-input records, and troubleshooting.
- Document that the URL does not create network permission, external destinations still require approval, headed mode is observation-only and never autonomous-eligible, an empty input log is not proof of no intervention, the separate fresh headless run is authoritative for autonomy, and sensitive evidence remains restricted.
- Record the exact manual P2-2 proof status and its safe correlation data without credentials, raw provider output, or restricted evidence.

**Dependencies**

- P2-2E.

**Exit criteria**

- A developer can reproduce the supported local workflow from repository documentation without reading tests or constructing the engine in application code.
- Documentation matches actual command flags, configuration schema, result output, and limitations.
- The P2-2 exit gate is recorded as passed only when the manual headed proof has actually run.

**Deferred**

- P2-3 instructions, the public-web acceptance procedure, noVNC operations, and source export.

## Dependency order and critical path

```text
architecture review / decision gate
                 |
              P2-2A
              /    \
         P2-2B    P2-2C
              \    /
              P2-2D
                 |
              P2-2E
                 |
              P2-2F
```

The critical path remains decision gate → A → {B and C} → D → E → F. The reviewed decision gate is closed; apply the narrow A provenance-contract correction, then complete the B wiring update and C protected observation in parallel. Both must pass their revised exit criteria before D begins. P2-2B remains the stable local Node workflow entry point needed by later integration, but P2-2 does not define the P2-3 transport envelope.

## P2-2 exit gate

P2-2 is complete when a developer can invoke one documented local Node command with a target URL, natural-language task, and trusted versioned profile reference; observe every browser phase through headed instances created only by the protected factory; receive a typed outcome and reconstructable evidence; and run the same workflow in a separate fresh headless execution with equivalent normalized engine semantics under a distinct compatible profile. Each run retains its own profile fingerprint. Every headed run has unverified physical-input provenance and `autonomousEligible: false`, even if its event log is empty. Detectable input is append-only observation evidence and never changes the typed engine result or deterministic steps. The fresh headless run is the authoritative autonomous-equivalence path. Browser-wide network policy, external-target approval, authentication references, locator quality, fresh-context replay, credential redaction, evidence restrictions, and cleanup must remain enforced.

The offline suite must remain credential-free and headless-capable. The opt-in real-provider headed proof and its display requirements are manual release gates; neither a skip nor a mocked provider satisfies them.

## Delivery risks and controls

| Risk | Early signal | Control / escalation trigger |
|---|---|---|
| Headed provenance is overstated | An empty event log or action timing is treated as proof of no physical input | Fail A/B/C/E gates; every headed run remains observational and `autonomousEligible: false`. A separate fresh headless run supplies autonomous proof. |
| Headed mode bypasses proxy or changes profile | Proxy probe, fingerprint, or outcome differs | Fail C; keep headless supported and do not add a direct-launch fallback. |
| Local URL silently expands egress | Command constructs policy from URL | Reject the change in A/B review; policy remains trusted configuration and existing external approval remains mandatory. |
| CLI becomes a second orchestration engine | Command parses model output or calls MCP/runner directly | Keep all execution in the P2-2B service and existing `handoffTask`; D only validates input and presents output. |
| Headed proof is unavailable in automation | No display or provider credential | Preserve offline/headless gates, mark the manual headed gate unverified, and do not claim P2-2 complete. |
| Sensitive values leak to terminal or artifacts | Key, auth state, raw provider body, snapshot, or restricted bytes appear in output | Fail B/D/E security checks; reuse existing redaction/access boundaries before proceeding. |

## Decisions resolved during implementation

- P2-2A selects exact field names and new-version mechanics for explicit presentation mode and the observation record, preserving legacy profile fingerprints and semantics. Its narrow follow-up makes headed provenance unverified and autonomous eligibility false independently of event count.
- P2-2C selects a bounded method to record detectable input events within the protected session. It does not need to identify physical origin; any available action-scope correlation remains informational. It must demonstrate that headed launch cannot bypass the protected boundary or become autonomous-eligible.
- P2-2D selects minimal flag/config-file syntax and exit-code numbers. These are local UX choices, not TestSpec or architecture changes.
- P2-2E selects the controlled local fixture and manual proof command. It may not substitute the later public-web gate.

The reviewed observational-provenance correction does not reopen an accepted architecture decision. P2-2 does not introduce browser authority outside the protected session, unrestricted page evaluation, or a second browser to seek physical-input attribution. Such isolation infrastructure remains deferred.
