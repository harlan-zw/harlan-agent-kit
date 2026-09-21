#!/usr/bin/env bash
# PreToolUse (Bash): require the PR skill for creation and description changes.

source "$(dirname "$0")/check-config.sh"
source "$(dirname "$0")/command-text.sh"
is_hook_disabled "pr-skill-only" && exit 0

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

[ -n "$command" ] || exit 0

# A multi-line call puts gh on its own line, so the text is normalized first.
# Without this, a heredoc followed by gh pr create passes the hook unseen.
code=$(command_code "$command")

command_start='(^|[|&;\(`][[:space:]]*)'
# An inline assignment or an env or timeout wrapper keeps gh at the command
# position, so the patterns must see through a leading prefix of them.
wrap='(env|timeout([[:space:]]+[^[:space:]]+)?)'
lead_item='[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|timeout([[:space:]]+[^[:space:]]+)?'
lead="((${lead_item})[[:space:]]+)*"
# The allow patterns accept wrappers around the skill assignment, but the
# assignment itself must be exactly HARLAN_AGENT_PR_SKILL=1.
skill_item='HARLAN_AGENT_PR_SKILL=1|env|timeout([[:space:]]+[^[:space:]]+)?'
skill_lead="((${skill_item})[[:space:]]+)*HARLAN_AGENT_PR_SKILL=1[[:space:]]+(${wrap}[[:space:]]+)*"
pr_create="${command_start}${lead}gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"
pr_body_edit="${command_start}${lead}gh[[:space:]]+pr[[:space:]]+edit[[:space:]][^|&;]*(--body-file|--body|-b)(=|[[:space:]]|$)"
skill_create="${command_start}${skill_lead}gh[[:space:]]+pr[[:space:]]+create([[:space:]]|$)"
skill_body_edit="${command_start}${skill_lead}gh[[:space:]]+pr[[:space:]]+edit[[:space:]][^|&;]*(--body-file|--body|-b)(=|[[:space:]]|$)"

if [[ "$code" =~ $skill_create ]] || [[ "$code" =~ $skill_body_edit ]]; then
  exit 0
fi

if [[ "$code" =~ $pr_create ]] || [[ "$code" =~ $pr_body_edit ]]; then
  reason='Use the Harlan Agent Kit PR skill: `harlan-agent-kit:pr`. Claude Code invokes it as `/harlan-agent-kit:pr`. Codex invokes it as `$harlan-agent-kit:pr`. It loads the repository template and required disclosure.'
  jq -nc --arg reason "$reason" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
fi

exit 0
