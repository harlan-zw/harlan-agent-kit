#!/bin/bash
# Keeps every worktree under the `wt` (worktrunk) tool and its canonical path.
#
# `wt` places each worktree at `<parent>/<repo>.<branch-slug>`, fixed by
# ~/.config/worktrunk/config.toml. Raw `git worktree add` and harness worktree
# options scatter checkouts into `.claude/worktrees/` and other ad hoc paths.
#
# Read-only `git worktree list` stays allowed.
source "$(dirname "$0")/check-config.sh"
is_hook_disabled "wt-only" && exit 0

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

block() {
  jq -nc --arg reason "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}

if [[ "$command" =~ (^|[[:space:]|&\;\(])git[[:space:]]([^|\&\;]*[[:space:]])?worktree[[:space:]]+(add|remove|move|prune)([[:space:]]|$) ]]; then
  block "Use wt, not git worktree. Create: wt switch --create <branch> --base <base>. Enter: wt switch <branch>. Remove: wt remove <branch>. Read paths from wt list --format=json. See references/worktree-isolation.md."
fi

if [[ "$command" =~ \.claude/worktrees ]]; then
  block ".claude/worktrees is banned. wt owns every worktree at <parent>/<repo>.<branch-slug>. See references/worktree-isolation.md."
fi

if [[ "$command" =~ (^|[[:space:]])wt[[:space:]].*--clobber ]]; then
  block "wt switch --clobber destroys another task's worktree. Pick a different branch name."
fi

if [[ "$command" =~ (^|[[:space:]])wt[[:space:]]+remove[[:space:]].*--force ]]; then
  block "wt remove --force drops unmerged work. Merge or land the branch first."
fi

exit 0
