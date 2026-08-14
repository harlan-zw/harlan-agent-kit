#!/usr/bin/env bash
# Verifies the wt-only hook blocks ad hoc worktree creation and allows reads.
set -uo pipefail

hook="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wt-only.sh"
fail=0

decision() {
  local out
  out="$(printf '%s' "$1" | jq -Rn --arg c "$(cat)" '{tool_input:{command:$c}}' | bash "$hook")"
  # Silent exit means the hook did not intervene.
  [ -n "$out" ] || { echo allow; return; }
  printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision'
}

expect() {
  local want="$1" cmd="$2" got
  got="$(decision "$cmd")"
  if [ "$got" != "$want" ]; then
    printf 'FAIL  expected %s, got %s for: %s\n' "$want" "$got" "$cmd"
    fail=1
  fi
}

expect deny 'git worktree add ../foo bar'
expect deny 'git -C /repo worktree remove foo'
expect deny 'git worktree prune'
expect deny 'cd .claude/worktrees/x && pnpm test'
expect deny 'wt switch --clobber feat/x'
expect deny 'wt remove feat/x --force'

expect allow 'git worktree list'
expect allow 'wt switch --create feat/x --base main'
expect allow 'wt list --format=json'
expect allow 'echo git worktree adds'
expect allow 'git log --oneline'

[ "$fail" -eq 0 ] && echo 'wt-only hook tests passed'
exit "$fail"
