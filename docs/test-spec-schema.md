# TestSpec and resolved-test contracts

These are conceptual, versioned JSON contracts. This draft supersedes the earlier conceptual version 1 before implementation; no runtime migration is implied. Implementation publishes machine schemas, rejects unknown operations, fields, and executable content, and requires explicit migration for any later breaking schema change. IDs are immutable within their artifact; a material change creates a new revision or attempt.

## TestSpec: interpreted user intent

```json
{
  "schemaVersion": "2",
  "testSpecId": "test-123",
  "sourceInstruction": "Go to https://example.com. Select Admin from the top-right menu.",
  "executionProfileRef": {"id": "default-desktop", "version": "1"},
  "startState": {"url": "about:blank"},
  "steps": [
    {"id": "s1", "type": "navigate", "url": "https://example.com", "sourceText": "Go to https://example.com"},
    {"id": "s2", "type": "click", "target": {"description": "Admin", "scope": [{"kind": "menu", "description": "top-right menu"}]}, "sourceText": "Select Admin from the top-right menu"}
  ]
}
```

`type` is the discriminator; action versus assertion is derived from it, not independently writable. All variants require stable `id` and `sourceText`. Their permitted fields are:

| Type | Kind | Required operation fields |
|---|---|---|
| `navigate` | action | `url` |
| `click` | action | `target` |
| `fill` | action | `target`, `value` |
| `select_option` | action | `target`, `value` |
| `assert_visible` | assertion | `target` (positive visibility only in MVP) |
| `assert_text` | assertion | `target`, `expectedText`, `match` (`exact` or `contains`) |
| `assert_value` | assertion | `target`, `expectedValue` |
| `assert_url` | assertion | `expectedUrl`, `match` (`exact` or approved pattern) |
| `wait_for` | synchronization | `condition`, `timeoutPolicyRef` |

The schema uses a closed variant for each type: a `click` cannot carry assertion fields; a `navigate` cannot carry a locator; an assertion cannot carry a fill value. `fill`/`select_option` values are literals or approved data references, never expressions. `wait_for` is an explicit bounded state condition, not an arbitrary sleep. Its required `timeoutPolicyRef` names a bounded policy in the execution profile. A timeout-policy reference may appear only where allowed. URL and pattern forms have restricted validation.

### `wait_for.condition` variants

`condition.type` is a required discriminator. The following table is the complete union; each variant accepts exactly its listed fields and rejects fields belonging to another variant. No condition has an implicit target, expected value, URL match mode, or timeout. The shared step fields remain `id`, `type: "wait_for"`, `sourceText`, `condition`, and `timeoutPolicyRef`.

| `condition.type` | Required condition fields | Evaluated state |
|---|---|---|
| `target_visible` | `target` | The described target becomes visible. |
| `url_exact` | `url` | The current URL equals the literal URL. |
| `url_pattern` | `pattern` | The current URL matches an approved, schema-validated URL pattern. |
| `target_value` | `target`, `expectedValue` | The target's value equals the literal or approved data-reference value. |

Canonical examples (each array entry is one complete `wait_for` step):

```json
[
  {"id":"s3","type":"wait_for","sourceText":"Wait for Continue to appear","condition":{"type":"target_visible","target":{"description":"Continue button"}},"timeoutPolicyRef":"default"},
  {"id":"s4","type":"wait_for","sourceText":"Wait for the settings page","condition":{"type":"url_exact","url":"https://example.com/settings"},"timeoutPolicyRef":"default"},
  {"id":"s5","type":"wait_for","sourceText":"Wait for the order page","condition":{"type":"url_pattern","pattern":"https://example.com/orders/*"},"timeoutPolicyRef":"default"},
  {"id":"s6","type":"wait_for","sourceText":"Wait until Role is User","condition":{"type":"target_value","target":{"description":"Role"},"expectedValue":"User"},"timeoutPolicyRef":"default"}
]
```

The approved restricted URL-pattern grammar accepts an absolute HTTP(S) URL with a single terminal `/*` pathname wildcard. The scheme, host, port, and preceding pathname segments must match the normalized current URL; `/*` matches the remaining path after that slash. The pattern contains no query, fragment, other wildcard, regular expression, or executable expression. The same approved grammar applies when `assert_url` uses pattern matching. Each variant's condition is evaluated under the referenced timeout policy, with no extra sleep or script field. Unknown condition types and extra condition fields fail schema validation.

Targets preserve user wording and ordered semantic scopes (`menu`, `dialog`, `region`, `row`, `frame`). A scope describes intent, not a selector or executable expression. Material ambiguity returns `AMBIGUOUS_INSTRUCTION`; it never creates a guessed runnable target. TestSpec cannot contain JavaScript, Playwright source, CSS/XPath, MCP refs, prompts, or generated locator data. Assertions for Admin, User, and Config remain separate authored steps.

`executionProfileRef` identifies an immutable versioned profile shared by exploration, locator validation, and replay. The persisted profile metadata contains browser engine, viewport, locale, applicable timezone/color scheme/device emulation, relevant feature flags, timeout policy, network-policy reference, and a versioned auth/storage-state **reference**. Credentials and storage-state contents are held separately. A profile mismatch blocks a run; material changes require a new profile version and renewed validation.

## ResolvedTestSpec: accepted executable sequence

```json
{
  "schemaVersion": "2",
  "resolvedSpecId": "resolved-456",
  "testSpecId": "test-123",
  "explorationAttemptId": "explore-789",
  "executionProfileRef": {"id": "default-desktop", "version": "1"},
  "runtimeVersions": {"playwright": "pinned", "mcp": "pinned", "runner": "1"},
  "executionSteps": [
    {"id": "x0", "originStepId": "s1", "source": "authored", "type": "navigate", "url": "https://example.com", "derivationEvidenceRef": "evidence/explore-789/x0.json"},
    {
      "id": "x1", "originStepId": "s2", "source": "discoveredPrerequisite", "reason": "Expose the Admin menu item", "type": "click",
      "locatorId": "loc-1", "targetDescription": "top-right menu",
      "locator": {
        "mcpGeneratedExpression": "getByRole('button', { name: 'Menu' })",
        "validatedForm": {"type": "role", "role": "button", "name": "Menu"},
        "observed": {"role": "button", "accessibleName": "Menu", "matchCount": 1},
        "quality": {"status": "accepted", "identityBasis": "role-and-accessible-name"}
      },
      "derivationEvidenceRef": "evidence/explore-789/x1.json"
    },
    {
      "id": "x2", "originStepId": "s2", "source": "authored", "type": "click",
      "locatorId": "loc-2", "targetDescription": "Admin in the top-right menu",
      "locator": {
        "mcpGeneratedExpression": "getByRole('menuitem', { name: 'Admin' })",
        "validatedForm": {"type": "role", "role": "menuitem", "name": "Admin"},
        "observed": {"role": "menuitem", "accessibleName": "Admin", "matchCount": 1},
        "quality": {"status": "accepted", "identityBasis": "role-and-accessible-name"}
      },
      "derivationEvidenceRef": "evidence/explore-789/x2.json"
    }
  ]
}
```

`executionSteps` is an ordered list, not a map. For every authored TestSpec step, it contains the final authored operation and zero or more preceding `source: discoveredPrerequisite` operations. A prerequisite also has `originStepId`, its own `id` and locator (when targeted), and `reason` explaining why that authored step needs it. For example, “Select Admin from the top-right menu” becomes a discovered menu click followed by an authored Admin click. A state wait needed after opening the menu is an explicit bounded `wait_for` execution step. The resolver reuses prior authored operations instead of recording duplicates. Only operations required to recreate the explored state are persisted; no conditional branches or arbitrary code are allowed.

Every targeted operation, including a prerequisite, passes the same locator-generation and quality gate. Each execution step records a derivation evidence reference and an expected transition or condition when the instruction requires one. When a prerequisite exists only to expose the next target, the next step's locator-binding check is its deterministic postcondition. The runner executes list order from the declared start state, records one outcome per execution step, and marks dependent steps `NOT_RUN` on failure. A rejected locator cannot enter an accepted runnable ResolvedTestSpec. A new exploration attempt produces a new `resolvedSpecId`; the previous artifact and evidence remain immutable.

### Minimal locator form

`validatedForm` is the sole runner input. It is a closed recursive union with three permitted shapes:

| Shape | Fields | Meaning |
|---|---|---|
| Ordinary | `type: role \| label \| placeholder \| text \| testId` and the selector's literal arguments | Match by reviewed semantic or stable application identity. |
| Scoped | `type: within`, `scope` (an ordinary or scoped form), `target` (an ordinary or scoped form) | Resolve the target inside a stable parent, region, row, or dialog. |
| Frame-scoped | `type: frame`, `frame` (reviewed stable frame identity), `target` (ordinary or scoped form) | Resolve inside a specific iframe. |

The frame identity grammar is narrow enough to represent the spike's `iframe[title="payment frame"]` followed by `contentFrame()`. It accepts a reviewed stable frame title or equivalent semantic/application identity and rejects incidental positional CSS/XPath. Frame-scoped and nested forms preserve ordering. The exact MCP expression is retained for provenance only; a strict parser creates the form and never executes the expression as JavaScript. Coordinates, arbitrary CSS/XPath, `nth`, transient IDs, and unsupported methods cannot enter the runner. The quality gate may reject a syntactically valid form, as it did for glyph text in Scenario 8.

## Outcomes and evidence correlation

```json
{
  "executionRunId": "run-101", "resolvedSpecId": "resolved-456",
  "testSpecId": "test-123", "explorationAttemptId": "explore-789",
  "executionProfileRef": {"id": "default-desktop", "version": "1"},
  "originStepId": "s2", "executionStepId": "x1", "locatorId": "loc-1",
  "phase": "execution", "status": "OPERATION_SUCCEEDED",
  "expected": "Admin menu item visible", "actual": "Admin menu item visible",
  "evidenceRefs": ["evidence/run-101/x1.json"]
}
```

Assign a new immutable `explorationAttemptId` for each resolution attempt and a new immutable `executionRunId` for each deterministic run. Each artifact references `testSpecId`, its authored `originStepId`, applicable execution step and locator IDs, and the originating attempt or run. Evidence paths are run/attempt scoped; a later attempt never overwrites earlier evidence. Exploration status is `resolved`, `ambiguous`, or `unresolved`; A/B/C/D remain experiment-reporting terms.

Runtime zero-match classification follows the operation. A targeted action (`click`, `fill`, or `select_option`) with zero matches after its allowed wait returns `LOCATOR_BINDING_FAILED` with reason `NO_MATCH`; multiple matches when uniqueness is required return the same status with reason `AMBIGUOUS_MATCH`. A positive target assertion (`assert_visible`, `assert_text`, or `assert_value`) with zero matches has been evaluated and returns `QA_ASSERTION_FAILED` with reason `NO_MATCH`; a matched element that violates the asserted state returns `QA_ASSERTION_FAILED` with an appropriate reason such as `NOT_VISIBLE`. Multiple matches when a unique assertion target is required return `LOCATOR_BINDING_FAILED` with `AMBIGUOUS_MATCH`. Other false evaluated assertions also return `QA_ASSERTION_FAILED` with an appropriate reason. Malformed locator forms, unsupported locator semantics, frame-resolution failures, inability to evaluate a locator, or mismatch with stored identity constraints return `LOCATOR_BINDING_FAILED`. Thus `LOCATOR_BINDING_FAILED` means the runner could not reliably bind or evaluate the operation target; `QA_ASSERTION_FAILED` means it evaluated the asserted condition and the product did not satisfy it. A targeted `wait_for` is synchronization rather than a QA assertion: if its target never binds by the bounded deadline, it returns `LOCATOR_BINDING_FAILED` with `NO_MATCH`. The runner never repairs a locator. Regeneration requires an explicit new exploration attempt. Other categories include interpretation, ambiguity, MCP exploration, locator generation, test-build, and browser/environment failures. An unexecuted dependent assertion is `NOT_RUN`. Every outcome carries typed reason, expected/actual values where relevant, timestamps, retryability, and redacted evidence references so results can be interpreted without rerunning exploration.
