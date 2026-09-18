$ErrorActionPreference = 'Stop'
$dshRoot = Split-Path -Parent $PSScriptRoot
$node = Join-Path $dshRoot '.runtime/node-v22.23.2-win-x64/node.exe'
$moduleRoot = Join-Path $PSScriptRoot 'node_modules/@deepseek-ai'
New-Item -ItemType Directory -Force -Path $moduleRoot | Out-Null
$dependencyPaths = @{
  'cordis' = 'vendor/cordis'; 'schemastery' = 'vendor/schemastery'
  'dsh-tools' = 'packages/core/tools'; 'dsh-user-approval' = 'packages/interaction/user-approval'
  'dsh-credentials' = 'packages/credentials/credentials'; 'dsh-attachment' = 'packages/attachment/attachment'
  'dsh-llm' = 'packages/llm/llm'; 'dsh-util-values' = 'packages/util/values'
}
foreach ($dependency in $dependencyPaths.GetEnumerator()) {
  $destination = Join-Path $moduleRoot $dependency.Key
  if (-not (Test-Path -LiteralPath $destination)) { New-Item -ItemType Junction -Path $destination -Target (Join-Path $dshRoot $dependency.Value) | Out-Null }
}
$yamlTarget = Join-Path $dshRoot 'node_modules/.pnpm/yaml@2.9.0/node_modules/yaml'
$yamlDestination = Join-Path $PSScriptRoot 'node_modules/yaml'
if (-not (Test-Path -LiteralPath $yamlDestination)) { New-Item -ItemType Junction -Path $yamlDestination -Target $yamlTarget | Out-Null }
& $node (Join-Path $dshRoot 'node_modules/typescript/bin/tsc') '-p' (Join-Path $PSScriptRoot 'tsconfig.json')
if ($LASTEXITCODE -ne 0) { throw 'Plugin build failed.' }
