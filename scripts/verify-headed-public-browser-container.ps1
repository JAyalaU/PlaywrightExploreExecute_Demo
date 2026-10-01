[CmdletBinding()]
param(
  [string]$Image = 'playwright-demo-public-browser-headed:1.63.0-p4-3a'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
$previous = $env:P4_3A_CONTAINER_RUNTIME
try {
  & docker build --file .\infra\public-browser\Dockerfile.headed --tag $Image .\infra\public-browser
  if ($LASTEXITCODE -ne 0) { throw 'Headed browser image build failed.' }
  $env:P4_3A_CONTAINER_RUNTIME = '1'
  & npx.cmd playwright test tests/public-browser-headed-runtime-p4-3a.spec.ts --workers=1
  if ($LASTEXITCODE -ne 0) { throw 'Headed browser runtime proof failed.' }
  $remaining = & docker ps -a --filter 'name=public-browser-headed-p4-3a-' --format '{{.Names}} {{.Status}}'
  if ($LASTEXITCODE -ne 0) { throw 'Could not verify headed container disposal.' }
  if ($remaining) { throw 'A P4-3A headed browser container remains after the proof.' }
  Write-Output 'P4_3A_HEADED_CONTAINER_AND_RFB_PROOFS_PASSED'
} finally {
  if ($null -eq $previous) { Remove-Item Env:P4_3A_CONTAINER_RUNTIME -ErrorAction SilentlyContinue }
  else { $env:P4_3A_CONTAINER_RUNTIME = $previous }
  Pop-Location
}
