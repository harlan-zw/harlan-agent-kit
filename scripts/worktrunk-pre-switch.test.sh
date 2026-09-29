#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

export HOME="$test_root/home"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_NOSYSTEM=1
unset HARLAN_GITHUB_AGENT
mkdir -p "$HOME"
git config --global init.defaultBranch main
bash "$script_dir/worktrunk-config.sh" update >/dev/null

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

# Each case gets a bare origin, a primary clone one commit behind origin, and a
# pusher clone that owns origin's newest commit.
setup() {
  local name=$1
  local root="$test_root/$name"
  mkdir -p "$root"
  git init --quiet --bare "$root/origin.git"
  git clone --quiet "$root/origin.git" "$root/pusher" 2>/dev/null
  git -C "$root/pusher" commit --quiet --allow-empty -m first
  git -C "$root/pusher" push --quiet origin main
  git clone --quiet "$root/origin.git" "$root/repo"
  printf 'one\n' >"$root/pusher/CHANGELOG.md"
  git -C "$root/pusher" add CHANGELOG.md
  git -C "$root/pusher" commit --quiet -m second
  git -C "$root/pusher" push --quiet origin main
  git -C "$root/pusher" push --quiet origin main:gone
  git -C "$root/repo" fetch --quiet origin
  git -C "$root/pusher" push --quiet origin --delete gone
  git -C "$root/repo" update-ref refs/remotes/origin/main "$(git -C "$root/pusher" rev-parse HEAD~1)"
  printf '%s\n' "$root"
}

switch() {
  local root=$1
  wt -C "$root/repo" -y switch --create task --base origin/main --no-cd 2>"$root/stderr"
}

assert_fetched() {
  local root=$1
  [ "$(git -C "$root/repo" rev-parse refs/remotes/origin/main)" = "$(git -C "$root/pusher" rev-parse HEAD)" ] \
    || fail "$root: origin/main was not fetched."
  ! git -C "$root/repo" rev-parse --verify --quiet refs/remotes/origin/gone >/dev/null \
    || fail "$root: the deleted origin branch was not pruned."
  [ "$(git -C "$root/repo.task" rev-parse HEAD)" = "$(git -C "$root/pusher" rev-parse HEAD)" ] \
    || fail "$root: the task worktree does not start at the fetched origin/main."
}

# A clean primary on main fast-forwards.
root=$(setup clean)
switch "$root" || fail "clean: the switch failed: $(cat "$root/stderr")"
assert_fetched "$root"
[ "$(git -C "$root/repo" rev-parse HEAD)" = "$(git -C "$root/pusher" rev-parse HEAD)" ] \
  || fail "clean: primary main did not fast-forward."
! grep --quiet '^Warning:' "$root/stderr" || fail "clean: the switch printed a warning."

# A dirty primary keeps its changes and its commit, and the switch continues.
root=$(setup dirty)
printf 'local\n' >"$root/repo/CHANGELOG.md"
printf 'new\n' >"$root/repo/untracked.txt"
before=$(git -C "$root/repo" rev-parse HEAD)
switch "$root" || fail "dirty: the switch failed: $(cat "$root/stderr")"
assert_fetched "$root"
[ "$(git -C "$root/repo" rev-parse HEAD)" = "$before" ] || fail "dirty: primary HEAD moved."
[ "$(cat "$root/repo/CHANGELOG.md")" = local ] || fail "dirty: the primary change was lost."
[ -f "$root/repo/untracked.txt" ] || fail "dirty: the untracked file was lost."
[ -z "$(git -C "$root/repo" stash list)" ] || fail "dirty: the hook created a stash."
grep --quiet '^Warning: repo primary checkout has 2 changed files' "$root/stderr" \
  || fail "dirty: the warning is missing: $(cat "$root/stderr")"

# A primary off main keeps its branch, and the switch continues.
root=$(setup off-main)
git -C "$root/repo" switch --quiet -c side
switch "$root" || fail "off-main: the switch failed: $(cat "$root/stderr")"
assert_fetched "$root"
[ "$(git -C "$root/repo" symbolic-ref --short HEAD)" = side ] || fail "off-main: the primary branch changed."
grep --quiet '^Warning: repo primary checkout is on side, not main' "$root/stderr" \
  || fail "off-main: the warning is missing: $(cat "$root/stderr")"

# A primary main with its own commit keeps it, and the switch continues.
root=$(setup diverged)
git -C "$root/repo" commit --quiet --allow-empty -m local
before=$(git -C "$root/repo" rev-parse HEAD)
switch "$root" || fail "diverged: the switch failed: $(cat "$root/stderr")"
assert_fetched "$root"
[ "$(git -C "$root/repo" rev-parse HEAD)" = "$before" ] || fail "diverged: primary HEAD moved."
grep --quiet '^Warning: repo primary main has commits that origin/main does not have' "$root/stderr" \
  || fail "diverged: the warning is missing: $(cat "$root/stderr")"

# A failed fetch stops the switch before Worktrunk creates anything.
root=$(setup offline)
git -C "$root/repo" remote set-url origin "$root/missing.git"
! switch "$root" || fail "offline: the switch succeeded without a fetch."
[ ! -e "$root/repo.task" ] || fail "offline: the worktree exists after a failed switch."
! git -C "$root/repo" rev-parse --verify --quiet refs/heads/task >/dev/null \
  || fail "offline: the branch exists after a failed switch."

printf '%s\n' 'Worktrunk pre-switch tests passed'
