#!/usr/bin/env bash
# PreToolUse (Bash): require the PR skill for creation and description changes.

source "$(dirname "$0")/check-config.sh"
is_hook_disabled "pr-skill-only" && exit 0

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

[ -n "$command" ] || exit 0

command_start='(^|[|&;\(][[:space:]]*)'
pr_create="${command_start}gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"
pr_body_edit="${command_start}gh[[:space:]]+pr[[:space:]]+edit[[:space:]][^|&;]*(--body-file|--body|-b)(=|[[:space:]]|$)"
skill_create="${command_start}HARLAN_AGENT_PR_SKILL=1[[:space:]]+gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"
skill_body_edit="${command_start}HARLAN_AGENT_PR_SKILL=1[[:space:]]+gh[[:space:]]+pr[[:space:]]+edit[[:space:]][^|&;]*(--body-file|--body|-b)(=|[[:space:]]|$)"

if [[ "$command" =~ $skill_create ]] || [[ "$command" =~ $skill_body_edit ]]; then
  exit 0
fi

if [[ "$command" =~ $pr_create ]] || [[ "$command" =~ $pr_body_edit ]]; then
  reason="Use the pr skill to create pull requests or change descriptions. It loads the repository template and required disclosure."
  jq -nc --arg reason "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
fi

exit 0
