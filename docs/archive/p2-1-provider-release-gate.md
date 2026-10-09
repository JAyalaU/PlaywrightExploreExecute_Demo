# P2-1 provider release gate

**Status: UNVERIFIED.** The controlled live gate has not run in this checkout:
`P2_1_OPENAI_LIVE` is unset and no `OPENAI_API_KEY` was available to the
implementation session. This is an environment limitation, not a simulated
provider success.

Run the opt-in gate described in [the runbook](runbook.md#phase-2-openai-provider-release-gate) from a shell with a valid key. It uses the OpenAI
Responses API with `gpt-5.6-terra`, `medium` reasoning effort, strict Structured
Outputs, `store: false`, and no tools.

On a successful run, preserve the Playwright attachment
`p2-1-live-proof.json` from the test result. It records only safe correlation
data: model/configuration, TestSpec ID, exploration attempt ID, resolved spec
ID, two execution-run IDs, and evidence references. It never includes the API
key, raw provider response, snapshot, or artifact contents.

The gate is a deterministic-local-fixture proof only. Provider availability,
latency, rate limits, cost, and model behavior remain external variables. It
does not prove the later public-web, headed-observation, Python-host, or
Playwright-source-export objectives.
