#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
shared_context="$repo_root/agent-context/context.md"
template_claude="$repo_root/agent-context/CLAUDE.md"
template_codex="$repo_root/agent-context/AGENTS.md"
commit_hook="$repo_root/agent-context/git-hooks/commit-msg"
plugin_hooks_dir="$repo_root/harlan-agent-kit/hooks"
plugin_manifest="$repo_root/harlan-agent-kit/.claude-plugin/plugin.json"
opencode_plugin="$repo_root/harlan-agent-kit/plugins/opencode/harlan-hooks.ts"
# The manifest registers every hook, so the list below is derived, never typed.
if [ ! -f "$script_dir/agent-context-hooks.sh" ]; then
  printf '%s\n' "The hook list library is missing: $script_dir/agent-context-hooks.sh" >&2
  exit 1
fi
source "$script_dir/agent-context-hooks.sh"
installed_hook_files=()
# The stable paths the opencode plugin resolves the hooks and the manifest from.
hooks_install_suffix='.local/share/harlan-agent-kit/hooks'
manifest_install_suffix='.local/share/harlan-agent-kit/.claude-plugin/plugin.json'
plugin_install_suffix='.config/opencode/plugins/harlan-hooks.ts'
target_home="${HARLAN_AGENT_CONTEXT_HOME:-$HOME}"
hogwild_host="${HARLAN_AGENT_CONTEXT_HOGWILD_HOST:-hogwild}"
hogwild_home="${HARLAN_AGENT_CONTEXT_HOGWILD_HOME:-/home/harlan}"
local_staging=''

cleanup() {
  if [ -n "$local_staging" ] && [ -d "$local_staging" ]; then
    rm -rf "$local_staging"
  fi
}
trap cleanup EXIT

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

require_sources() {
  [ -f "$shared_context" ] || fail "Shared Agent instructions are missing: $shared_context"
  [ -f "$template_claude" ] || fail "Claude template is missing: $template_claude"
  [ -f "$template_codex" ] || fail "Codex template is missing: $template_codex"
  [ -f "$commit_hook" ] || fail "The commit-msg hook is missing: $commit_hook"
  [ -f "$opencode_plugin" ] || fail "The opencode plugin is missing: $opencode_plugin"
  [ -f "$plugin_manifest" ] || fail "The plugin manifest is missing: $plugin_manifest"
  mapfile -t installed_hook_files < <(agent_context_installed_hooks "$plugin_hooks_dir" "$plugin_manifest")
  [ "${#installed_hook_files[@]}" -gt 0 ] || fail "The plugin manifest registers no hooks: $plugin_manifest"
  local hook_file
  for hook_file in "${installed_hook_files[@]}"; do
    [ -f "$plugin_hooks_dir/$hook_file" ] || fail "A plugin hook is missing: $plugin_hooks_dir/$hook_file"
  done
}

render_template() {
  local template=$1
  local output=$2
  local tag_count
  tag_count=$(grep -Fxc '{{> context.md}}' "$template" || true)
  [ "$tag_count" -eq 1 ] || fail "The template needs one {{> context.md}} tag: $template"
  awk -v shared="$shared_context" '
    $0 == "{{> context.md}}" {
      while ((getline line < shared) > 0) print line
      close(shared)
      next
    }
    { print }
  ' "$template" > "$output"
}

render_sources() {
  local staging=$1
  render_template "$template_claude" "$staging/CLAUDE.md"
  render_template "$template_codex" "$staging/AGENTS.md"
}

validate_local_home() {
  [[ "$target_home" == /* ]] || fail 'The local home path must be absolute.'
}

validate_hogwild() {
  [[ "$hogwild_host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || fail 'The Hogwild host name contains unsupported characters.'
  [[ "$hogwild_home" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail 'The Hogwild home path contains unsupported characters.'
}

sync_local() {
  validate_local_home
  mkdir -p "$target_home/.claude" "$target_home/.codex"
  local_staging=$(mktemp -d "$target_home/.agent-context.XXXXXX")
  render_sources "$local_staging"
  chmod 644 "$local_staging/CLAUDE.md" "$local_staging/AGENTS.md"
  mv "$local_staging/CLAUDE.md" "$target_home/.claude/CLAUDE.md"
  mv "$local_staging/AGENTS.md" "$target_home/.codex/AGENTS.md"
  rmdir "$local_staging"
  local_staging=''
  mkdir -p "$target_home/.config/git/hooks"
  install -m 755 "$commit_hook" "$target_home/.config/git/hooks/commit-msg"
  # A repository with its own hook manager sets core.hooksPath locally, and that
  # local value wins. This only reaches repositories that set none.
  # HOME decides which global config git writes. The check script points
  # target_home at a sandbox, and this keeps that run out of the real config.
  HOME="$target_home" git config --global core.hooksPath "$target_home/.config/git/hooks"
  # opencode loads no Claude Code plugin, so it reads the same hooks from here.
  # The manifest travels with them, because the opencode plugin reads its hook
  # list, its order, and its timeouts from the manifest at runtime.
  mkdir -p "$target_home/$hooks_install_suffix" \
    "$target_home/$(dirname "$manifest_install_suffix")" \
    "$target_home/$(dirname "$plugin_install_suffix")"
  local hook_file
  for hook_file in "${installed_hook_files[@]}"; do
    install -m 755 "$plugin_hooks_dir/$hook_file" "$target_home/$hooks_install_suffix/$hook_file"
  done
  install -m 644 "$plugin_manifest" "$target_home/$manifest_install_suffix"
  install -m 644 "$opencode_plugin" "$target_home/$plugin_install_suffix"
  printf '%s\n' 'Synced local Agent instructions.'
}

# Remote paths the hook files land on, in the order sha256sum reads them.
opencode_remote_targets() {
  local hook_file
  for hook_file in "${installed_hook_files[@]}"; do
    printf '%s\n' "$hogwild_home/$hooks_install_suffix/$hook_file"
  done
  printf '%s\n' "$hogwild_home/$manifest_install_suffix"
  printf '%s\n' "$hogwild_home/$plugin_install_suffix"
}

# Local sources in the same order, so the two hash lists line up.
opencode_local_sources() {
  local hook_file
  for hook_file in "${installed_hook_files[@]}"; do
    printf '%s\n' "$plugin_hooks_dir/$hook_file"
  done
  printf '%s\n' "$plugin_manifest"
  printf '%s\n' "$opencode_plugin"
}

cleanup_hogwild() {
  local staged target
  staged=''
  while read -r target; do
    staged="$staged '$target.next'"
  done < <(opencode_remote_targets)
  ssh -o BatchMode=yes "$hogwild_host" \
    "rm -f '$hogwild_home/.claude/CLAUDE.md.next' '$hogwild_home/.codex/AGENTS.md.next' '$hogwild_home/.config/git/hooks/commit-msg.next'$staged" \
    >/dev/null 2>&1 || true
}

sync_hogwild() {
  local claude_hash codex_hash hook_hash remote_claude_hash remote_codex_hash remote_hook_hash
  local source target mode staged_list activation opencode_hashes remote_opencode_hashes
  validate_hogwild
  local_staging=$(mktemp -d "${TMPDIR:-/tmp}/agent-context.XXXXXX")
  render_sources "$local_staging"
  claude_hash=$(sha256sum "$local_staging/CLAUDE.md" | cut -d' ' -f1)
  codex_hash=$(sha256sum "$local_staging/AGENTS.md" | cut -d' ' -f1)
  hook_hash=$(sha256sum "$commit_hook" | cut -d' ' -f1)

  ssh -o BatchMode=yes "$hogwild_host" \
    "mkdir -p '$hogwild_home/.claude' '$hogwild_home/.codex' '$hogwild_home/.config/git/hooks' '$hogwild_home/$hooks_install_suffix' '$hogwild_home/$(dirname "$manifest_install_suffix")' '$hogwild_home/$(dirname "$plugin_install_suffix")'"
  if ! scp "$local_staging/CLAUDE.md" "$hogwild_host:$hogwild_home/.claude/CLAUDE.md.next"; then
    cleanup_hogwild
    fail 'Hogwild did not receive Claude instructions.'
  fi
  if ! scp "$local_staging/AGENTS.md" "$hogwild_host:$hogwild_home/.codex/AGENTS.md.next"; then
    cleanup_hogwild
    fail 'Hogwild did not receive Codex instructions.'
  fi
  if ! scp "$commit_hook" "$hogwild_host:$hogwild_home/.config/git/hooks/commit-msg.next"; then
    cleanup_hogwild
    fail 'Hogwild did not receive the commit-msg hook.'
  fi

  staged_list=''
  activation=''
  while read -r source && read -r target <&3; do
    if ! scp "$source" "$hogwild_host:$target.next"; then
      cleanup_hogwild
      fail "Hogwild did not receive $(basename "$source")."
    fi
    case "$target" in
      "$hogwild_home/$manifest_install_suffix" | "$hogwild_home/$plugin_install_suffix") mode=644 ;;
      *) mode=755 ;;
    esac
    staged_list="$staged_list '$target.next'"
    activation="$activation && chmod $mode '$target.next' && mv '$target.next' '$target'"
  done < <(opencode_local_sources) 3< <(opencode_remote_targets)

  opencode_hashes=$(while read -r source; do
    sha256sum "$source" | cut -d' ' -f1
  done < <(opencode_local_sources))
  remote_opencode_hashes=$(ssh -o BatchMode=yes "$hogwild_host" "sha256sum$staged_list" | cut -d' ' -f1)

  remote_claude_hash=$(ssh -o BatchMode=yes "$hogwild_host" \
    "sha256sum '$hogwild_home/.claude/CLAUDE.md.next'" | cut -d' ' -f1)
  remote_codex_hash=$(ssh -o BatchMode=yes "$hogwild_host" \
    "sha256sum '$hogwild_home/.codex/AGENTS.md.next'" | cut -d' ' -f1)
  remote_hook_hash=$(ssh -o BatchMode=yes "$hogwild_host" \
    "sha256sum '$hogwild_home/.config/git/hooks/commit-msg.next'" | cut -d' ' -f1)
  if [ "$claude_hash" != "$remote_claude_hash" ] || [ "$codex_hash" != "$remote_codex_hash" ] \
    || [ "$hook_hash" != "$remote_hook_hash" ]; then
    cleanup_hogwild
    fail 'Hogwild received different Agent instructions.'
  fi
  if [ "$opencode_hashes" != "$remote_opencode_hashes" ]; then
    cleanup_hogwild
    fail 'Hogwild received different hook files.'
  fi

  ssh -o BatchMode=yes "$hogwild_host" \
    "chmod 644 '$hogwild_home/.claude/CLAUDE.md.next' '$hogwild_home/.codex/AGENTS.md.next' && mv '$hogwild_home/.claude/CLAUDE.md.next' '$hogwild_home/.claude/CLAUDE.md' && mv '$hogwild_home/.codex/AGENTS.md.next' '$hogwild_home/.codex/AGENTS.md' && chmod 755 '$hogwild_home/.config/git/hooks/commit-msg.next' && mv '$hogwild_home/.config/git/hooks/commit-msg.next' '$hogwild_home/.config/git/hooks/commit-msg'$activation && git config --global core.hooksPath '$hogwild_home/.config/git/hooks'"
  printf '%s\n' 'Synced Hogwild Agent instructions.'
}

# ---------------------------------------------------------------------------
# Project memory
#
# Harlan's desktop records per-repository memory under ~/.claude/projects. A
# worker on Hogwild starts cold without it. This section copies it out.
#
# One direction only. The desktop owns memory. Workers read it and never write
# it back, and nothing here ever copies from Hogwild to the desktop.
#
# Integrity: every single file above is verified by sha256 before its mv. A
# directory sync cannot do that per file. rsync checks a digest of each file it
# transfers and retries a mismatch, so a transferred file is whole or the run
# fails. The tar fallback relies on tar's own exit status. Neither is atomic, so
# a worker reading memory mid-sync can see a partly updated tree. Memory is
# reference material a turn checks against the code, so a stale or missing note
# costs context and never correctness.
# ---------------------------------------------------------------------------
memory_root="${HARLAN_AGENT_CONTEXT_MEMORY_ROOT:-$HOME/.claude/projects}"
memory_checkout_roots="${HARLAN_AGENT_CONTEXT_CHECKOUT_ROOTS:-$HOME/pkg:$HOME/sites}"

# Claude Code names a project directory after the checkout path. Every
# character outside a-z, A-Z and 0-9 becomes one hyphen.
project_slug() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9' '-'
}

# Prints the slug of every primary checkout that has memory, one per line.
# A wt worktree carries a .git file, not a directory, so it never matches. A
# project directory with no matching checkout is never copied.
memory_slugs() {
  local root checkout slug
  [ -d "$memory_root" ] || return 0
  while IFS= read -r root; do
    [ -n "$root" ] && [ -d "$root" ] || continue
    for checkout in "$root"/*; do
      [ -d "$checkout/.git" ] || continue
      slug=$(project_slug "$checkout")
      [ -d "$memory_root/$slug/memory" ] || continue
      printf '%s\n' "$slug"
    done
  done < <(printf '%s\n' "$memory_checkout_roots" | tr ':' '\n')
}

memory_enabled() {
  [ "${HARLAN_AGENT_CONTEXT_SKIP_MEMORY:-0}" != 1 ]
}

# Mirrors one memory directory onto a local path.
copy_memory_tree() {
  local source=$1 destination=$2
  mkdir -p "$destination"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$source/" "$destination/"
    return
  fi
  # tar has no delete, so the destination starts empty. Every slug matches
  # [A-Za-z0-9-], so the path this removes is always inside the memory tree.
  rm -rf "${destination:?}"
  mkdir -p "$destination"
  tar -C "$source" -cf - . | tar -C "$destination" -xf -
}

sync_local_memory() {
  local destination_root slug count
  memory_enabled || return 0
  validate_local_home
  destination_root="$target_home/.claude/projects"
  if [ "$memory_root" = "$destination_root" ]; then
    printf '%s\n' 'Local project memory is already the source. Nothing to copy.'
    return 0
  fi
  count=0
  while IFS= read -r slug; do
    mkdir -p "$destination_root/$slug"
    copy_memory_tree "$memory_root/$slug/memory" "$destination_root/$slug/memory"
    count=$((count + 1))
  done < <(memory_slugs)
  printf 'Synced project memory for %s repositories.\n' "$count"
}

sync_hogwild_memory() {
  local slug source remote count remote_rsync
  memory_enabled || return 0
  validate_hogwild
  count=0
  remote_rsync=''
  if command -v rsync >/dev/null 2>&1; then
    remote_rsync=$(ssh -n -o BatchMode=yes "$hogwild_host" 'command -v rsync' 2>/dev/null || true)
  fi

  # Every ssh below runs with -n. Without it the first one reads the rest of
  # the slug list from stdin, and the loop copies exactly one repository.
  while IFS= read -r slug; do
    source="$memory_root/$slug/memory"
    remote="$hogwild_home/.claude/projects/$slug/memory"
    if [ -n "$remote_rsync" ]; then
      ssh -n -o BatchMode=yes "$hogwild_host" "mkdir -p '$remote'" \
        || fail "Hogwild did not accept the memory directory for $slug."
      rsync -a --delete -e 'ssh -o BatchMode=yes' "$source/" "$hogwild_host:$remote/" \
        || fail "Hogwild did not receive the project memory for $slug."
    else
      # tar has no delete, so the remote directory starts empty. Every slug
      # matches [A-Za-z0-9-], so this removes a path inside the memory tree.
      ssh -n -o BatchMode=yes "$hogwild_host" "rm -rf '$remote' && mkdir -p '$remote'" \
        || fail "Hogwild did not accept the memory directory for $slug."
      tar -C "$source" -czf - . | ssh -o BatchMode=yes "$hogwild_host" "tar -C '$remote' -xzf -" \
        || fail "Hogwild did not receive the project memory for $slug."
    fi
    count=$((count + 1))
  done < <(memory_slugs)
  printf 'Synced project memory for %s repositories to Hogwild.\n' "$count"
}

require_sources

case "${1:-local}" in
  local)
    sync_local
    sync_local_memory
    ;;
  hogwild)
    sync_hogwild
    sync_hogwild_memory
    ;;
  all)
    sync_local
    sync_local_memory
    sync_hogwild
    sync_hogwild_memory
    ;;
  *)
    fail 'Use local, hogwild, or all.'
    ;;
esac
