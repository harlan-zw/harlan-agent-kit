#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
shared_context="$repo_root/agent-context/context.md"
template_claude="$repo_root/agent-context/CLAUDE.md"
template_codex="$repo_root/agent-context/AGENTS.md"
commit_hook="$repo_root/agent-context/git-hooks/commit-msg"
plugin_hooks_dir="$repo_root/harlan-agent-kit/hooks"
opencode_plugin="$repo_root/harlan-agent-kit/plugins/opencode/harlan-hooks.ts"
# The hooks the opencode plugin runs, plus the config loader they source.
opencode_hook_files=(
  check-config.sh
  pnpm-only.sh
  wt-only.sh
  pr-skill-only.sh
  merged-branch-guard.sh
  pre-commit-push.sh
  eslint.sh
)
# The stable path the opencode plugin resolves the hooks from.
hooks_install_suffix='.local/share/harlan-agent-kit/hooks'
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
  local hook_file
  for hook_file in "${opencode_hook_files[@]}"; do
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
  mkdir -p "$target_home/$hooks_install_suffix" "$target_home/$(dirname "$plugin_install_suffix")"
  local hook_file
  for hook_file in "${opencode_hook_files[@]}"; do
    install -m 755 "$plugin_hooks_dir/$hook_file" "$target_home/$hooks_install_suffix/$hook_file"
  done
  install -m 644 "$opencode_plugin" "$target_home/$plugin_install_suffix"
  printf '%s\n' 'Synced local Agent instructions.'
}

# Remote paths the opencode files land on, in the order sha256sum reads them.
opencode_remote_targets() {
  local hook_file
  for hook_file in "${opencode_hook_files[@]}"; do
    printf '%s\n' "$hogwild_home/$hooks_install_suffix/$hook_file"
  done
  printf '%s\n' "$hogwild_home/$plugin_install_suffix"
}

# Local sources in the same order, so the two hash lists line up.
opencode_local_sources() {
  local hook_file
  for hook_file in "${opencode_hook_files[@]}"; do
    printf '%s\n' "$plugin_hooks_dir/$hook_file"
  done
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
    "mkdir -p '$hogwild_home/.claude' '$hogwild_home/.codex' '$hogwild_home/.config/git/hooks' '$hogwild_home/$hooks_install_suffix' '$hogwild_home/$(dirname "$plugin_install_suffix")'"
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
    mode=755
    if [ "$target" = "$hogwild_home/$plugin_install_suffix" ]; then
      mode=644
    fi
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
    fail 'Hogwild received different opencode hook files.'
  fi

  ssh -o BatchMode=yes "$hogwild_host" \
    "chmod 644 '$hogwild_home/.claude/CLAUDE.md.next' '$hogwild_home/.codex/AGENTS.md.next' && mv '$hogwild_home/.claude/CLAUDE.md.next' '$hogwild_home/.claude/CLAUDE.md' && mv '$hogwild_home/.codex/AGENTS.md.next' '$hogwild_home/.codex/AGENTS.md' && chmod 755 '$hogwild_home/.config/git/hooks/commit-msg.next' && mv '$hogwild_home/.config/git/hooks/commit-msg.next' '$hogwild_home/.config/git/hooks/commit-msg'$activation && git config --global core.hooksPath '$hogwild_home/.config/git/hooks'"
  printf '%s\n' 'Synced Hogwild Agent instructions.'
}

require_sources

case "${1:-local}" in
  local)
    sync_local
    ;;
  hogwild)
    sync_hogwild
    ;;
  all)
    sync_local
    sync_hogwild
    ;;
  *)
    fail 'Use local, hogwild, or all.'
    ;;
esac
