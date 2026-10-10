$ErrorActionPreference = 'Stop'
$dshRoot = Split-Path -Parent $PSScriptRoot
$node = Join-Path $dshRoot '.runtime/node-v22.23.2-win-x64/node.exe'
$moduleRoot = Join-Path $PSScriptRoot 'node_modules/@deepseek-ai'
New-Item -ItemType Directory -Force -Path $moduleRoot | Out-Null
$dependencyPaths = @{
  'cordis' = 'vendor/cordis'; 'schemastery' = 'vendor/schemastery'
  'dsh-tools' = 'packages/core/tools'; 'dsh-user-approval' = 'packages/interaction/user-approval'
  'dsh-user-questions' = 'packages/interaction/user-questions'
  'dsh-brand' = 'packages/util/brand'
  'dsh-credentials' = 'packages/credentials/credentials'; 'dsh-attachment' = 'packages/attachment/attachment'
  'dsh-llm' = 'packages/llm/llm'; 'dsh-util-values' = 'packages/util/values'
  'dsh-settings' = 'packages/settings/settings'; 'dsh-api-remotes' = 'packages/api/remotes'
  'dsh-client-locale' = 'packages/client/locale'; 'dsh-client-ui-settings' = 'packages/client/ui-settings'
  'dsh-client-ui-plugin-manager' = 'packages/client/ui-plugin-manager'
  'dsh-client-ui-renderer' = 'packages/client/ui-renderer'; 'dsh-client-ui-slots' = 'packages/client/ui-slots'
}
foreach ($dependency in $dependencyPaths.GetEnumerator()) {
  $destination = Join-Path $moduleRoot $dependency.Key
  if (-not (Test-Path -LiteralPath $destination)) { New-Item -ItemType Junction -Path $destination -Target (Join-Path $dshRoot $dependency.Value) | Out-Null }
}
$yamlTarget = Join-Path $dshRoot 'node_modules/.pnpm/yaml@2.9.0/node_modules/yaml'
$yamlDestination = Join-Path $PSScriptRoot 'node_modules/yaml'
if (-not (Test-Path -LiteralPath $yamlDestination)) { New-Item -ItemType Junction -Path $yamlDestination -Target $yamlTarget | Out-Null }
$playwrightTarget = Join-Path $dshRoot 'node_modules/.pnpm/playwright@1.61.1/node_modules/playwright'
$playwrightDestination = Join-Path $PSScriptRoot 'node_modules/playwright'
if (-not (Test-Path -LiteralPath $playwrightDestination)) { New-Item -ItemType Junction -Path $playwrightDestination -Target $playwrightTarget | Out-Null }
$reactModules = Join-Path $dshRoot 'packages/client/ui-settings-plugins/node_modules'
$reactDestination = Join-Path $PSScriptRoot 'node_modules/react'
if (-not (Test-Path -LiteralPath $reactDestination)) { New-Item -ItemType Junction -Path $reactDestination -Target (Join-Path $reactModules 'react') | Out-Null }
$typesRoot = Join-Path $PSScriptRoot 'node_modules/@types'
New-Item -ItemType Directory -Force -Path $typesRoot | Out-Null
$reactTypes = Join-Path $typesRoot 'react'
if (-not (Test-Path -LiteralPath $reactTypes)) { New-Item -ItemType Junction -Path $reactTypes -Target (Join-Path $reactModules '@types/react') | Out-Null }
& $node (Join-Path $dshRoot 'node_modules/typescript/bin/tsc') '-p' (Join-Path $PSScriptRoot 'tsconfig.json')
if ($LASTEXITCODE -ne 0) { throw 'Plugin build failed.' }
Push-Location -LiteralPath $PSScriptRoot
try {
  & $node (Join-Path $dshRoot 'node_modules/tsdown/dist/run.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Plugin client bundle build failed.' }
} finally { Pop-Location }
