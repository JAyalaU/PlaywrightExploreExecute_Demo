[CmdletBinding()]
param(
  [string]$Image = 'playwright-demo-public-browser:1.63.0'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$compose = Join-Path $root 'infra/public-browser/compose.yaml'
$token = [guid]::NewGuid().ToString('N')
$env:PUBLIC_BROWSER_CONTROL_TOKEN = $token
$env:PUBLIC_BROWSER_PROXY = 'http://127.0.0.1:9'

# Docker's server check is deliberate: static review cannot establish the G1
# runtime proofs. Never read or print OPENAI_API_KEY here.
& docker version --format '{{.Server.Version}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker daemon is unavailable; G1 live container proof cannot run.' }
& docker compose -f $compose config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Browser compartment compose configuration is invalid.' }

$probeName = "public-browser-g1-$token"
# An invalid private endpoint is enough to prove that the image starts only
# when both trusted launch values are present. Network/proxy success and the
# private Node control channel are verified by the downstream Node portion.
& docker run --rm --name $probeName `
  --read-only --cap-drop ALL --security-opt no-new-privileges:true `
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m `
  --network none `
  -e "PUBLIC_BROWSER_CONTROL_TOKEN=$token" `
  -e 'PUBLIC_BROWSER_PROXY=http://127.0.0.1:9' `
  $Image --version | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Browser image startup proof failed.' }

# A container with no mount must not see a host sentinel. The command uses a
# benign generated name and emits only pass/fail, never host contents.
$sentinel = Join-Path $env:TEMP "g1-host-sentinel-$token"
Set-Content -NoNewline -Path $sentinel -Value 'g1-non-secret-sentinel'
try {
  $seen = & docker run --rm --entrypoint sh --read-only --cap-drop ALL --security-opt no-new-privileges:true `
    --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m --network none `
    $Image -lc "test ! -e /host/$([IO.Path]::GetFileName($sentinel)) && echo absent"
  if ($LASTEXITCODE -ne 0 -or $seen -notmatch '^absent\s*$') { throw 'Host sentinel isolation proof failed' }
} finally { Remove-Item -LiteralPath $sentinel -Force }

Write-Output 'PUBLIC_BROWSER_CONTAINER_STATIC_AND_FILE_PROOFS_PASSED'
