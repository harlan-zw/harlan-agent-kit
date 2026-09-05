#!/usr/bin/env bash
# Verifies the wt-only hook blocks ad hoc worktree creation and allows reads.
set -uo pipefail

hook="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wt-only.sh"
fail=0
banned='.claude/worktrees'

decision() {
  local out
  out="$(printf '%s' "$1" | jq -Rsn --arg c "$(cat)" '{tool_input:{command:$c}}' | bash "$hook")"
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
expect deny "cd $banned/x && pnpm test"
expect deny 'wt switch --clobber feat/x'
expect deny 'wt remove feat/x --force'

# A command position after a separator is still a call.
expect deny 'pnpm install && git worktree add ../foo bar'
expect deny 'pnpm install; git worktree prune'
expect deny "pnpm install && ls $banned"

expect allow 'git worktree list'
expect allow 'wt switch --create feat/x --base main'
expect allow 'wt list --format=json'
expect allow 'echo git worktree adds'
expect allow 'git log --oneline'

# Prose that names the rule is documentation, not a call.
expect allow "echo \"never write to $banned\""
expect allow "rg -n '$banned' docs/"
expect allow "printf '%s\\n' 'run git worktree add by hand'"
expect allow 'grep -r "git worktree add" docs/'
expect allow "$(printf 'cat > notes.md <<EOF\nNever use %s here.\nUse wt, not git worktree add.\nEOF\n' "$banned")"
expect allow "$(printf "cat > notes.md <<'DOC'\nwt remove feat/x --force drops work.\nDOC\n")"

# A real call after a heredoc still counts.
expect deny "$(printf 'cat > notes.md <<EOF\nharmless prose\nEOF\ngit worktree add ../foo bar\n')"

[ "$fail" -eq 0 ] && echo 'wt-only hook tests passed'
exit "$fail"
