#!/bin/bash
# Keeps every worktree under the `wt` (worktrunk) tool and its canonical path.
#
# `wt` places each worktree at `<parent>/<repo>.<branch-slug>`, fixed by
# ~/.config/worktrunk/config.toml. Raw `git worktree add` and harness worktree
# options scatter checkouts into the banned harness directory and other ad hoc
# paths.
#
# Read-only `git worktree list` stays allowed.
#
# A call counts only at a command position, matching pr-skill-only.sh and
# himalaya-read-only.sh. Prose that names a command or the banned path is not a
# call, so heredoc bodies and quoted spans are dropped before the match. An
# inline environment assignment before the binary is not matched, which is the
# known gap in this shape. A quoted real path is not matched either.
source "$(dirname "$0")/check-config.sh"
source "$(dirname "$0")/command-text.sh"
is_hook_disabled "wt-only" && exit 0

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

[ -n "$command" ] || exit 0

block() {
  jq -nc --arg reason "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}

code=$(command_code "$command")

command_start='(^|[|&;\(][[:space:]]*)'
command_end='([[:space:]]|;|$)'
banned_path='.claude/worktrees'
git_worktree="${command_start}git[[:space:]]+([^|&;]*[[:space:]])?worktree[[:space:]]+(add|remove|move|prune)${command_end}"
wt_clobber="${command_start}wt[[:space:]]+[^|&;]*--clobber(=|${command_end})"
wt_force_remove="${command_start}wt[[:space:]]+remove[[:space:]]+[^|&;]*--force"

if [[ "$code" =~ $git_worktree ]]; then
  block "Use wt, not git worktree. Create: wt switch --create <branch> --base <base>. Enter: wt switch <branch>. Remove: wt remove <branch>. Read paths from wt list --format=json. See references/worktree-isolation.md."
fi

if [[ "$code" == *"$banned_path"* ]]; then
  block "$banned_path is banned. wt owns every worktree at <parent>/<repo>.<branch-slug>. See references/worktree-isolation.md."
fi

if [[ "$code" =~ $wt_clobber ]]; then
  block "wt switch --clobber destroys another task's worktree. Pick a different branch name."
fi

if [[ "$code" =~ $wt_force_remove ]]; then
  block "wt remove --force drops unmerged work. Merge or land the branch first."
fi

exit 0
