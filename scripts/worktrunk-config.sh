#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
config_source="$script_dir/worktrunk.toml"
helper_source="$script_dir/repository-env.sh"
manifest_source="$script_dir/repository-env-files"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

install_asset() {
  local source=$1
  local target=$2
  local mode=$3
  local next
  next="$target.next.$$"
  mkdir -p "$(dirname "$target")"
  install -m "$mode" -- "$source" "$next"
  mv -fT -- "$next" "$target"
}

[ "${1:-}" = update ] || fail "Use update."
[ -f "$config_source" ] || fail "The Worktrunk configuration source does not exist: $config_source"
[ -f "$helper_source" ] || fail "The repository environment helper does not exist: $helper_source"
[ -f "$manifest_source" ] || fail "The repository environment manifest does not exist: $manifest_source"
command -v wt >/dev/null 2>&1 || fail "Worktrunk is not installed."
wt -C "$script_dir/.." --config "$config_source" config show >/dev/null

install_asset "$helper_source" "$HOME/.local/bin/harlan-repository-env" 755
install_asset "$manifest_source" "$HOME/.config/harlan-agent-kit/repository-env-files" 644
install_asset "$config_source" "$HOME/.config/worktrunk/config.toml" 644

printf '%s\n' 'Worktrunk configuration updated.'
