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

# Marks a ~/.codex/hooks.json this sync owns. A file without it belongs to someone else.
agent_context_codex_hooks_marker='Managed by Harlan Agent Kit sync.'

# Renders the Codex hook file for one home.
#
# Codex trusts plugin hooks against a hash of the whole plugin, so every kit
# change would switch them off until a person reviews them again. User hooks
# are trusted against their definition only. This file points each definition
# at the scripts sync installs, so a script update keeps its trust.
agent_context_render_codex_hooks() {
  local source=$1 hooks_dir=$2 output=$3
  jq --arg dir "$hooks_dir" --arg marker "$agent_context_codex_hooks_marker" '
    .description = "\($marker) Edit harlan-agent-kit/hooks/codex.json in Harlan Agent Kit instead."
    | walk(if type == "object" and has("command") then .command |= (split("${CLAUDE_PLUGIN_ROOT}/hooks") | join($dir)) else . end)
  ' "$source" > "$output"
}

# Succeeds when the path is absent or holds a Codex hook file this sync wrote.
agent_context_codex_hooks_owned() {
  local path=$1
  [ ! -e "$path" ] || jq -e --arg marker "$agent_context_codex_hooks_marker" '(.description // "") | startswith($marker)' "$path" >/dev/null 2>&1
}

# Renders Antigravity's skills.json so personal, skilld, and shared skills load without duplicates.
agent_context_render_antigravity_skills() {
  local manifest=$1 skills_checkout=$2 home=$3 output=$4
  jq -n \
    --arg kit_skills "$skills_checkout/harlan-agent-kit/skills" \
    --arg skilld_skills "$home/.local/share/harlan-agent-kit/skilld/skills" \
    --arg agents_skills "$home/.agents/skills" \
    --slurpfile manifest "$manifest" '
    {
      entries: [
        { path: $kit_skills },
        { path: $skilld_skills },
        {
          path: $agents_skills,
          exclude: (($manifest[0].skills // {}) | keys | sort)
        }
      ]
    }
  ' > "$output"
}

# Renders Antigravity's plugins.json for T3 Code provider directories.
agent_context_render_antigravity_plugins() {
  local plugins_dir=$1 output=$2
  jq -n --arg path "$plugins_dir" '
    {
      entries: [
        {
          path: $path,
          include_only: ["harlan-agent-kit"]
        }
      ]
    }
  ' > "$output"
}
