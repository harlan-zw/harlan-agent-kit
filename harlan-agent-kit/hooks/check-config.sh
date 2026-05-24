#!/bin/bash
# Shared config loader for hooks
# Source this in other hooks: source "$(dirname "$0")/check-config.sh"

# Check for project-level hook config
HOOK_CONFIG=".claude/hooks.json"

is_hook_disabled() {
  local hook_name="$1"
  if [ -f "$HOOK_CONFIG" ]; then
    disabled=$(jq -r ".disabled // [] | index(\"$hook_name\") // empty" "$HOOK_CONFIG" 2>/dev/null)
    [ -n "$disabled" ] && return 0
  fi
  return 1
}