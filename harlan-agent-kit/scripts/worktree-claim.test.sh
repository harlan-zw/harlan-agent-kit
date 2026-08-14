#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
claim_script="$script_dir/worktree-claim.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

repo="$test_root/repo"
other="$test_root/other"
git init -q "$repo"
git -C "$repo" config user.email test@example.com
git -C "$repo" config user.name Test
touch "$repo/seed"
git -C "$repo" add seed
git -C "$repo" commit -qm seed
git -C "$repo" worktree add -qb other "$other"

bash "$claim_script" acquire --path "$repo" --session first --lease 30 | jq -e '.claimed and (.other_active == false)' >/dev/null
bash "$claim_script" acquire --path "$other" --session second --lease 30 | jq -e '.claimed and .other_active' >/dev/null
bash "$claim_script" list --path "$repo" | jq -e 'length == 2' >/dev/null

if bash "$claim_script" release --path "$repo" --session wrong >/dev/null 2>&1; then
  echo 'wrong owner released a claim' >&2
  exit 1
fi

bash "$claim_script" release --path "$repo" --session first | jq -e '.released' >/dev/null
bash "$claim_script" release --path "$other" --session second | jq -e '.released' >/dev/null

first_status="$test_root/first.status"
second_status="$test_root/second.status"
(set +e; bash "$claim_script" acquire --path "$repo" --session contender-one --lease 30 >/dev/null 2>&1; echo "$?" > "$first_status") &
(set +e; bash "$claim_script" acquire --path "$repo" --session contender-two --lease 30 >/dev/null 2>&1; echo "$?" > "$second_status") &
wait

statuses=$(sort "$first_status" "$second_status" | tr '\n' ' ')
if [[ "$statuses" != '0 2 ' ]]; then
  echo "expected one owner and one conflict, received: $statuses" >&2
  exit 1
fi

owner=$(bash "$claim_script" list --path "$repo" | jq -r '.[0].session')
bash "$claim_script" release --path "$repo" --session "$owner" >/dev/null

bash "$claim_script" acquire --path "$repo" --session stale --lease 1 >/dev/null
sleep 2
bash "$claim_script" acquire --path "$repo" --session recovered --lease 30 | jq -e '.claimed' >/dev/null
bash "$claim_script" release --path "$repo" --session recovered >/dev/null

echo 'worktree claim tests passed'
