# Supported semantic UI tests

**“Arbitrary” means arbitrary wording that can be faithfully represented within the supported semantic and browser-operation vocabulary.** This is not a general-purpose browser agent. Current source, especially the [TestSpec v7 contract](../app/domain/semantic-intent-v3.ts), [grounder](../app/exploration/semantic-grounding-v1.ts), [resolved v10 contract](../app/domain/semantic-resolved-v10.ts), and [runner](../app/runner/semantic-v10.ts), wins if this list drifts.

## Actions

| Semantic intent | Current browser mechanic |
|---|---|
| Navigate to an absolute HTTP(S) URL represented in the admitted test | Main-page navigation; the request's public target still requires separate exact approval |
| Activate a supported button, link, checkbox, radio, menu item, tab, or switch | `click` |
| Set checked state to true; set a checkbox false | `check` / `uncheck` on native input controls; a radio cannot be unchecked |
| Choose one enabled option from a native single-select | `selectOption` using a uniquely owned option label/value |
| Set an editable input or textarea value | `fill` |

The author may explicitly require `click`, `type`, or `press` as a mechanic, but grounding accepts only a mechanic it can prove. An incompatible explicit mechanic stops; `type` and `press` do not create free-form keyboard flows.

## Verifications

| Semantic check | Current deterministic assertion |
|---|---|
| URL equals an expected URL | Exact current-page URL comparison |
| Existence / cardinality of a target domain | Count with `equals`, `at_least`, or `at_most` where specified |
| Visible, enabled, checked | Boolean property equals true or false |
| Input value | Exact value equality |
| Native selected option | Whether a specifically owned label/value option is selected |

Some resulting-state checks may use a bounded wait from the trusted profile. A verification is meaningful only after browser grounding and replay guards establish its target and domain.

## Target identity

TestSpec v7 separates category, exact name, context, authored ordinal (1–100), and relation. It records `same_as_step`, `created_by_step`, and author-permitted `any_matching` meaning. Current action grounding still requires a uniquely provable candidate; `any_matching` never licenses an arbitrary first match. Grounding constructs a complete ordered candidate domain, proves an ordinal or relationship, and stops on unresolved ambiguity. The compiler and runner independently reconstruct the domain and guard identity, ordering, and count. See the [architecture](architecture.md) for authority boundaries.

## Current limits

- The candidate and runner paths require the main frame; multi-frame pages are unsupported.
- Native single-select is supported. Custom select widgets and native multi-select are not.
- Drag/drop, arbitrary keyboard sequences, and unrestricted search/recovery are not implemented.
- Browser-dependent identity that cannot be proved uniquely, or changes between grounding, compilation, and replay, stops rather than selecting a convenient element.
- Public target availability, redirects, and page timing can prevent the path from being established or reproduced.

The output is a **ResolvedTestSpec v10 data artifact** for this repository's deterministic Playwright runner. No Playwright Test `.spec.ts` source is generated.
