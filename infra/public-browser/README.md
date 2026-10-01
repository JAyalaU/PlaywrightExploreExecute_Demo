# Public browser compartment

This is the G1 browser-only boundary for public runs. It is intentionally not a
general browser platform and cannot be used as a host-launched fallback.

## P4-3A headed runtime variant

`Dockerfile.headed` builds the separately tagged
`playwright-demo-public-browser-headed:1.63.0-p4-3a` image from the same pinned
Playwright/Chromium release as the headless image. It adds Xvfb, x11vnc, and
the distribution's noVNC static client assets under
`/opt/public-browser/novnc`. The image contains no HTTP viewer or WebSocket
gateway. The later trusted Node package owns serving those read-only local
assets and relaying RFB; the browser container only provides loopback RFB.

The headed entrypoint starts a 1280x800 virtual X display, then an x11vnc
server bound to `127.0.0.1:5900`, then the normal Playwright Chromium executable
without `--headless`. The same process exposes the existing private CDP port
and uses the required proxy. The RFB server runs with server-side `-viewonly`,
`-noclipboard`, and `-nosel`; it has no password because only a private
Docker-exec bridge in the later Node package can reach its container-loopback
listener. Do not publish port 5900 or join the container to a non-internal
network. `entrypoint.sh` and the existing headless image remain unchanged.

The container entrypoint supervises all three processes. A display or RFB
startup failure prevents Chromium startup. Chromium exit, cancellation, or
container stop terminates the RFB server and virtual display. All display and
browser state stays in the container's disposable `/tmp`; the existing
read-only, unprivileged, dropped-capability, no-mount, no-credential,
no-direct-egress boundary still applies. `--no-sandbox` remains the reviewed
Chromium posture inside this compartment.

Build and run the static and Docker runtime proofs from PowerShell 7 at the
repository root:

```powershell
npm.cmd run test:p4-3a-container
```

The verifier builds the headed image, starts one disposable session, checks
the compartment has no mounts or published ports, verifies Xvfb/x11vnc/the
same headed Chromium are running, performs an RFB handshake, sends forged
keyboard/pointer/clipboard messages, and confirms the browser page received no
input. It then removes the container and checks for residual P4-3A containers.
It uses a dummy unavailable proxy and a generated non-secret control token; it
does not use the OpenAI key or navigate to a public target.

P4-3A supplies the container image/runtime only. It does not authorize headed
public execution. P4-3B must add the distinct profile schema v4, admission v2,
trusted headed approval, private viewer gateway, and profile fingerprint
binding before a headed public run can be selected.

## Security invariants

- The service has no bind mounts, including repository and operator-home paths.
- It runs as `pwuser`, read-only, with all Linux capabilities dropped and only
  disposable `/tmp` storage.
- It inherits no environment. `OPENAI_API_KEY` is never declared or forwarded.
- The declarative Compose boundary has only the internal `browser-control`
  network. The Node runtime uses the same image with `--network none`, leaving
  only container loopback and no direct public, private, metadata, or DNS route.
- Chromium requires a proxy value and uses `--proxy-bypass-list=<-loopback>`;
  absent proxy configuration fails startup.
- The debugging port is exposed only inside the internal network. It is never
  published on a host interface.

## Integration boundary

Node creates a fresh container per protected session. Two Docker-exec standard
streams provide private CDP control and forward only the container's loopback
proxy port to the existing authoritative `ProtectedProxy`. Neither stream
publishes a host port or grants browser access to other host services. A
per-run token confirms the intended container on both streams. The container
receives only that token and the loopback proxy address. Session closure
forcibly removes the container and verifies its disposal.

Docker Desktop's default user-namespace settings prevent Chromium's inner
sandbox from starting with the required dropped container privileges. The
Node launcher supplies `--no-sandbox` to Chromium while retaining the
read-only, unprivileged, mountless, networkless container boundary. This
tradeoff requires security review before the public-site survey.

Run `scripts/verify-public-browser-container.ps1` after Docker Desktop is
available. It performs declarative checks first and then requires a live
container proof. Do not run a Columbia survey or provide an API key to this
container.

## Manual container-boundary proof

On 2026-09-21, the developer ran the verifier against Docker Desktop's Linux
engine `29.8.0` after building `playwright-demo-public-browser:1.63.0`. It
emitted `PUBLIC_BROWSER_CONTAINER_STATIC_AND_FILE_PROOFS_PASSED`, and the
`public-browser-g1-*` container filter returned no remaining containers.

This records the container-only proof: the pinned image starts under the
restricted probe, the declared mountless configuration is exercised with a
non-secret host-file sentinel, and the probe is disposed. It does **not**
close G1. The Node-owned private control channel, the authoritative proxy
path, integrated direct-egress denial, live browser-descendant credential
inspection, and completion/failure/timeout/cancellation disposal remain
required before the protected public-site survey can begin.

## Node runtime proof on Docker Desktop

From PowerShell 7 in the repository root, with the pinned image already built,
run the opt-in, credential-free proof:

```powershell
$env:PUBLIC_BROWSER_G1_RUNTIME = '1'
try {
  npx.cmd playwright test tests/public-browser-node-g1.spec.ts --workers=1
} finally {
  Remove-Item Env:PUBLIC_BROWSER_G1_RUNTIME -ErrorAction SilentlyContinue
}
docker ps -a --filter "name=public-browser-g1-" --format "{{.Names}} {{.Status}}"
```

It checks mountless/networkless launch, browser-descendant credential-name
absence, direct-socket denial, approved and denied proxy traffic, MCP control,
two fresh deterministic runs, cancellation, and disposal. It uses only a local fixture and
needs no OpenAI credential. Return the test summary and final `docker ps`
output without environment values or browser artifacts. Work Package A's
reviewed public profile/policy and a security review are still required before
the Columbia survey.

On 2026-09-22, this integrated local proof passed all three tests in 18.0
seconds and the final container listing was empty. That proves the local
fixture path only; G1's integrated public-profile exit still depends on A.

## Exact approved public-profile proof

After the trusted Cloudflare diagnostic profile in
`config/public-columbia-cloudflare-diagnostic.json` is present, run this
separate, credential-free proof before the protected survey. It opens the exact
`columbia-public-headless@2` isolated session and makes bounded HTTPS requests
to both reviewed hosts through the proxy. It does not inspect Columbia content
or evaluate the acceptance claim:

```powershell
$env:PUBLIC_BROWSER_G1_RUNTIME = '1'
try {
  npx.cmd playwright test tests/public-browser-public-profile-g1.spec.ts --workers=1
} finally {
  Remove-Item Env:PUBLIC_BROWSER_G1_RUNTIME -ErrorAction SilentlyContinue
}
docker ps -a --filter "name=public-browser-g1-" --format "{{.Names}} {{.Status}}"
```

The proof injects only a non-secret sentinel into the trusted Node process. It
checks the approved v2 profile fingerprint, mountless/networkless container,
private Playwright control, absent credential name and sentinel in browser
descendants, direct-egress denial, proxy-denied browser traffic, fail-closed
unavailable-proxy startup, and container disposal after normal, controlled
failure, timeout, and cancellation paths. An HTTPS response proves transport
even if a public host answers with an application-level challenge or 403; the
later protected survey determines whether the page is usable. The proof emits
only host and status, never a challenge URL or query token. Return the
Playwright test summary and the empty final container listing. Do not return
environment values or inspect Columbia page content as part of this command.

Historical v1 record: on 2026-09-22, the developer ran the former two-test
`columbia-public-headless@1` proof in 3.3 seconds, with empty post-run
`public-browser-g1-*` listings. It established the original one-host profile
only and cannot substitute for the v2 diagnostic proof.

Historical v1 record: the former five-test proof also passed after correcting
the proxy's parsing of an explicit default HTTPS CONNECT port. It reached the
approved Columbia host and verified normal/failure/timeout/cancellation
disposal. It did not exercise the approved Cloudflare diagnostic dependency.

**v2 proof record (2026-09-22):** the developer ran the command above with
the exact diagnostic profile. All five tests passed in 11.2 seconds. The
sanitized transport results were `www.columbia.edu:403` and
`challenges.cloudflare.com:200`; the final `public-browser-g1-*` listing was
empty. This closes the v2 G1 runtime proof: proxy-only transport reached both
reviewed hosts, while direct egress, unavailable-proxy startup, credential
sentinel exposure, and disposal failures remained covered by the same suite.
No challenge URL, query token, provider credential, or acceptance result was
recorded. A 403 or challenge response is a site-level observation, not an
acceptance-claim result.
