param(
  [string]$SourceRoot = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.runtime/desktop-migration/source'),
  [string]$Destination = (Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.runtime/desktop-migration/plugin')
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $SourceRoot).Path
$pluginRoot = Split-Path -Parent $PSScriptRoot
$destinationPath = [System.IO.Path]::GetFullPath($Destination)
if ($destinationPath -eq $source -or $destinationPath -eq $pluginRoot) { throw 'Build output must be separate from source.' }
New-Item -ItemType Directory -Force -Path $destinationPath | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $destinationPath 'src/client') | Out-Null
Get-ChildItem -LiteralPath (Join-Path $pluginRoot 'src') -File -Filter '*.ts' | Copy-Item -Destination (Join-Path $destinationPath 'src') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'client.tsx') -Destination (Join-Path $destinationPath 'src/client/index.tsx') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'client-browser.ts') -Destination (Join-Path $destinationPath 'src/client/client-browser.ts') -Force
foreach ($file in 'package.json','cordis.patch.yml') { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $destinationPath -Force }
foreach ($file in 'README.md','README.zh.md','DESKTOP.md','DESKTOP.zh.md','ACCEPTANCE.md') { Copy-Item -LiteralPath (Join-Path $pluginRoot $file) -Destination $destinationPath -Force }
Copy-Item -LiteralPath (Join-Path $pluginRoot 'tsconfig.json') -Destination $destinationPath -Force
Copy-Item -LiteralPath (Join-Path $pluginRoot 'tsdown.config.ts') -Destination $destinationPath -Force
$moduleRoot = Join-Path $destinationPath 'node_modules/@deepseek-ai'
New-Item -ItemType Directory -Force -Path $moduleRoot | Out-Null
$paths = @{
  'cordis'='vendor/cordis'; 'schemastery'='vendor/schemastery'; 'dsh-tools'='packages/core/tools'
  'dsh-user-approval'='packages/interaction/user-approval'; 'dsh-user-questions'='packages/interaction/user-questions'
  'dsh-credentials'='packages/credentials/credentials'; 'dsh-attachment'='packages/attachment/attachment'
  'dsh-llm'='packages/llm/llm'; 'dsh-util-values'='packages/util/values'; 'dsh-settings'='packages/settings/settings'
  'dsh-api-remotes'='packages/api/remotes'; 'dsh-client-locale'='packages/client/locale'
  'dsh-client-ui-plugin-manager'='packages/client/ui-plugin-manager'; 'dsh-client-ui-slots'='packages/client/ui-slots'
  'dsh-client-ui-renderer'='packages/client/ui-renderer'
  'dsh-brand'='packages/util/brand'
  'dsh-client-connection'='packages/client/connection'; 'dsh-client-ui-sidebar-right'='packages/client/ui-sidebar-right'
  'dsh-client-ui-sidebar-browser'='packages/client/ui-sidebar-browser'
}
foreach ($entry in $paths.GetEnumerator()) {
  $link = Join-Path $moduleRoot $entry.Key
  if (-not (Test-Path -LiteralPath $link)) { New-Item -ItemType Junction -Path $link -Target (Join-Path $source $entry.Value) | Out-Null }
}
foreach ($entry in @{ yaml='node_modules/.pnpm/yaml@2.9.0/node_modules/yaml'; playwright='node_modules/.pnpm/playwright@1.61.1/node_modules/playwright'; react='packages/client/ui-settings/node_modules/react'; '@types'='packages/client/ui-settings/node_modules/@types' }.GetEnumerator()) {
  $link = Join-Path $destinationPath ('node_modules/' + $entry.Key)
  if (-not (Test-Path -LiteralPath $link)) { New-Item -ItemType Junction -Path $link -Target (Join-Path $source $entry.Value) | Out-Null }
}
$node = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) '.runtime/node-v22.23.2-win-x64/node.exe'
& $node (Join-Path $source 'node_modules/typescript/bin/tsc') '-p' (Join-Path $destinationPath 'tsconfig.json')
if ($LASTEXITCODE -ne 0) { throw 'Desktop plugin TypeScript build failed.' }
Push-Location -LiteralPath $destinationPath
try {
  & $node (Join-Path $source 'node_modules/tsdown/dist/run.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Desktop plugin Client bundle build failed.' }
} finally { Pop-Location }
Write-Output "Desktop plugin built at $destinationPath (no credentials or runtime data copied)."
