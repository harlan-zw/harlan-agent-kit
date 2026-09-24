#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
sweep="$script_dir/worktree-sweep.sh"
claim="$script_dir/../harlan-agent-kit/scripts/worktree-claim.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
real_worktrunk=$(command -v wt)

export HOME="$test_root/home"
mkdir -p "$HOME/.config/worktrunk" "$test_root/bin"
ln -s "$(command -v git)" "$test_root/bin/git"
ln -s "$(command -v jq)" "$test_root/bin/jq"
ln -s "$(command -v realpath)" "$test_root/bin/realpath"
ln -s "$(command -v sha256sum)" "$test_root/bin/sha256sum"
ln -s "$(command -v flock)" "$test_root/bin/flock"
ln -s "$real_worktrunk" "$test_root/bin/wt"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'if [[ " $* " == *" list "* ]]; then' \
  '  printf '\''%s\n'\'' '\''The sweep asked Worktrunk to list every tree.'\'' >&2' \
  '  exit 99' \
  'fi' \
  'exec "$WORKTREE_SWEEP_REAL_WT" "$@"' \
  > "$test_root/bin/sweep-wt"
chmod +x "$test_root/bin/sweep-wt"
export WORKTREE_SWEEP_REAL_WT="$real_worktrunk"
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
git -C "$repository" push --quiet origin main

unintegrated=$(create_worktree unintegrated)
printf '%s\n' unintegrated > "$unintegrated/unintegrated.txt"
git -C "$unintegrated" add unintegrated.txt
git -C "$unintegrated" commit --quiet -m unintegrated

dirty=$(create_worktree dirty)
printf '%s\n' dirty > "$dirty/dirty.txt"

claimed=$(create_worktree claimed)
claim_session=$(bash "$claim" new-session)
bash "$claim" acquire --path "$claimed" --session "$claim_session" >/dev/null

dry_run=$(WORKTREE_SWEEP_WT="$test_root/bin/sweep-wt" WORKTREE_SWEEP_JQ="$(command -v jq)" \
  bash "$sweep" --days 0 "$test_root")

grep -F -- "ready"$'\t'"$integrated" <<< "$dry_run" >/dev/null
grep -F -- "kept"$'\t'"$unintegrated"$'\t'"reason=not-integrated" <<< "$dry_run" >/dev/null
grep -F -- "kept"$'\t'"$dirty"$'\t'"reason=dirty" <<< "$dry_run" >/dev/null
grep -F -- "kept"$'\t'"$claimed"$'\t'"reason=claimed" <<< "$dry_run" >/dev/null

WORKTREE_SWEEP_WT="$test_root/bin/sweep-wt" WORKTREE_SWEEP_JQ="$(command -v jq)" \
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

bin_without_realpath="$test_root/bin-without-realpath"
mkdir -p "$bin_without_realpath"
for tool in bash git jq wt sha256sum flock date stat find; do
  ln -s "$(command -v "$tool")" "$bin_without_realpath/$tool"
done
bash_bin=$(command -v bash)

set +e
regression_run=$(WORKTREE_SWEEP_WT="$test_root/bin/sweep-wt" WORKTREE_SWEEP_JQ="$(command -v jq)" \
  PATH="$bin_without_realpath" "$bash_bin" "$sweep" --apply --days 0 "$test_root" 2>&1)
sweep_status=$?
set -e

test "$sweep_status" -ne 0 || {
  printf '%s\n' 'The sweep ran without realpath and treated the claimed worktree as unclaimed.' >&2
  exit 1
}
grep -F 'realpath is not installed' <<< "$regression_run" >/dev/null
test -d "$claimed"

printf '%s\n' 'Worktree sweep tests passed'

# A squash merge followed by edits must not strand the original worktree.
squashed=$(create_worktree squashed)
printf '%s\n' feature > "$squashed/base.txt"
git -C "$squashed" commit --quiet -am feature
squashed_head=$(git -C "$squashed" rev-parse HEAD)
git -C "$repository" merge --squash squashed >/dev/null
git -C "$repository" commit --quiet -m squash
squash_commit=$(git -C "$repository" rev-parse HEAD)
printf '%s\n' later > "$repository/base.txt"
git -C "$repository" commit --quiet -am later
git -C "$repository" push --quiet origin main

# Only the network boundary is replaced. Git history and removal use real tools.
real_git=$(realpath "$(command -v git)")
export SWEEP_TEST_GIT="$real_git" SWEEP_TEST_HEAD="$squashed_head" SWEEP_TEST_MERGE="$squash_commit"
rm "$test_root/bin/git"
cat > "$test_root/bin/git" <<'EOF'
#!/usr/bin/env bash
if [[ ${SWEEP_TEST_LOCAL_ONLY:-false} != true && " $* " == *' remote get-url origin '* ]]; then
  printf '%s\n' https://github.com/fixture/example.git
  exit 0
fi
if [[ ${SWEEP_TEST_FETCH:-ok} == failure && " $* " == *' fetch '* ]]; then
  printf '%s\n' 'Origin fixture unavailable' >&2
  exit 1
fi
exec "$SWEEP_TEST_GIT" "$@"
EOF
cat > "$test_root/bin/gh" <<'EOF'
#!/usr/bin/env bash
if [[ ${SWEEP_TEST_API:-ok} == failure ]]; then
  printf '%s\n' 'GitHub fixture unavailable' >&2
  exit 1
fi
jq -n --arg head "$SWEEP_TEST_HEAD" --arg merge "$SWEEP_TEST_MERGE" \
  --arg state "${SWEEP_TEST_STATE:-MERGED}" --arg repo "${SWEEP_TEST_REPO:-fixture/example}" \
  --argjson more "${SWEEP_TEST_MORE:-false}" --arg base "${SWEEP_TEST_BASE:-main}" \
  '{data:{repository:{pullRequests:{pageInfo:{hasNextPage:$more},nodes:[{
    number:1,state:"MERGED",headRefOid:$head,headRepository:{nameWithOwner:$repo},
    baseRepository:{nameWithOwner:"fixture/example"},baseRefName:$base,mergeCommit:{oid:$merge}
  }]}}}} | if $state == "OPEN" then
    .data.repository.pullRequests.nodes += [(.data.repository.pullRequests.nodes[0] | .state = "OPEN" | .number = 2)]
    else . end'
EOF
chmod +x "$test_root/bin/git" "$test_root/bin/gh"

dry_run=$(bash "$sweep" --days 0 "$test_root")
grep -F -- "ready"$'\t'"$squashed" <<< "$dry_run" >/dev/null

for scenario in open foreign failure fetch-failure newer missing-destination deleted-base incomplete; do
  export SWEEP_TEST_STATE=MERGED SWEEP_TEST_REPO=fixture/example SWEEP_TEST_API=ok
  export SWEEP_TEST_MERGE="$squash_commit" SWEEP_TEST_MORE=false SWEEP_TEST_BASE=main SWEEP_TEST_FETCH=ok
  case "$scenario" in
    open) export SWEEP_TEST_STATE=OPEN ;;
    foreign) export SWEEP_TEST_REPO=someone/example ;;
    failure) export SWEEP_TEST_API=failure ;;
    fetch-failure) export SWEEP_TEST_FETCH=failure ;;
    newer)
      printf '%s\n' unpublished > "$squashed/unpublished.txt"
      git -C "$squashed" add unpublished.txt
      git -C "$squashed" commit --quiet -m unpublished
      ;;
    missing-destination) export SWEEP_TEST_MERGE="$squashed_head" ;;
    deleted-base)
      export SWEEP_TEST_BASE=deleted
      git -C "$repository" update-ref refs/remotes/origin/deleted "$squash_commit"
      ;;
    incomplete) export SWEEP_TEST_MORE=true ;;
  esac
  bash "$sweep" --apply --days 0 "$test_root" > "$test_root/$scenario.log" 2>&1 || true
  test -d "$squashed" || { printf 'Removed protected case: %s\n' "$scenario" >&2; exit 1; }
  if [[ $scenario == newer ]]; then
    git -C "$squashed" reset --hard --quiet "$squashed_head"
  fi
done
export SWEEP_TEST_STATE=MERGED SWEEP_TEST_REPO=fixture/example SWEEP_TEST_API=ok SWEEP_TEST_MERGE="$squash_commit"
export SWEEP_TEST_MORE=false SWEEP_TEST_BASE=main
# Fetch a missing merged head from the pull request ref. The destination may be a release branch.
git -C "$repository" push --quiet origin "$squashed_head:refs/pull/1/head" "$squash_commit:refs/heads/release"
export SWEEP_TEST_HEAD
SWEEP_TEST_HEAD=$(git -C "$origin" -c user.name=Fixture -c user.email=fixture@example.invalid \
  commit-tree "$squashed_head^{tree}" -p "$squashed_head" -m followup)
git -C "$origin" update-ref refs/pull/1/head "$SWEEP_TEST_HEAD"
export SWEEP_TEST_BASE=release
if git -C "$repository" cat-file -e "$SWEEP_TEST_HEAD" 2>/dev/null; then
  printf '%s\n' 'The fixture already has the missing pull request head.' >&2
  exit 1
fi
dry_run=$(bash "$sweep" --days 0 "$test_root")
grep -F -- "ready"$'\t'"$squashed" <<< "$dry_run" >/dev/null
bash "$sweep" --apply --days 0 "$test_root" >/dev/null
test ! -e "$squashed"
export SWEEP_TEST_LOCAL_ONLY=true
git -C "$repository" remote remove origin
local_run=$(bash "$sweep" --apply --days 0 "$test_root")
grep -F -- "kept"$'\t'"$unintegrated"$'\t'"reason=no-origin" <<< "$local_run" >/dev/null
test -d "$unintegrated"
printf '%s\n' 'Merged pull request sweep tests passed'
