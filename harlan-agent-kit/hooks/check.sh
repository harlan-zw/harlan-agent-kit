#!/bin/bash
# Hook wrapper for check - respects hooks.json disabled config
# Delegates to the shared bin/check script
source "$(dirname "$0")/check-config.sh" 2>/dev/null

# Build skip flags from hooks.json
export CHECK_SKIP=""
is_hook_disabled "eslint" 2>/dev/null && CHECK_SKIP+="eslint,"
is_hook_disabled "typecheck" 2>/dev/null && CHECK_SKIP+="typecheck,"
is_hook_disabled "vitest" 2>/dev/null && CHECK_SKIP+="test,"

if command -v check &>/dev/null; then
  exec check
else
  echo "check not found in PATH — install: ln -sf /path/to/bin/check ~/.local/bin/check" >&2
  exit 1
fi
