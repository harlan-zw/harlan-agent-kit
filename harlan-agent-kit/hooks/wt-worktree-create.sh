#!/bin/bash
# WorktreeCreate: create Claude Code worktrees with wt, never under .claude/worktrees.
# Claude Code reads the last stdout line as the path, so every other line goes to stderr.

input=$(cat)
name=$(printf '%s' "$input" | jq -r '.name // empty')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

[[ "$name" =~ ^[A-Za-z0-9._-]+$ ]] || fail "WorktreeCreate needs a simple worktree name, got: $name"
repo=$(git -C "${cwd:-.}" rev-parse --show-toplevel 2>/dev/null) || fail "WorktreeCreate ran outside a git repository: $cwd"
# The new worktree starts from the caller's exact commit, as git worktree add would.
base=$(git -C "$repo" rev-parse HEAD) || fail "WorktreeCreate could not read HEAD in $repo"
branch="worktree-$name"

wt -C "$repo" -y switch --create "$branch" --base "$base" --no-cd >&2 \
  || fail "wt could not create $branch in $repo. Run wt switch --create $branch --base $base there to see why."
# wt list emits schema 1 (an array) or schema 2 (items), depending on user config.
path=$(wt -C "$repo" list --format=json 2>/dev/null | jq -r --arg branch "$branch" '(if type == "array" then .[] else .items[] end) | select(.branch == $branch) | (.worktree.path? // .path)' 2>/dev/null)
[ -n "$path" ] && [ -d "$path" ] || fail "wt created $branch but listed no worktree path for it."
printf '%s\n' "$path"
