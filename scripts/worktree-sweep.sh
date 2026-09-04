#!/usr/bin/env bash

set -uo pipefail

apply=false
stale_days=7
scan_root=$HOME

usage() {
  printf '%s\n' 'Usage: worktree-sweep.sh [--apply] [--days DAYS] [ROOT]' >&2
}

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --apply)
      apply=true
      ;;
    --days)
      shift
      [[ ${1:-} =~ ^[0-9]+$ ]] || { usage; exit 2; }
      stale_days=$1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      usage
      exit 2
      ;;
    *)
      scan_root=$1
      ;;
  esac
  shift
done

[[ -d $scan_root ]] || fail "The scan root does not exist: $scan_root"

worktrunk_bin=${WORKTREE_SWEEP_WT:-$(command -v wt 2>/dev/null || true)}
jq_bin=${WORKTREE_SWEEP_JQ:-$(command -v jq 2>/dev/null || true)}
[[ -x $worktrunk_bin ]] || fail 'Worktrunk is not installed.'
[[ -x $jq_bin ]] || fail 'jq is not installed.'

now=$(date +%s)
repo_count=0
worktree_count=0
old_count=0
ready_count=0
removed_count=0
kept_count=0
error_count=0
declare -A seen_repositories=()

created_time_for() {
  local path=$1 created
  created=$(stat -c %W -- "$path/.git" 2>/dev/null || printf '0\n')
  ((created > 0)) || created=$(stat -c %Y -- "$path/.git" 2>/dev/null || printf '0\n')
  printf '%s\n' "$created"
}

has_live_claim() {
  local path=$1 common_git_dir claim
  common_git_dir=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  for claim in "$common_git_dir"/harlan-agent-kit/worktree-claims/*.json; do
    [[ -f $claim ]] || continue
    if "$jq_bin" -e --arg path "$(realpath "$path")" --argjson now "$now" \
      '.worktree == $path and (.expires_epoch // 0) > $now' "$claim" >/dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

keep() {
  local path=$1 reason=$2
  printf 'kept\t%s\treason=%s\n' "$path" "$reason"
  ((kept_count += 1))
}

inspect_repository() {
  local repository=$1 worktrunk_json rows path branch head state dirty detached created age current_head removal

  ((repo_count += 1))
  if ! worktrunk_json=$(COLUMNS=120 LINES=40 NO_COLOR=1 TERM=dumb \
    "$worktrunk_bin" -C "$repository" list --format=json); then
    printf 'error\t%s\treason=worktrunk-list-failed\n' "$repository" >&2
    ((error_count += 1))
    return
  fi

  if ! rows=$("$jq_bin" -r '
    if .schema != 2 or (.items | type) != "array" then
      error("Worktrunk JSON schema 2 is required")
    else
      .items[]
      | select(.worktree != null and .worktree.main == false)
      | [
          .worktree.path,
          (.branch // ""),
          .head.sha,
          (.display.state // "unknown"),
          ([
            .worktree.changes.staged,
            .worktree.changes.modified,
            .worktree.changes.untracked,
            .worktree.changes.renamed,
            .worktree.changes.deleted,
            .worktree.changes.conflicted
          ] | any | tostring),
          (.worktree.detached // false | tostring)
        ]
      | @tsv
    end
  ' <<< "$worktrunk_json"); then
    printf 'error\t%s\treason=unsupported-worktrunk-json\n' "$repository" >&2
    ((error_count += 1))
    return
  fi

  while IFS=$'\t' read -r path branch head state dirty detached; do
    [[ -n $path && -e $path/.git ]] || continue
    ((worktree_count += 1))
    created=$(created_time_for "$path")
    ((created > 0)) || {
      keep "$path" unknown-age
      continue
    }
    age=$(((now - created) / 86400))
    ((age >= stale_days)) || continue
    ((old_count += 1))

    if [[ $dirty == true ]]; then
      keep "$path" dirty
      continue
    fi
    if has_live_claim "$path"; then
      keep "$path" claimed
      continue
    fi
    if [[ $detached == true ]]; then
      keep "$path" detached
      continue
    fi
    if [[ $state != integrated && $state != empty ]]; then
      keep "$path" not-integrated
      continue
    fi

    ((ready_count += 1))
    if [[ $apply == false ]]; then
      printf 'ready\t%s\tbranch=%s\tage_days=%d\tstate=%s\n' "$path" "$branch" "$age" "$state"
      continue
    fi

    current_head=$(git -C "$path" rev-parse HEAD 2>/dev/null || true)
    if [[ $current_head != "$head" ]]; then
      keep "$path" changed
      continue
    fi
    if [[ -n $(git -C "$path" status --porcelain=v1 --untracked-files=all 2>/dev/null) ]]; then
      keep "$path" dirty
      continue
    fi
    if has_live_claim "$path"; then
      keep "$path" claimed
      continue
    fi

    if removal=$("$worktrunk_bin" -C "$repository" remove --foreground --format=json "$path"); then
      ((removed_count += 1))
      printf 'removed\t%s\tbranch=%s\n' "$path" "$branch"
    else
      printf 'error\t%s\treason=worktrunk-remove-failed\n' "$path" >&2
      [[ -n $removal ]] && printf '%s\n' "$removal" >&2
      ((error_count += 1))
    fi
  done <<< "$rows"
}

while IFS= read -r -d '' git_dir; do
  repository=${git_dir%/.git}
  common_git_dir=$(git -C "$repository" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue
  [[ -z ${seen_repositories[$common_git_dir]:-} ]] || continue
  seen_repositories[$common_git_dir]=1
  inspect_repository "$repository"
done < <(
  find "$scan_root" -mindepth 2 -maxdepth 4 \
    \( -type d \( -name node_modules -o -name vendor -o -name .cache -o -name .local \) -prune \) -o \
    \( -type d -name .git -print0 \)
)

printf 'summary\trepos=%d\tworktrees=%d\told=%d\tready=%d\tremoved=%d\tkept=%d\terrors=%d\n' \
  "$repo_count" "$worktree_count" "$old_count" "$ready_count" "$removed_count" "$kept_count" "$error_count"

((error_count == 0))
