#!/usr/bin/env bash
set -euo pipefail
plugin_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
dsh_root="$(cd -- "$plugin_root/.." && pwd)"
export DSH_HOME="${DSH_HOME:-$dsh_root/.dsh-home}"

if [[ ! -f "$plugin_root/lib/index.js" || ! -f "$plugin_root/lib/client.js" ]]; then
  printf 'Build the plugin first with bash sre-webshell/Build.sh.\n' >&2
  exit 1
fi
if [[ ! -f "$dsh_root/apps/cli/lib/bin.js" ]]; then
  printf 'Build DeepSeek Harness before starting the SRE profile.\n' >&2
  exit 1
fi
if [[ ! -f "$DSH_HOME/profiles/sre/package.json" ]]; then
  printf 'Install the sre-webshell bundle into the sre profile before starting.\n' >&2
  exit 1
fi
cd -- "$dsh_root"
exec node "$dsh_root/apps/cli/lib/bin.js" --profile sre "$@"
