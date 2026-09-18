param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$dshRoot = Split-Path -Parent $PSScriptRoot
$nodeRoot = Join-Path $dshRoot '.runtime/node-v22.23.2-win-x64'
if (-not (Test-Path -LiteralPath (Join-Path $nodeRoot 'node.exe'))) { throw 'Portable Node 22 runtime is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'lib/index.js'))) { throw 'Build the plugin first with Build.ps1.' }
$cli = Join-Path $dshRoot 'apps/cli/lib/bin.js'
if (-not (Test-Path -LiteralPath $cli)) { throw 'Built DSH CLI is missing. Build DSH before starting this profile.' }
$env:Path = "$nodeRoot;$env:Path"
$env:COREPACK_HOME = Join-Path $dshRoot '.runtime/corepack'
$env:DSH_HOME = Join-Path $dshRoot '.dsh-home'
Push-Location -LiteralPath $dshRoot
try {
  # The external plugin uses built dependencies; the CLI must share that module plane.
  $launchArgs = @($cli, '--profile', 'sre')
  if (-not (Test-Path -LiteralPath (Join-Path $env:DSH_HOME 'profiles/sre/package.json'))) { $launchArgs += @('--from-default-profile', 'web', '--patch', (Join-Path $PSScriptRoot 'local.patch.yml')) }
  if ($NoOpen) { $launchArgs += '--no-open' }
  & (Join-Path $nodeRoot 'node.exe') @launchArgs
  if ($LASTEXITCODE -ne 0) { throw "DSH exited with code $LASTEXITCODE." }
} finally { Pop-Location }
