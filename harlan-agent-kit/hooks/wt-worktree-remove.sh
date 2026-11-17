#!/bin/bash
# WorktreeRemove: remove a worktree wt-worktree-create.sh made, through wt and never with force.
# wt refuses a worktree with uncommitted work, so the worktree and its branch stay.

input=$(cat)
path=$(printf '%s' "$input" | jq -r '.worktree_path // empty')

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[ -d "$path" ] || exit 0
branch=$(git -C "$path" branch --show-current 2>/dev/null)
[ -n "$branch" ] || fail "WorktreeRemove found no branch at $path. Remove it with wt remove."
wt -C "$path" remove "$branch" --foreground >&2 \
  || fail "wt kept $branch at $path. Commit or discard its changes, then run wt remove $branch."
