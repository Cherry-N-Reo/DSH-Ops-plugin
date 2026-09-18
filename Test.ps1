$ErrorActionPreference = 'Stop'
$dshRoot = Split-Path -Parent $PSScriptRoot
$node = Join-Path $dshRoot '.runtime/node-v22.23.2-win-x64/node.exe'
$tests = @(Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'tests') -Filter '*.test.ts' | ForEach-Object FullName)
Push-Location -LiteralPath $dshRoot
try {
  & $node '--import' './node_modules/tsx/dist/loader.mjs' '--test' @tests
  if ($LASTEXITCODE -ne 0) { throw 'Plugin acceptance tests failed.' }
} finally { Pop-Location }
