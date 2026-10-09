# Phase 2 integration decisions

These are implementation and integration decisions for Phase 2. They do not revise the approved [architecture](architecture.md), [TestSpec contract](test-spec-schema.md), or completed M1-M8 work.

## 1. OpenAI model adapter

Use the OpenAI API through the Responses API. The default model is `gpt-5.6-terra` with initial reasoning effort `medium`.

The model identifier and reasoning effort are configuration values. They may change for evaluation of stronger or lower-cost models without changing the interpretation or step-decision adapter contracts.

Use Structured Outputs for the existing closed interpretation and step-decision schemas. The adapter provides only task text and the bounded page/context information already permitted by those contracts. It does not grant the model direct Playwright, MCP, browser, or deterministic-runner authority.

Keep provider credentials outside TestSpecs, resolved specs, normal evidence, and Python request envelopes. Prefer non-persistent API requests where supported, using `store: false`. A production or regulated deployment may require stronger provider-side retention and data-processing controls.

## 2. Local headed observation

The local headed demo uses the same protected Playwright session and browser boundary as normal execution. It must not start a second, uncontrolled browser for viewing.

Initial headed mode is observation-only. Every headed run has unverified physical-input provenance and is `autonomousEligible: false`, including when no input event was detected. Preserve its normal typed outcome and evidence; the provenance flag does not rewrite QA or automation results. Record detectable input events as append-only observations correlated with the attempt or run. An empty observation log never proves that no operator interaction occurred. Operator actions never become deterministic replay steps, prerequisites, or QA outcomes.

A separate fresh headless run is the authoritative autonomous-equivalence path. Headed and headless runs may be compared for normalized engine behavior under compatible non-presentation settings, while each keeps its own execution-profile identity and fingerprint. The comparison does not certify a headed run as autonomous. Reliable physical-input attribution would require a separately reviewed isolation mechanism and is not a Phase 2 headed-demo requirement.

Record headed or headless configuration wherever the execution-profile and session model require it for reproducibility. Headed observation continues to use the established authentication and browser-wide network-policy boundaries.

## 3. Thin Python host boundary

Use a thin subprocess boundary initially. The Python host owns invocation and process supervision. The Node application owns input validation, model orchestration, MCP exploration, browser and network policy, deterministic replay, artifacts and evidence, and cleanup.

Exchange typed JSON request and result envelopes over standard input and standard output. Send diagnostic logging to standard error so the result channel remains machine-readable. Provider credentials are not included in ordinary request envelopes.

Python does not duplicate TestSpec validation, exploration, Playwright behavior, or deterministic execution.

## 4. Optional Playwright source export

Treat `ResolvedTestSpec` to `.spec.ts` output as an optional review/export artifact for Phase 2. `ResolvedTestSpec` remains the canonical deterministic executable artifact.

The export must not introduce a second execution engine or permit model-generated Playwright source. A separately runnable export remains a future decision and is acceptable only if it preserves the established execution, policy, and result semantics.

## Architecture compatibility

These decisions preserve the deterministic execution boundary: models and MCP are limited to exploration, while the accepted resolved specification drives deterministic replay. No direct conflict with the approved architecture was identified.
