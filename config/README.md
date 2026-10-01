# Public acceptance launch configuration

`public-columbia.json` is the trusted launch configuration for Work Package A. It is read with `--config` by the production Node subprocess; the Python request can only select `columbia-public-headless@1` by reference. It is not a request field, model input, or browser environment setting.

The v1 approval permits only the exact start URL `https://www.columbia.edu/~fdc/sample.html`. Browser egress is deliberately host-wide within **`www.columbia.edu:443`** because the existing HTTPS CONNECT proxy authorizes destinations at the host and port boundary; it cannot authorize individual paths inside TLS. The profile is headless and requires the disposable Docker browser. It carries no authentication state or provider credential. Every page request, redirect, frame, subresource, fetch, and WebSocket attempt still traverses the existing protected proxy and its exact DNS pin check. Other hosts, ports, and changed DNS answers fail closed. The site may need secondary traffic; this file does not preapprove it.

The address pins `162.159.128.65` and `162.159.138.64` came from a read-only `Resolve-DnsName www.columbia.edu -Type A` observation on **2026-09-22 06:09 UTC** (observed TTL 847 seconds). They are a point-in-time approval, not a claim that Columbia's DNS remains fixed. A changed answer, required secondary host, or change to the allowed scope requires security review, a new policy/profile version, and a new approval fingerprint. Never substitute a runtime DNS answer or page request into this file automatically. The approval validator rejects private/reserved IPv4 pins and all IPv6 pins in v1.

The `profileFingerprint` binds the approval to the exact parsed profile and policy. Altering settings or pins under the same ID/version invalidates the trusted configuration. The relative artifact root is Node-owned; the subprocess response returns only a safe report reference. Provider credentials stay in the trusted Node process environment and must not be added to this file.

The integrated G1 container proof must be repeated with this exact configuration before the protected Columbia survey. A failed policy lookup or missing proxy has no direct-network fallback. To roll back, select the prior local-only trusted configuration; do not weaken the public policy or reuse this profile ID/version with different settings.

## Cloudflare diagnostic configuration

`public-columbia-cloudflare-diagnostic.json` is a separate trusted launch configuration for the security-approved **diagnostic survey only**. It selects `columbia-public-headless@2`, `columbia-public-egress@2`, and approval version `2`. The v1 configuration above remains available unchanged as the rollback. The start URL remains the exact Columbia sample URL. The only additional destination is `challenges.cloudflare.com:443`; unrelated hosts and ports remain denied. This configuration does not authorize challenge bypass or the final credentialed acceptance proof.

On **2026-09-22 16:10 UTC**, the local DNS resolver and `1.1.1.1` agreed on Cloudflare A records `104.18.94.41` and `104.18.95.41` and AAAA records `2606:4700::6812:5e29` and `2606:4700::6812:5f29`. The Columbia pins remain `162.159.128.65` and `162.159.138.64`. Both hosts are re-resolved for each proxy request; every answer must match its exact reviewed set. Cloudflare records have short TTLs, so DNS drift can stop a later run. Recheck all answers before the next protected survey. Changed answers require another reviewed version and approval fingerprint, never an automatic policy update.

The trusted host had no route to the observed Cloudflare IPv6 addresses during this review. The proxy still verifies every A and AAAA answer against the approved pins, then selects an approved IPv4 answer when one exists. The isolated browser still has no direct egress. G1's complete proof suite must pass again under this v2 configuration before the diagnostic survey starts. Never put provider credentials in either configuration, and redact Cloudflare challenge-token query strings from safe survey evidence.

## Replacement-target qualification configuration

`public-challenging-dom-qualification.json` is a survey-only trusted configuration for evaluating `https://the-internet.herokuapp.com/challenging_dom` as a potential replacement target. It selects the disposable Docker browser profile `challenging-dom-qualification-headless@1` and permits only `the-internet.herokuapp.com:443` at the four reviewed IPv4 pins recorded in that file. It intentionally has **no** `publicTargetApproval`: it cannot be selected by the production local or Python-to-Node workflow and does not make the candidate an accepted public target.

The opt-in survey records only sanitized request metadata, table/control counts, and a few bounded row-text samples. It does not call OpenAI, MCP, or the deterministic acceptance assertion. A passing survey establishes only target suitability; adoption still needs separate target approval, G1 proof under any adopted profile, and a reviewed acceptance task.

## Replacement-target production configuration

`public-challenging-dom.json` is the trusted production configuration for the
reviewed replacement acceptance task. It selects
`challenging-dom-public-headless@1`, `challenging-dom-public-egress@1`, and
approval version `3`. The approval binds the exact start URL
`https://the-internet.herokuapp.com/challenging_dom` to the effective profile
fingerprint. It does not authorize another path, host, port, profile, or policy.

The sole browser destination is `the-internet.herokuapp.com:443`, pinned to
`3.209.172.72`, `23.22.130.173`, `54.243.238.66`, and `107.22.57.98`. Those A
records were first captured by the protected qualification survey and were
confirmed again with `Resolve-DnsName` on 2026-09-22 (observed TTL 45 seconds).
The optional `298279967.log.optimizely.com` telemetry seen during qualification
remains denied because the page and scoped `#edit` interaction work without it.
Any DNS change or newly required destination needs a new reviewed profile,
policy, and approval fingerprint; runtime observations never update authority.

This production approval enables only the trusted launch boundary. It does not
claim that G1 has passed under this profile, that OpenAI/MCP has run, or that the
replacement public acceptance scenario has passed.
