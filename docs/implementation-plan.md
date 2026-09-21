# Implementation plan: natural-language UI validation MVP

## 1. Purpose and implementation principles

This plan takes the repository from the approved architecture to a working MVP. [Architecture](architecture.md) and [TestSpec contracts](test-spec-schema.md) are authoritative. The completed Playwright MCP spike is regression evidence and does not constitute production code.

Architecture changes require an explicit architecture revision; a work package must not introduce one implicitly. Build closed contracts and the deterministic core before model-driven exploration. Keep the implementation a modular monolith, keep the fixture spike isolated under `spikes/playwright-mcp/`, and use vertical, testable increments.

## 2. Dependency map

| Capability | Depends on | Enables | Reason |
|---|---|---|---|
| Runtime/package-layout decision | Approved documents and repository state | Production domain contracts and all later capabilities | Contracts must be placed in the selected production runtime before downstream modules depend on them. |
| Versioned domain contracts | Runtime/package-layout gate and approved documents | All later capabilities | Browser work must reject invalid or ambiguous artifacts first. |
| Declarative locator parsing and quality | Domain contracts | Binding and locator acceptance | The runner consumes validated data, never executable MCP expressions. |
| Execution profile and network boundary | Domain contracts; independent of M2 binding interface | All browser sessions | Exploration, validation, and replay must share an effective environment and governed egress. |
| Deterministic runner | Locator and binding contracts plus profile and network boundary | Replay and resolver acceptance | It is the LLM-free substrate beneath exploration. |
| Immutable artifacts and typed reporting | IDs, contracts, runner results | Auditability | Attempts and runs must survive restarts and remain interpretable. |
| MCP resolver and prerequisite capture | Runner, artifacts, locator gate, browser boundary | ResolvedTestSpec | Every discovered state transition must be executable from clean state. |
| Interpretation and bounded orchestration | TestSpec validator and resolver | User workflow | Model output must be validated and tool-limited. |
| End-to-end gates | All prior capabilities | MVP completion | Confirms the complete boundary-preserving workflow. |

**Critical path:** runtime/package-layout gate → contracts → parallel locator handling (M2) and profile/browser boundary (M3) → deterministic runner → immutable artifacts → MCP resolver with prerequisites → bounded orchestration → end-to-end gates. M4 waits for both M2 and M3; neither is a prerequisite of the other.

After the runtime/package-layout gate and M1 contracts stabilize, M2 locator work and M3 profile/policy work can proceed independently. Evidence storage can begin alongside runner implementation after ID and result shapes are fixed, but M5 acceptance waits for M4 outcomes. Browser fixtures can be prepared alongside module work, but never waive a milestone exit gate. Optional noVNC work starts only after the browser-session boundary is stable and is not on the critical path.

## 3. Implementation milestones

### Pre-implementation decision gate — production runtime and package layout

**Decision:** Use TypeScript on Node.js for the production runtime, with Playwright Test as the deterministic browser execution substrate. Use one production Node package at the repository root, with TypeScript source in a dedicated `app/` tree. Keep domain/TestSpec, locator, execution profile/network, runner/result, evidence/persistence, and exploration/orchestration as logical modules within that package; do not split them into independently deployed packages or services. This keeps the deterministic contracts and runner in one type system and avoids a Python-to-Node boundary within execution.

**Recorded implementation:** The root `package.json` is the single production package. Node.js 24, ESM (`type: module`), TypeScript `NodeNext` resolution, strict compiler checks, and a committed npm lockfile establish its toolchain. `app/` contains the logical `domain/`, `locator/`, `profile/`, `runner/`, `result/`, `evidence/`, and `exploration/` boundaries; `tests/` is the production Playwright Test discovery root. The root package provides `typecheck`, `build`, and `test` commands. These directories reserve ownership without implementing milestone behavior.

The existing `src/playwright_demo/` Python starter, `pyproject.toml`, and `uv.lock` remain untouched and are explicitly non-production. Their cleanup is a separate implementation decision because their use outside the approved production runtime has not been established. The experimental `spikes/playwright-mcp/` package remains separate. No Python-to-Node interoperability is planned. The browser-egress enforcement mechanism remains an M3 implementation decision.

**Acceptance criteria:** The production runtime, single-package layout, logical module boundaries, and Python-scaffold disposition are recorded before M1-A starts. The M1-A owner can place production TypeScript contracts without choosing a language or package boundary during coding. This gate is a prerequisite, not an additional architecture milestone.

**Gate status:** COMPLETE. The installed root toolchain passed `npm run typecheck`, `npm test` (zero production tests at this gate), and `npm run build`; `git diff --check` passed. M1-A may begin in `app/domain/` after this gate.

### Milestone 1 — Validated domain contracts

**Goal:** Validate a request or persisted artifact deterministically without starting a browser.

**Scope:** Machine schemas and types for TestSpec, targets/scopes, resolved execution steps, locator forms, execution-profile references, IDs, and typed results. Preserve closed operations and the closed `wait_for.condition.type` union.

**Out of scope:** Playwright, MCP, LLMs, network access, and artifact storage.

**Required inputs:** Completed runtime/package-layout gate; `docs/test-spec-schema.md`; result and execution-boundary sections of `docs/architecture.md`.

| Work package | Responsibility / artifacts | Dependencies and constraints | Tests |
|---|---|---|---|
| M1-A Contract definitions | Publish production TypeScript domain schemas and typed representations in the selected production structure. | Runtime/package-layout gate and approved contracts; reject unknown variants/fields and executable content. | Valid and invalid fixtures; serialization round trips. |
| M1-B Validation and IDs | Validate versions, step references, unique IDs, ordering, and immutable ID rules. | M1-A; no browser checks. | Duplicate IDs, missing origins, wrong fields, extra wait fields, unsupported versions. |
| M1-C Contract examples | Convert documented examples and representative spike cases into fixtures. | M1-A; examples reflect approved semantics. | Positive examples validate; deliberately invalid examples fail. |

**Acceptance criteria:** Each approved operation and wait variant has valid fixtures. Invalid field combinations, unsupported versions, missing references, executable content, and ambiguous locator shapes fail validation. Accepted resolved specs preserve ordered authored and prerequisite operations.

**Tests:** Schema and contract tests.

**Exit gate:** Published versioned TypeScript domain types and validation behavior are stable in the selected production package. Later contract changes require explicit version and compatibility treatment.

### Milestone 2 — Locator parsing, quality, and binding semantics

**Goal:** Convert an MCP-generated locator expression into a restricted declarative form and assess durability independently of successful execution.

**Scope:** Strict parser; ordinary, scoped, and frame locator forms; static quality gate; accepted-locator record; deterministic binding interface. Preserve MCP expressions only as provenance. Quality-result fields are validated with deterministic fixtures; live match count and observed-target checks are deferred to M6 under the shared execution profile.

**Out of scope:** Live MCP exploration, browser sessions, automatic repair.

**Required inputs:** M1; locator rules in `docs/architecture.md`; recorded spike expressions.

| Work package | Responsibility / artifacts | Dependencies and constraints | Tests |
|---|---|---|---|
| M2-A Restricted parser | Parse approved generated forms into the closed locator representation. | M1; never execute expressions as JavaScript. | Accepted role/label/scoped/frame forms; reject unsupported methods and arbitrary CSS/XPath. |
| M2-B Quality gate | Define separate quality-result fields for grammar, identity basis, uniqueness, observed target, and durable identity. | M2-A; fixture values test the fields, not live browser observations; replay alone never passes quality. | Scenario 8 glyph rejection; semantic and frame fixtures. |
| M2-C Binding contract | Define match-count and identity-check result shapes for the runner. | M1/M2-A; runtime inputs have no MCP refs. | Fixture cases for zero/one/multiple matches, frame failure, and unsupported form. |

**Acceptance criteria:** Represent semantic, dialog/row scoped, and spike frame forms; reject weak glyph locator quality while retaining parse and execution history separately; validate uniqueness and observed-target result fields using fixtures without claiming live checks; no accepted locator needs expression evaluation.

**Tests:** Parser/quality unit tests and recorded-spike regression fixtures.

**Exit gate:** The runner has stable declarative locator inputs and explicit binding result shapes. Live match-count and observed-target verification remains an M6 acceptance gate under the shared profile.

### Milestone 3 — Shared execution profile and protected browser boundary

**Goal:** Create reproducible browser contexts from one immutable profile with policy enforcement for all relevant browser traffic.

**Scope:** Profile resolution/version checks; browser-context factory; protected auth-state references; egress policy; lifecycle. The same profile identity applies to exploration, validation, and replay.

**Out of scope:** Model orchestration, production authentication system, noVNC, unrestricted browsing.

**Required inputs:** Completed runtime/package-layout gate, M1 profile contract, and the security boundary in the architecture. M2's binding interface is not required; M2 and M3 may proceed in parallel after M1.

| Work package | Responsibility / artifacts | Dependencies and constraints | Tests |
|---|---|---|---|
| M3-A Profile loader | Resolve immutable ID/version and material settings. | M1; credential/storage contents remain external. | Equality, missing/mismatched profile, material-change version tests. |
| M3-B Network boundary | Implement an egress enforcement point governing navigation, redirects, frames, subresources, fetch/XHR, WebSockets, and downloads. | M3-A; no ungoverned fallback. | Allowed/denied destination and redirect/address-change cases for each traffic type. |
| M3-C Context lifecycle | Create disposable contexts; record browser/tool versions. | M3-A/B; independent runs use fresh contexts. | Isolation, cleanup, storage-state leakage. |

**Acceptance criteria:** Session start fails for unavailable profiles or unenforceable policy; equivalent profile references yield equivalent effective settings; secondary traffic is governed; ordinary artifacts do not contain auth contents.

**Tests:** Profile contracts; browser integration; network-policy tests.

**Exit gate:** All browser-dependent work uses the context factory, with profile and egress enforcement proven independently of M2 binding. Arbitrary target URLs remain disabled until this passes. M4 begins only after both M2 and M3 exit gates pass.

**Implementation decision:** At this milestone choose the smallest enforceable egress mechanism. Record coverage evidence; do not change architecture.

### Milestone 4 — Deterministic browser runner

**Goal:** Execute a validated ResolvedTestSpec in a fresh Playwright context without LLM or MCP calls.

**Scope:** Fixed interpreter for navigation, click, fill, select, waits, and assertions; ordered prerequisite/authored operations; binding; operation-specific failure classification; per-step outcomes. Use resolved fixtures before live exploration.

**Out of scope:** Natural-language input, live MCP generation, regeneration, persistent reporting.

**Required inputs:** M1 contract exit gate plus both independent M2 locator/binding and M3 profile/browser-boundary exit gates.

| Work package | Responsibility / artifacts | Dependencies and constraints | Tests |
|---|---|---|---|
| M4-A Operation interpreter | Implement approved operations from validated data. | M1/M3; no executable model text or MCP call. | Each operation, ordered transitions, all wait variants. |
| M4-B Binding and classification | Apply M2 before targeted operations. | M2/M4-A; action zero match is `LOCATOR_BINDING_FAILED/NO_MATCH`; positive assertion zero match is `QA_ASSERTION_FAILED/NO_MATCH`; dependent steps can be `NOT_RUN`. | Classification matrix, prerequisite failure. |
| M4-C Clean replay | Execute resolved fixtures twice in independently created contexts. | M4-A/B; same profile and clean state. | Fresh-context replay and profile mismatch. |

**Acceptance criteria:** Recreate declared state and prerequisite order; halt dependents after intermediate failure; never mutate accepted specs or call MCP/LLM; two clean executions record distinct IDs and outcomes.

**Tests:** Unit, failure-classification, browser/runtime, deterministic replay.

**Exit gate:** A proven, fixed execution substrate exists before exploration depends on it.

### Milestone 5 — Immutable local artifacts and evidence

**Goal:** Persist specs, attempts, runs, and evidence across restarts with reconstructable identity relationships.

**Scope:** Local job directories; atomic immutable writes; redacted evidence references; IDs for TestSpec, origin step, attempt, resolved spec, execution step, locator, and execution run; typed reporting.

**Out of scope:** Database, queues, distributed tracing, broad retention platform.

**Required inputs:** M1 IDs/results and M4 outcomes.

| Work package | Responsibility / artifacts | Dependencies and constraints | Tests |
|---|---|---|---|
| M5-A Artifact store | Write versioned specs, profile refs, attempts, runs, and manifests. | M1/M4; never overwrite earlier runs/attempts. | Restart/readback, duplicate ID, partial write, integrity. |
| M5-B Evidence capture | Capture allowed screenshots/metadata and failure trace/video by policy. | M3/M4/M5-A; redact and restrict. | Artifact association and redaction. |
| M5-C Typed report | Reconstruct phase/step/run outcomes from stored artifacts. | M5-A/B; preserve QA/runtime distinction. | Report reconstruction without live browser. |

**Acceptance criteria:** Stored run explains source instruction, normalized/resolved steps, locators, profile, outcome, and evidence. Earlier records cannot be overwritten. Secrets/storage contents do not enter ordinary evidence.

**Tests:** Persistence, restart, evidence-link, reporting.

**Exit gate:** Exploration can create durable and auditable attempts.

### Milestone 6 — MCP exploration and executable prerequisite capture

**Goal:** Resolve targets through controlled MCP exploration, record the prerequisite sequence needed from clean state, generate/gate locators for every targeted operation, and replay it deterministically.

**Scope:** MCP adapter; snapshot/find evidence; locator-generation provenance; bounded controls; ordered prerequisite capture; acceptance and replay. Begin with scripted fixture decisions before model orchestration.

**Out of scope:** General natural-language interpretation, unrestricted agent behavior, selector hints, silent repair.

**Required inputs:** M1–M5 and spike fixture/results as regression material. M6 performs live match-count and observed-target checks under the same execution profile used for exploration, locator validation, and replay.

| Work package | Responsibility / artifacts | Dependencies and constraints | Tests |
|---|---|---|---|
| M6-A MCP adapter | Wrap permitted MCP calls and record outcomes under shared profile and policy. | M3/M5; normal flow prohibits arbitrary evaluation/host commands. | Capability/error handling; profile/policy consistency. |
| M6-B Resolver state recorder | Convert interactions into ordered `discoveredPrerequisite` operations linked to authored steps. | M2/M6-A; every targeted prerequisite gets its own generated, gated locator; no MCP refs persisted. | Menu, dialog, dynamic, custom control, and frame flows. |
| M6-C Acceptance and replay | Check live locator match count and observed target under the shared profile; accept only fully gated resolved specs and execute them using M4. | M3/M4/M5/M6-B; quality rejection prevents runnable persistence. | Live uniqueness/identity, explore/replay consistency, failed intermediate locator, Scenario 8 quality rejection. |

**Acceptance criteria:** A menu or dynamic fixture produces the exact ordered state-recreation sequence in a clean context; live match counts and observed targets are checked under the shared profile; target operations have validated locator forms and derivation evidence; frame context is represented declaratively; quality rejection preserves attempt evidence but blocks acceptance.

**Tests:** MCP integration, fixture browser, prerequisite replay, quality regression.

**Exit gate:** A bounded resolver produces outputs that are executable and auditable before any agentic orchestration.

### Milestone 7 — Natural-language interpretation and bounded orchestration

**Goal:** Transform a user task into validated TestSpec, resolve it through bounded MCP exploration, and return an executable spec or typed failure.

**Scope:** Whole-task interpretation call; validation before browser work; bounded iterative resolver per authored step; model context/tool policy; explicit ambiguity/error handling.

**Out of scope:** LLM-generated Playwright, model runtime execution, general hints, silent regeneration.

**Required inputs:** M1–M6.

| Work package | Responsibility / artifacts | Dependencies and constraints | Tests |
|---|---|---|---|
| M7-A Interpretation | Map requests to closed TestSpec and validate model output. | M1; page text cannot alter schema or permissions. | Valid, ambiguous, unsupported, malformed requests. |
| M7-B Step orchestration | Supply authored step, prior outcomes, current URL, bounded snapshots; enforce tools/retries. | M6; no answer key or hidden selectors. | Bounded calls, prompt injection, exploration errors. |
| M7-C Handoff | Persist distinct interpretation/exploration/quality/runtime outcomes and send accepted spec to M4. | M5–M7-B; runner remains model-free. | Full fixture flows and typed-failure handoff. |

**Acceptance criteria:** A representative request completes interpretation, resolution, quality acceptance, and deterministic replay. Unsupported/ambiguous requests stop with typed evidence. The persisted test executes after orchestration terminates.

**Tests:** Interpretation contracts, orchestration, integration, failure isolation.

**Exit gate:** Core MVP workflow is functional and ready for hardening.

### Milestone 8 — End-to-end gates and operational hardening

**Goal:** Demonstrate repeatable full-MVP behavior with controlled failures and interpretable evidence.

**Scope:** System regression; validation on real applications within safety policy; artifact access/retention controls; operator documentation; version/configuration checks. noVNC, if included, attaches only as observation after session boundaries are stable.

**Out of scope:** Product UI, distributed services, database, multi-tenant scheduling, automatic selector healing.

**Required inputs:** M1–M7.

| Work package | Responsibility / artifacts | Dependencies and constraints | Tests |
|---|---|---|---|
| M8-A System regression | Cover operation vocabulary, prerequisites, frames, profile mismatch, network denial, failures. | All milestones; preserve Scenario 8 quality distinction. | Full end-to-end and clean replay suite. |
| M8-B Operational controls | Verify cleanup, protected auth references, evidence restrictions, policy-failure behavior. | M3/M5; external targets require security gate. | Lifecycle, network-bypass, artifact exposure. |
| M8-C Runbook and optional viewing | Document setup, profile selection, outcomes, regeneration. noVNC observes only. | M3–M8-B; headless equivalence mandatory. | Headless regression; viewer-independence test. |

**Acceptance criteria:** A user task produces deterministic execution and interpretable evidence; changed locator yields binding failure and requires explicit new exploration; QA failures differ from automation failures; final release gates pass.

**Tests:** Full end-to-end, security boundary, browser lifecycle, replay, documentation.

**Exit gate:** Section 7 conditions hold.

## 4. Cross-cutting implementation requirements

| Concern | First mandatory milestone | Later extension |
|---|---|---|
| Configuration/versioning | Runtime/package-layout gate; M1 references; M3 effective profile | M4–M8 record versions/profile and block mismatch. |
| Error taxonomy | M1 typed outcomes | M4 classification; M6–M8 preserve phase boundaries. |
| Immutable identifiers | M1 rules | M5 immutable artifacts; M6–M8 locator/evidence links. |
| Security/network policy | M3 before untrusted browser access | M6 applies it to MCP; M8 tests secondary traffic and artifacts. |
| Determinism | M1 closed contracts; M2 declarative locators | M4 fixed runner; M6 prerequisites; M7 cannot change accepted run. |
| Fixtures | M1 contract examples | M2 spike expressions, M4 runner fixtures, M6 MCP fixtures, M8 regressions. |
| Persistence | M1 serializable data | M5 local immutable store; later phases retain failures separately. |
| Browser lifecycle | M3 context factory | M4 clean replay; M6 separate exploration; M8 cleanup/isolation. |
| Reproducibility | M3 profile | M4 fresh contexts; M5 versions; M6–M8 consistency. |
| Observability/docs | M1 fields | M5 manifests/reports; M8 runbook/noVNC observation. |

If an approved contract cannot represent a required behavior, record a minimal reproduction and request an explicit architecture decision before extending it.

## 5. Test strategy progression

1. **Contract validation — gate from M1.** Check each operation, wait condition, locator form, reference, version, and forbidden field combination on every contract change.
2. **Isolated deterministic tests — gate from M2.** Cover parser, locator result shapes, and quality fields with fixtures, without MCP, a browser, or a model. Live match-count and observed-target checks occur at M6.
3. **Browser integration — gate from M3.** Cover profile, isolation, network policy, and cleanup. Binding and operation behavior join the browser tests at M4; live locator acceptance checks join at M6.
4. **Clean replay — gate from M4.** Run accepted fixtures in independently created contexts with no reused page state.
5. **Exploration/replay consistency — gate from M6.** Persist each prerequisite and locator from MCP, then replay without MCP; retain Scenario 8 as a quality rejection.
6. **Agentic orchestration — gate from M7.** Check bounded calls, schema rejection, ambiguity, untrusted page text, and typed handoff.
7. **Full end-to-end — final M8 gate.** Cover representative tasks, QA failures, binding/environment failures, profile mismatch, network denial, and evidence reconstruction.

## 6. Risks and implementation traps

| Failure mode | Introduction point | Prevention/control | Detection gate |
|---|---|---|---|
| Runner repairs a locator through LLM/MCP | M4/M7 handoff | Fixed runner accepts only validated ResolvedTestSpec. | Runtime dependency test. |
| Replay relies on an unrecorded state change | M6 capture | Persist ordered prerequisites from declared start state. | Clean-context explore/replay test. |
| Profile/auth state diverges between phases | M3 wiring | Resolve one immutable profile everywhere. | Effective-profile mismatch test. |
| QA and binding failures are conflated | M4 classifier | Operation-specific result matrix. | Zero/multiple/false assertion tests. |
| Secondary traffic bypasses policy | M3 egress boundary | Govern all browser egress types. | Frame/redirect/fetch/WebSocket/download policy tests. |
| Executable MCP expression reaches runner | M2/M6 | Strict parser and AST only. | Expression rejection test. |
| Weak but unique locator persists | M2/M6 | Separate quality from execution facts. | Scenario 8 regression. |
| Evidence relationships overwrite or disappear | M5 | Immutable IDs, atomic writes, reference validation. | Restart/readback and duplicate-write tests. |
| TestSpec permits invalid/executable data | M1 | Closed variants and unknown-field rejection. | Negative contract fixtures. |
| Credentials/page secrets leak into evidence | M3/M5/M8 | External protected refs, redaction/access control. | Artifact inspection tests. |
| MCP capability differs from spike assumptions | M6 | Pin/record capability and fail explicitly. | Capability integration test. |

Each failed gate blocks dependents. The owning package supplies a reproduction and proposes either an implementation fix or an explicit architecture decision.

## 7. Definition of implementation complete

Implementation is complete when all conditions hold:

- Natural language becomes schema-valid TestSpec; ambiguous and unsupported requests are distinct typed results.
- MCP exploration uses the shared profile and browser-wide policy.
- Every required discovered prerequisite is an ordered executable operation linked to its authored step.
- MCP expressions are provenance only, parsed into restricted locator forms, and independently gated for binding, identity, and durability before acceptance.
- An accepted ResolvedTestSpec contains no MCP refs, model code, or credentials, and runs without LLM/MCP.
- Deterministic execution uses isolated fresh contexts, recreates required state, and preserves operation-specific QA and binding outcomes.
- Attempts, revisions, runs, and evidence have immutable reconstructable relationships.
- Secondary browser traffic is policy-governed; unenforceable policy prevents untrusted-target runs.
- Stored results explain requested, resolved, accepted, executed, and observed behavior without rerunning exploration.
- All milestone gates pass, including clean replay, Scenario 8 quality rejection, classification tests, and full end-to-end tests.
- Headless execution remains independent of optional noVNC.

## 8. Recommended first implementation task

First complete and record the **runtime/package-layout decision gate**: TypeScript on Node.js, Playwright Test as the execution substrate, one production Node package at the repository root with logical TypeScript modules in `app/`, and the existing Python scaffold reserved for a separate cleanup decision. Then implement **M1-A with only M1-C's minimal contract fixtures**: closed TestSpec operation schemas and `wait_for.condition` schemas for `target_visible`, `url_exact`, `url_pattern`, and `target_value`.

This is first because every interpretation, resolver, and runner stage depends on unambiguous, machine-validatable intent. Bound the task to existing operation definitions, required fields, unknown-field rejection, schema version handling, and representative valid/invalid fixtures.

**Prerequisites:** The two approved architecture documents and the completed runtime/package-layout decision gate before M1-A. The existing Python scaffold is not a production contract prerequisite.

**Acceptance criteria:** The gate records the selected TypeScript structure and Python-scaffold disposition; M1-A schemas/types are implemented there; the minimal M1-C examples validate; missing discriminators/required fields, extra fields, unsupported variants, and executable content fail validation. No browser or MCP interaction occurs.

**Do not implement yet:** browser execution, live locator binding, persistence, orchestration, agentic behavior, network enforcement, or user-facing interfaces.

**Deferred implementation decisions:** Choose the smallest enforceable browser-egress mechanism at M3 and local artifact format/retention settings at M5. Assess Python-scaffold cleanup separately without making it part of the deterministic runtime. These decisions must satisfy the approved contracts and do not change architecture.
