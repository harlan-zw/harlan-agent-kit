#!/usr/bin/env bash
# Derives the hook file list from the plugin manifest.
#
# `harlan-agent-kit/.claude-plugin/plugin.json` registers every hook. Claude
# Code reads it directly. The sync script, the drift check, and the opencode
# plugin derive their lists from it, so adding a hook there is the only edit.
#
# Source this file, then call the functions below.

# Prints every hook file the manifest registers, in manifest order, once each.
agent_context_manifest_hooks() {
  local manifest=$1
  jq -r '.hooks | to_entries[] | .value[] | .hooks[] | .command' "$manifest" \
    | sed 's#.*/##' \
    | awk 'NF && !seen[$0]++'
}

# Prints every sibling file the hooks source.
#
# The manifest never lists these, because they are not hooks. `check-config.sh`
# is the only one today, and every hook sources it.
agent_context_support_files() {
  local hooks_dir=$1 manifest=$2 hook_file
  while IFS= read -r hook_file; do
    [ -f "$hooks_dir/$hook_file" ] || continue
    sed -nE 's#^[[:space:]]*(source|\.)[[:space:]]+"?\$\(dirname "\$0"\)/([A-Za-z0-9._-]+)"?.*#\2#p' \
      "$hooks_dir/$hook_file"
  done < <(agent_context_manifest_hooks "$manifest") | awk 'NF && !seen[$0]++'
}

# Prints every file the install places in the hooks directory.
#
# Sourced files come first, so a partial install never leaves a hook without
# its loader.
agent_context_installed_hooks() {
  local hooks_dir=$1 manifest=$2
  agent_context_support_files "$hooks_dir" "$manifest"
  agent_context_manifest_hooks "$manifest"
}
