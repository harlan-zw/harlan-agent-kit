#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo 'usage: worktree-claim.sh <new-session|acquire|list|release> [--path PATH] [--session ID] [--lease SECONDS]' >&2
  exit 64
}

command_name=${1:-}
[[ -n "$command_name" ]] || usage
shift

claim_path=$PWD
claim_session=${HARLAN_AGENT_TASK_ID:-${CODEX_THREAD_ID:-}}
claim_lease=900

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path)
      [[ $# -ge 2 ]] || usage
      claim_path=$2
      shift 2
      ;;
    --session)
      [[ $# -ge 2 ]] || usage
      claim_session=$2
      shift 2
      ;;
    --lease)
      [[ $# -ge 2 ]] || usage
      claim_lease=$2
      shift 2
      ;;
    *) usage ;;
  esac
done

if [[ "$command_name" == 'new-session' ]]; then
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen
  else
    tr '[:upper:]' '[:lower:]' < /proc/sys/kernel/random/uuid
  fi
  exit 0
fi

command -v flock >/dev/null 2>&1 || { echo 'flock is required' >&2; exit 69; }
command -v jq >/dev/null 2>&1 || { echo 'jq is required' >&2; exit 69; }

case "$command_name" in
  acquire|release)
    [[ -n "$claim_session" && "$claim_session" != *$'\n'* ]] || { echo 'a stable session ID is required' >&2; exit 64; }
    ;;
  list) ;;
  *) usage ;;
esac

if ! [[ "$claim_lease" =~ ^[0-9]+$ ]] || (( claim_lease < 1 || claim_lease > 3600 )); then
  echo 'lease must be between 1 and 3600 seconds' >&2
  exit 64
fi

repository_root=$(git -C "$claim_path" rev-parse --show-toplevel 2>/dev/null) || { echo 'path is not in a Git repository' >&2; exit 69; }
repository_root=$(realpath "$repository_root")
common_git_dir=$(git -C "$claim_path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo 'cannot resolve the common Git directory' >&2; exit 69; }
common_git_dir=$(realpath "$common_git_dir")
claim_root="$common_git_dir/harlan-agent-kit/worktree-claims"
mkdir -p "$claim_root"

claim_key=$(printf '%s' "$repository_root" | sha256sum | cut -d' ' -f1)
claim_file="$claim_root/$claim_key.json"
mutex_file="$claim_root/.mutex"
now_epoch=$(date +%s)

exec 9>"$mutex_file"
flock -x 9

shopt -s nullglob
for candidate in "$claim_root"/*.json; do
  expires_epoch=$(jq -r '.expires_epoch // 0' "$candidate" 2>/dev/null || echo 0)
  if ! [[ "$expires_epoch" =~ ^[0-9]+$ ]] || (( expires_epoch <= now_epoch )); then
    rm -f -- "$candidate"
  fi
done

if [[ "$command_name" == 'list' ]]; then
  claim_files=("$claim_root"/*.json)
  if (( ${#claim_files[@]} == 0 )); then
    echo '[]'
  else
    jq -s 'sort_by(.worktree)' "${claim_files[@]}"
  fi
  exit 0
fi

if [[ "$command_name" == 'release' ]]; then
  if [[ ! -f "$claim_file" ]]; then
    jq -n --arg repository "$common_git_dir" --arg worktree "$repository_root" '{ released: false, reason: "not_found", repository: $repository, worktree: $worktree }'
    exit 0
  fi

  existing_session=$(jq -r '.session // empty' "$claim_file")
  if [[ "$existing_session" != "$claim_session" ]]; then
    jq -n --arg owner "$existing_session" '{ released: false, reason: "owner_mismatch", owner: $owner }'
    exit 3
  fi

  rm -f -- "$claim_file"
  jq -n --arg repository "$common_git_dir" --arg worktree "$repository_root" '{ released: true, repository: $repository, worktree: $worktree }'
  exit 0
fi

if [[ -f "$claim_file" ]]; then
  existing_session=$(jq -r '.session // empty' "$claim_file")
  if [[ "$existing_session" != "$claim_session" ]]; then
    jq -n --arg owner "$existing_session" --arg repository "$common_git_dir" --arg worktree "$repository_root" '{ claimed: false, reason: "checkout_claimed", owner: $owner, repository: $repository, worktree: $worktree }'
    exit 2
  fi
fi

other_active=false
for candidate in "$claim_root"/*.json; do
  candidate_session=$(jq -r '.session // empty' "$candidate")
  if [[ "$candidate_session" != "$claim_session" ]]; then
    other_active=true
    break
  fi
done

expires_epoch=$((now_epoch + claim_lease))
claim_tmp="$claim_root/.$claim_key.$$.tmp"
jq -n \
  --arg repository "$common_git_dir" \
  --arg worktree "$repository_root" \
  --arg session "$claim_session" \
  --argjson refreshed_epoch "$now_epoch" \
  --argjson expires_epoch "$expires_epoch" \
  '{ repository: $repository, worktree: $worktree, session: $session, refreshed_epoch: $refreshed_epoch, expires_epoch: $expires_epoch }' > "$claim_tmp"
mv -f -- "$claim_tmp" "$claim_file"

jq -n \
  --arg repository "$common_git_dir" \
  --arg worktree "$repository_root" \
  --arg session "$claim_session" \
  --argjson other_active "$other_active" \
  --argjson expires_epoch "$expires_epoch" \
  '{ claimed: true, repository: $repository, worktree: $worktree, session: $session, other_active: $other_active, expires_epoch: $expires_epoch }'
