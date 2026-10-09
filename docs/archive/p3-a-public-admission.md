# P3-A public URL admission contract

This implements the P3-G0 decision for a **local, single-operator** workflow. It does not change subprocess protocol v1. The Streamlit form supplies a candidate URL and task, never a policy, DNS pin, approval, artifact root, or provider credential.

## Versioned admission

The separate Node admission record uses `admissionVersion: "1"`. `inspectPublicUrl` canonicalizes one absolute HTTP(S) URL and resolves its hostname. Inspection returns the canonical start URL, host, default port (80 or 443), the complete sorted DNS address set, timestamp, and digest. This is information for the operator; it grants no browser or proxy authority.

A trusted local operator separately approves that inspection. Approval re-resolves DNS and requires the exact same address set and an exact canonical URL confirmation. It produces one immutable headless Docker profile, one exact-host/default-port policy, and an approval binding the start URL, DNS pins, profile reference, and effective-profile fingerprint. The content-derived profile/policy identity changes when the URL or pins change. A changed DNS answer requires a new inspection and approval; it never updates an existing policy.

The production workflow reads the resulting trusted configuration through its existing launch-side `--config` path. Its request still carries only task text, the exact approved start URL, and profile reference. At launch, Node checks the approval and fingerprint before provider, artifact, or browser work, then verifies current DNS against the pins. Every exploration and replay session checks the same effective profile. The proxy re-resolves and checks every HTTP request, CONNECT tunnel, and WebSocket upgrade. A changed answer, cross-host redirect, or secondary host is denied. Same-host redirects retain the approved host/port boundary; the HTTPS proxy cannot restrict paths inside the tunnel. Any additional host requires a distinct reviewed policy and approval; P3-A does not add hosts automatically.

Admission rejects URL credentials, fragments, IP literals, non-default ports, invalid/single-label/local names, and non-HTTP(S) schemes. All DNS answers must be globally routable under the conservative address classifier; private, loopback, link-local, carrier-grade NAT, reserved, documentation, multicast, IPv4-mapped IPv6, and other special-use ranges fail closed. DNS failure, empty answers, excessive answer sets, changed answers, invalid approval, and unavailable policy also fail closed. The isolated browser has no direct-egress fallback or provider credential.

## Operator workflow

After `npm run build`, inspect a candidate in PowerShell 7:

```powershell
node .\dist\profile\admission-cli.js inspect 'https://example.org/' | Set-Content -Encoding utf8 .\candidate-inspection.json
Get-Content .\candidate-inspection.json
```

Review the exact URL, host, port, and addresses. From an interactive terminal, approve it into a **new** trusted configuration file:

```powershell
node .\dist\profile\admission-cli.js approve .\candidate-inspection.json .\config\admitted-example.json .\jobs\admitted-example
```

The command shows a fresh DNS inspection and requires the operator to type the complete canonical URL. It fails if DNS changed since the saved inspection. The output file is created exclusively; an existing approval is never overwritten. The operator controls the configuration path and artifact root outside task data. Protect inspection and configuration files as local operational data, especially when URLs contain query parameters. Do not place `OPENAI_API_KEY` in either file.

The approved configuration can be selected by the existing production Node subprocess launch path. The Phase 3 UI uses this separate admission/selection flow; it does not invoke approval automatically or interpret a candidate URL as an approved one. A user-visible denial is a launch/admission failure, not a QA assertion failure.

The separate read-only lookup exchange is also `admissionVersion: "1"`. It accepts one closed JSON request on stdin, at most 8 KiB, while the trusted configuration path remains a launch-side argument. Its response is either `{"admissionVersion":"1","kind":"denied"}` or `kind: "approved"` with only the canonical URL, profile reference, and fingerprint. It reads a configuration file of at most 1 MiB, validates its approval and effective profile, and exposes no pins, artifact path, task text, or credentials. It never changes policy or subprocess protocol v1. For example:

```powershell
'{"admissionVersion":"1","kind":"lookup","targetUrl":"https://example.org/"}' |
  node .\dist\profile\admission-cli.js lookup .\config\admitted-example.json
```

The implemented P3-D host consumes this result only with an operator-selected trusted configuration path. A denied result does not trigger approval or expand network authority.

## Proof and rollback

`tests/public-admission-p3a.spec.ts` proves two previously unconfigured hosts, exact binding, unsafe-address denial, DNS drift, redirect/secondary denial, and recovery through a fresh approved identity. The opt-in `tests/public-admission-runtime-p3a.spec.ts` uses the exact admitted profiles with Docker and public connectivity to verify protected browser control, approved transport, credential-sentinel exclusion, proxy denial, proxy-unavailable failure, and disposal. Run it before public live use:

```powershell
$env:PUBLIC_BROWSER_P3A_RUNTIME = '1'
try { npx.cmd playwright test tests/public-admission-runtime-p3a.spec.ts --workers=1 }
finally { Remove-Item Env:PUBLIC_BROWSER_P3A_RUNTIME -ErrorAction SilentlyContinue }
docker ps -a --filter 'name=public-browser-g1-' --format '{{.Names}} {{.Status}}'
```

If the proof or a later site run fails, stop using that admission and select the previous trusted configuration. Do not edit pins under an existing profile identity, open direct browser egress, or add page-discovered hosts to recover. DNS and site behavior can change after approval; the resulting stop is intentional and requires a new operator review.
