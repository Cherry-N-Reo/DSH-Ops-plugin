#!/usr/bin/env bash
set -euo pipefail
plugin_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
dsh_root="$(cd -- "$plugin_root/.." && pwd)"
module_root="$plugin_root/node_modules/@deepseek-ai"
mkdir -p "$module_root"

link_dependency() {
  local name="$1" target="$2"
  if [[ ! -e "$module_root/$name" ]]; then ln -s "$dsh_root/$target" "$module_root/$name"; fi
}
link_dependency cordis vendor/cordis
link_dependency schemastery vendor/schemastery
link_dependency dsh-tools packages/core/tools
link_dependency dsh-user-approval packages/interaction/user-approval
link_dependency dsh-user-questions packages/interaction/user-questions
link_dependency dsh-brand packages/util/brand
link_dependency dsh-credentials packages/credentials/credentials
link_dependency dsh-attachment packages/attachment/attachment
link_dependency dsh-llm packages/llm/llm
link_dependency dsh-util-values packages/util/values
link_dependency dsh-settings packages/settings/settings
link_dependency dsh-api-remotes packages/api/remotes
link_dependency dsh-client-locale packages/client/locale
link_dependency dsh-client-ui-settings packages/client/ui-settings
link_dependency dsh-client-ui-plugin-manager packages/client/ui-plugin-manager
link_dependency dsh-client-ui-renderer packages/client/ui-renderer
link_dependency dsh-client-ui-slots packages/client/ui-slots
if [[ ! -e "$plugin_root/node_modules/react" ]]; then ln -s "$dsh_root/packages/client/ui-settings-plugins/node_modules/react" "$plugin_root/node_modules/react"; fi
mkdir -p "$plugin_root/node_modules/@types"
if [[ ! -e "$plugin_root/node_modules/@types/react" ]]; then ln -s "$dsh_root/packages/client/ui-settings-plugins/node_modules/@types/react" "$plugin_root/node_modules/@types/react"; fi

if [[ ! -e "$plugin_root/node_modules/yaml" ]]; then
  ln -s "$dsh_root/node_modules/.pnpm/yaml@2.9.0/node_modules/yaml" "$plugin_root/node_modules/yaml"
fi
if [[ ! -e "$plugin_root/node_modules/playwright" ]]; then
  ln -s "$dsh_root/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright" "$plugin_root/node_modules/playwright"
fi
node "$dsh_root/node_modules/typescript/bin/tsc" -p "$plugin_root/tsconfig.json"
(cd "$plugin_root" && node "$dsh_root/node_modules/tsdown/dist/run.mjs")
