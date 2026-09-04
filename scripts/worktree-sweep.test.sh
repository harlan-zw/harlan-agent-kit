#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
sweep="$script_dir/worktree-sweep.sh"
claim="$script_dir/../harlan-agent-kit/scripts/worktree-claim.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

export HOME="$test_root/home"
mkdir -p "$HOME/.config/worktrunk" "$test_root/bin"
ln -s "$(command -v git)" "$test_root/bin/git"
ln -s "$(command -v jq)" "$test_root/bin/jq"
ln -s "$(command -v realpath)" "$test_root/bin/realpath"
ln -s "$(command -v sha256sum)" "$test_root/bin/sha256sum"
ln -s "$(command -v flock)" "$test_root/bin/flock"
ln -s "$(command -v wt)" "$test_root/bin/wt"
export PATH="$test_root/bin:/usr/bin:/bin"

origin="$test_root/origin.git"
repository="$test_root/example"
worktrunk_config="$HOME/.config/worktrunk/config.toml"

git init --quiet --bare --initial-branch=main "$origin"
git clone --quiet "$origin" "$repository"
git -C "$repository" config user.name Fixture
git -C "$repository" config user.email fixture@example.invalid
printf '%s\n' base > "$repository/base.txt"
git -C "$repository" add base.txt
git -C "$repository" commit --quiet -m base
git -C "$repository" push --quiet -u origin main

printf '%s\n' \
  'worktree-path = "../{{ repo }}.{{ branch | sanitize }}"' \
  '[list]' \
  'json-schema = 2' \
  > "$worktrunk_config"

create_worktree() {
  local branch=$1
  wt -C "$repository" --config "$worktrunk_config" switch --create "$branch" --base main >/dev/null
  wt -C "$repository" --config "$worktrunk_config" list --format=json \
    | jq -r --arg branch "$branch" '.items[] | select(.branch == $branch) | .worktree.path'
}

integrated=$(create_worktree integrated)
printf '%s\n' integrated > "$integrated/integrated.txt"
git -C "$integrated" add integrated.txt
git -C "$integrated" commit --quiet -m integrated
git -C "$repository" cherry-pick --quiet integrated

unintegrated=$(create_worktree unintegrated)
printf '%s\n' unintegrated > "$unintegrated/unintegrated.txt"
git -C "$unintegrated" add unintegrated.txt
git -C "$unintegrated" commit --quiet -m unintegrated

dirty=$(create_worktree dirty)
printf '%s\n' dirty > "$dirty/dirty.txt"

claimed=$(create_worktree claimed)
claim_session=$(bash "$claim" new-session)
bash "$claim" acquire --path "$claimed" --session "$claim_session" >/dev/null

dry_run=$(WORKTREE_SWEEP_WT="$(command -v wt)" WORKTREE_SWEEP_JQ="$(command -v jq)" \
  bash "$sweep" --days 0 "$test_root")

grep -F -- "ready"$'\t'"$integrated" <<< "$dry_run" >/dev/null
grep -F -- "kept"$'\t'"$unintegrated"$'\t'"reason=not-integrated" <<< "$dry_run" >/dev/null
grep -F -- "kept"$'\t'"$dirty"$'\t'"reason=dirty" <<< "$dry_run" >/dev/null
grep -F -- "kept"$'\t'"$claimed"$'\t'"reason=claimed" <<< "$dry_run" >/dev/null

WORKTREE_SWEEP_WT="$(command -v wt)" WORKTREE_SWEEP_JQ="$(command -v jq)" \
  bash "$sweep" --apply --days 0 "$test_root" >/dev/null

test ! -e "$integrated"
test -d "$unintegrated"
test -d "$dirty"
test -d "$claimed"
git -C "$repository" show-ref --verify --quiet refs/heads/unintegrated
if git -C "$repository" show-ref --verify --quiet refs/remotes/origin/unintegrated; then
  printf '%s\n' 'The sweep pushed an unintegrated branch.' >&2
  exit 1
fi

printf '%s\n' 'Worktree sweep tests passed'
