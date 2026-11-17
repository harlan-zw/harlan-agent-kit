#!/bin/bash
input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

deny() {
  jq -nc --arg reason "$1" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
  exit 0
}

# Inject commit guidelines for git commit (additionalContext doesn't block)
if [[ "$command" =~ ^git[[:space:]]+commit ]]; then
  cat <<EOF
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "Commit format: type(scope): description. Types: feat/fix/docs/refactor/test/chore. Scope: monorepo folder or treeshakable export name, omit if neither applies. Subject under 70 chars."}}
EOF
fi

