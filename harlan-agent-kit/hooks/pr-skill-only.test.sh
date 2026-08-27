#!/usr/bin/env bash
# Verifies pull request descriptions can change only through the PR skill.
set -uo pipefail

hook="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pr-skill-only.sh"
fail=0

decision() {
  local out
  out="$(jq -nc --arg command "$1" '{tool_input:{command:$command}}' | bash "$hook")"
  [ -n "$out" ] || { echo allow; return; }
  printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision'
}

expect() {
  local want="$1" command="$2" got
  got="$(decision "$command")"
  if [ "$got" != "$want" ]; then
    printf 'FAIL  expected %s, got %s for: %s\n' "$want" "$got" "$command"
    fail=1
  fi
}

expect deny 'gh pr create --title "fix: example" --body "wrong"'
expect deny 'cd /repo && gh pr create --fill'
expect deny 'gh pr edit 42 --body "wrong"'
expect deny 'gh pr edit 42 --body-file /tmp/pr.md'

expect allow 'HARLAN_AGENT_PR_SKILL=1 gh pr create --title "fix: example" --body "right"'
expect allow 'HARLAN_AGENT_PR_SKILL=1 gh pr edit 42 --body "right"'
expect allow 'gh pr edit 42 --add-label ready'
expect allow 'gh pr view 42 --json body'
expect allow 'echo gh pr create'

[ "$fail" -eq 0 ] && echo 'pr-skill-only hook tests passed'
exit "$fail"
