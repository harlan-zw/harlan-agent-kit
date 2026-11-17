#!/usr/bin/env bash
# Verifies the WorktreeCreate and WorktreeRemove hooks create and remove worktrees through wt.
set -uo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
export HOME="$root/home" GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
unset XDG_CONFIG_HOME WORKTRUNK_CONFIG_PATH
mkdir -p "$HOME"
git config --global init.defaultBranch main
fail=0
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }

git init --quiet --bare "$root/origin.git"
git clone --quiet "$root/origin.git" "$root/repo" 2>/dev/null
git -C "$root/repo" commit --quiet --allow-empty -m first
git -C "$root/repo" push --quiet origin main
# The caller's HEAD is ahead of origin, so the base must be HEAD, not origin/main.
git -C "$root/repo" commit --quiet --allow-empty -m local
head=$(git -C "$root/repo" rev-parse HEAD)

create() { jq -nc --arg cwd "$1" --arg name "$2" '{hook_event_name:"WorktreeCreate",cwd:$cwd,name:$name}' | bash "$dir/wt-worktree-create.sh" 2>"$root/create.err"; }
remove() { jq -nc --arg path "$1" '{hook_event_name:"WorktreeRemove",worktree_path:$path}' | bash "$dir/wt-worktree-remove.sh" 2>"$root/remove.err"; }

out=$(create "$root/repo" probe)
[ "$out" = "$root/repo.worktree-probe" ] || bad "create printed more than the wt path: $out"
[ "$(git -C "$out" rev-parse HEAD 2>/dev/null)" = "$head" ] || bad "the worktree does not start at the caller's HEAD"

printf 'work\n' >"$out/work.txt"
remove "$out" && bad "remove deleted a worktree with uncommitted work"
[ -f "$out/work.txt" ] || bad "remove lost uncommitted work"

rm "$out/work.txt"
remove "$out" || bad "remove failed on a clean worktree: $(cat "$root/remove.err")"
[ ! -e "$out" ] || bad "remove left the clean worktree on disk"
[ -z "$(git -C "$root/repo" branch --list worktree-probe)" ] || bad "remove left the merged branch"

out=$(create "$root/repo" '../escape')
[ -z "$out" ] || bad "create accepted a name with a path: $out"

[ "$fail" -eq 0 ] && echo 'ok    wt worktree hooks'
exit "$fail"
