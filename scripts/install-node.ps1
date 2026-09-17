\xef\xbb\xbf# install-node.ps1 — download portable Node.js LTS if system node is missing
# ASCII-safe. Extract to tools\node so no admin install is required.
param(
  [string]$ToolRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$nodeDir = Join-Path $ToolRoot 'tools\node'
$nodeExe = Join-Path $nodeDir 'node.exe'

if (Test-Path $nodeExe) {
  Write-Output "portable-node already at $nodeExe"
  exit 0
}

# resolve latest LTS win-x64 zip from nodejs.org
Write-Output 'query nodejs.org for latest LTS...'
$idx = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 30
$lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
if (-not $lts) { throw 'cannot resolve LTS version from nodejs.org' }
$ver = $lts.version  # e.g. v22.14.0
$zipName = "node-$ver-win-x64.zip"
$url = "https://nodejs.org/dist/$ver/$zipName"
$tmpZip = Join-Path $env:TEMP $zipName

Write-Output "download $url"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -Uri $url -OutFile $tmpZip -TimeoutSec 600

Write-Output "extract to $nodeDir"
if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }
New-Item -ItemType Directory -Path $nodeDir -Force | Out-Null
Expand-Archive -Path $tmpZip -DestinationPath $ToolRoot\tools -Force

# zip contains node-vX-win-x64\ -> rename to tools\node
$extracted = Join-Path $ToolRoot "tools\node-$ver-win-x64"
if (Test-Path $extracted) {
  Move-Item $extracted $nodeDir -Force
}
Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue

if (-not (Test-Path $nodeExe)) {
  throw "node.exe not found after extract: $nodeExe"
}
& $nodeExe -v
Write-Output "portable node ready: $nodeExe"
