#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
shared_context="$repo_root/agent-context/context.md"
template_claude="$repo_root/agent-context/CLAUDE.md"
template_codex="$repo_root/agent-context/AGENTS.md"
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
  printf '%s\n' 'Synced local Agent instructions.'
}

cleanup_hogwild() {
  ssh -o BatchMode=yes "$hogwild_host" \
    "rm -f '$hogwild_home/.claude/CLAUDE.md.next' '$hogwild_home/.codex/AGENTS.md.next'" \
    >/dev/null 2>&1 || true
}

sync_hogwild() {
  local claude_hash codex_hash remote_claude_hash remote_codex_hash
  validate_hogwild
  local_staging=$(mktemp -d "${TMPDIR:-/tmp}/agent-context.XXXXXX")
  render_sources "$local_staging"
  claude_hash=$(sha256sum "$local_staging/CLAUDE.md" | cut -d' ' -f1)
  codex_hash=$(sha256sum "$local_staging/AGENTS.md" | cut -d' ' -f1)

  ssh -o BatchMode=yes "$hogwild_host" \
    "mkdir -p '$hogwild_home/.claude' '$hogwild_home/.codex'"
  if ! scp "$local_staging/CLAUDE.md" "$hogwild_host:$hogwild_home/.claude/CLAUDE.md.next"; then
    cleanup_hogwild
    fail 'Hogwild did not receive Claude instructions.'
  fi
  if ! scp "$local_staging/AGENTS.md" "$hogwild_host:$hogwild_home/.codex/AGENTS.md.next"; then
    cleanup_hogwild
    fail 'Hogwild did not receive Codex instructions.'
  fi

  remote_claude_hash=$(ssh -o BatchMode=yes "$hogwild_host" \
    "sha256sum '$hogwild_home/.claude/CLAUDE.md.next'" | cut -d' ' -f1)
  remote_codex_hash=$(ssh -o BatchMode=yes "$hogwild_host" \
    "sha256sum '$hogwild_home/.codex/AGENTS.md.next'" | cut -d' ' -f1)
  if [ "$claude_hash" != "$remote_claude_hash" ] || [ "$codex_hash" != "$remote_codex_hash" ]; then
    cleanup_hogwild
    fail 'Hogwild received different Agent instructions.'
  fi

  ssh -o BatchMode=yes "$hogwild_host" \
    "chmod 644 '$hogwild_home/.claude/CLAUDE.md.next' '$hogwild_home/.codex/AGENTS.md.next' && mv '$hogwild_home/.claude/CLAUDE.md.next' '$hogwild_home/.claude/CLAUDE.md' && mv '$hogwild_home/.codex/AGENTS.md.next' '$hogwild_home/.codex/AGENTS.md'"
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
