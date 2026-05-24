#!/bin/bash
input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

rewrite() {
  jq -nc --arg cmd "$1" --arg reason "$2" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"allow",permissionDecisionReason:$reason,updatedInput:{command:$cmd}}}'
  exit 0
}

# npm/yarn -> pnpm
if [[ "$command" =~ ^npm[[:space:]] ]]; then
  rewrite "${command/#npm/pnpm}" "Rewritten: npm → pnpm"
fi
if [[ "$command" =~ ^yarn[[:space:]] ]]; then
  rewrite "${command/#yarn/pnpm}" "Rewritten: yarn → pnpm"
fi

# npx -> pnpm dlx
if [[ "$command" =~ ^npx[[:space:]] ]]; then
  rewrite "pnpm dlx${command#npx}" "Rewritten: npx → pnpm dlx"
fi
