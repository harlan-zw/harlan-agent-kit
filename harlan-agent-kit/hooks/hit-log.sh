#!/bin/bash
# Shared hit log for Hooks that deny or rewrite a command.
# Source this in other hooks: source "$(dirname "$0")/hit-log.sh"

# Prints the surface that ran this Hook: claude, codex, opencode, antigravity, or unknown.
# Claude Code sets CLAUDE_PROJECT_DIR on Hooks only. Codex user Hooks inherit its process environment,
# so stdin turn_id marks them: openai/codex rust-v0.169.0 hooks/src/registry.rs and schema.rs.
hook_surface() {
  case "${HARLAN_AGENT_HOOK_SURFACE:-}" in
    claude | codex | opencode | antigravity)
      printf '%s' "$HARLAN_AGENT_HOOK_SURFACE"
      return
      ;;
  esac
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
    printf claude
  elif [ -n "${PLUGIN_ROOT:-}" ] || printf '%s' "$1" | jq -e 'type == "object" and has("turn_id")' >/dev/null 2>&1; then
    printf codex
  else
    printf unknown
  fi
}

# Succeeds once per Hook and tool call, keyed on stdin session_id and tool_use_id. mkdir is atomic, so
# one of two parallel runs wins. A Hook registered twice, such as Codex user and Plugin Hooks, logs once.
first_hook_run() {
  local seen="$1/hook-hits.seen" call
  call=$(printf '%s' "$2" | jq -r '[.session_id, .tool_use_id] | select(all(type == "string" and . != "")) | join(".")' 2>/dev/null)
  [ -n "$call" ] || return 0
  call="$(basename "$0").${call//[^A-Za-z0-9._-]/_}"
  mkdir -p "$seen" || return 0
  find "$seen" -mindepth 1 -maxdepth 1 -mmin +1440 -exec rmdir {} + 2>/dev/null
  mkdir "$seen/${call:0:200}"
}

# Appends one line to the hit log. Usage: log_hook_hit <deny|rewrite> <reason> <stdin>
# The line keeps an 80 character reason prefix and never the command.
# A failed write is ignorable, so it never changes the decision or the Hook output.
log_hook_hit() {
  local directory="${XDG_STATE_HOME:-${HOME:-}/.local/state}/harlan-agent-kit"
  {
    mkdir -p "$directory" \
      && first_hook_run "$directory" "${3:-}" \
      && jq -nc --arg hook "$(basename "$0")" --arg decision "$1" --arg reason "$2" \
        --arg surface "$(hook_surface "${3:-}")" \
        '{time: (now | todate), hook: $hook, decision: $decision, surface: $surface, reason: $reason[0:80]}' \
        >> "$directory/hook-hits.jsonl"
  } >/dev/null 2>&1
  return 0
}
