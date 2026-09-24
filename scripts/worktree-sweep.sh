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
realpath_bin=$(command -v realpath 2>/dev/null || true)
gh_bin=$(command -v gh 2>/dev/null || true)
[[ -x $worktrunk_bin ]] || fail 'Worktrunk is not installed.'
[[ -x $jq_bin ]] || fail 'jq is not installed.'
[[ -x $realpath_bin ]] || fail 'realpath is not installed.'

now=$(date +%s)
repo_count=0
worktree_count=0
old_count=0
ready_count=0
removed_count=0
kept_count=0
error_count=0
declare -A seen_repositories=()

# Fetches must not wait for an interactive credential prompt in the daily service.
fetch_origin() {
  GIT_TERMINAL_PROMPT=0 timeout --signal=TERM --kill-after=5s 60s \
    git -C "$1" -c credential.interactive=never fetch --quiet --no-write-fetch-head origin "${@:2}"
}

github_repository_for() {
  local url
  url=$(git -C "$1" remote get-url origin 2>/dev/null) || return 1
  if [[ $url =~ ^(https://github.com/|git@github.com:|ssh://git@github.com/)([^/]+/[^/]+)$ ]]; then
    printf '%s\n' "${BASH_REMATCH[2]%.git}"
  else
    return 1
  fi
}

# Git cannot recognise an old squash merge after later edits touch the same files.
# A merged pull request supplies the missing link between source and destination.
is_github_integrated() {
  local repository=$1 head=$2 branch=$3 slug=$4 response entries number pr_head merge base destination
  [[ -n $slug ]] || return 1
  if [[ ! -x $gh_bin ]]; then
    record_error "$repository" github-unavailable
    return 1
  fi
  if ! response=$(timeout --signal=TERM --kill-after=5s 60s "$gh_bin" api --hostname github.com graphql \
    -F owner="${slug%/*}" -F name="${slug#*/}" -F branch="$branch" \
    -f query='query($owner:String!,$name:String!,$branch:String!) {
      repository(owner:$owner,name:$name) {
        pullRequests(headRefName:$branch,first:100,orderBy:{field:UPDATED_AT,direction:DESC}) {
          pageInfo { hasNextPage }
          nodes { number state headRefOid headRepository { nameWithOwner }
            baseRepository { nameWithOwner } baseRefName mergeCommit { oid } }
        }
      }
    }'); then
    record_error "$repository" github-query-failed
    return 1
  fi
  # Incomplete history must never hide an open pull request using this branch.
  if ! "$jq_bin" -e '.errors == null and
    .data.repository.pullRequests.pageInfo.hasNextPage == false and
    (.data.repository.pullRequests.nodes | type == "array")' <<< "$response" >/dev/null; then
    record_error "$repository" github-history-incomplete
    return 1
  fi
  if "$jq_bin" -e '.data.repository.pullRequests.nodes[] |
    select(.state == "OPEN")' <<< "$response" >/dev/null; then
    return 1
  fi
  entries=$("$jq_bin" -r --arg slug "$slug" '.data.repository.pullRequests.nodes[] |
    select(.state == "MERGED" and .baseRepository.nameWithOwner == $slug and .mergeCommit.oid != null) |
    [.number, .headRefOid, .mergeCommit.oid, .baseRefName] | @tsv' <<< "$response") || return 1
  while IFS=$'\t' read -r number pr_head merge base; do
    [[ $number =~ ^[0-9]+$ && $pr_head =~ ^[0-9a-f]{40}$ && $merge =~ ^[0-9a-f]{40}$ ]] || continue
    git check-ref-format "refs/heads/$base" >/dev/null 2>&1 || continue
    [[ $branch != "$base" ]] || continue
    if ! git -C "$repository" cat-file -e "$pr_head^{commit}" 2>/dev/null; then
      fetch_origin "$repository" "refs/pull/$number/head" || continue
    fi
    git -C "$repository" merge-base --is-ancestor "$head" "$pr_head" 2>/dev/null || continue
    # All origin heads were fetched and pruned before inspection. Never fall back
    # to a local branch when the pull request's destination has been deleted.
    destination="refs/remotes/origin/$base"
    git -C "$repository" merge-base --is-ancestor "$merge" "$destination" 2>/dev/null || continue
    return 0
  done <<< "$entries"
  return 1
}

created_time_for() {
  local path=$1 created
  created=$(stat -c %W -- "$path/.git" 2>/dev/null || printf '0\n')
  ((created > 0)) || created=$(stat -c %Y -- "$path/.git" 2>/dev/null || printf '0\n')
  printf '%s\n' "$created"
}

default_target_for() {
  local repository=$1 remote_head primary_branch
  remote_head=$(git -C "$repository" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null || true)
  if [[ -n $remote_head ]] && git -C "$repository" show-ref --verify --quiet "$remote_head"; then
    printf '%s\n' "$remote_head"
    return 0
  fi
  if git -C "$repository" show-ref --verify --quiet refs/remotes/origin/main; then
    printf '%s\n' refs/remotes/origin/main
    return 0
  fi
  if git -C "$repository" show-ref --verify --quiet refs/heads/main; then
    printf '%s\n' refs/heads/main
    return 0
  fi
  primary_branch=$(git -C "$repository" symbolic-ref --quiet HEAD 2>/dev/null || true)
  [[ -n $primary_branch ]] || return 1
  git -C "$repository" show-ref --verify --quiet "$primary_branch" || return 1
  printf '%s\n' "$primary_branch"
}

is_integrated() {
  local repository=$1 head=$2 target=$3 head_tree target_tree merged_tree
  if git -C "$repository" merge-base --is-ancestor "$head" "$target" 2>/dev/null; then
    return 0
  fi
  if git -C "$repository" diff --quiet "$target...$head" -- 2>/dev/null; then
    return 0
  fi
  head_tree=$(git -C "$repository" rev-parse "$head^{tree}" 2>/dev/null) || return 1
  target_tree=$(git -C "$repository" rev-parse "$target^{tree}" 2>/dev/null) || return 1
  if [[ $head_tree == "$target_tree" ]]; then
    return 0
  fi
  merged_tree=$(git -C "$repository" merge-tree --write-tree "$target" "$head" 2>/dev/null) || return 1
  [[ $merged_tree == "$target_tree" ]]
}

has_live_claim() {
  local path=$1 common_git_dir claim
  common_git_dir=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  for claim in "$common_git_dir"/harlan-agent-kit/worktree-claims/*.json; do
    [[ -f $claim ]] || continue
    if "$jq_bin" -e --arg path "$("$realpath_bin" "$path")" --argjson now "$now" \
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

record_error() {
  local path=$1 reason=$2
  printf 'error\t%s\treason=%s\n' "$path" "$reason" >&2
  ((error_count += 1))
}

inspect_repository() {
  local repository=$1 field path='' head='' branch='' locked=false primary=true
  local target created age status current_head removal i slug proof
  local -a paths=() heads=() branches=() locked_flags=()

  ((repo_count += 1))
  while IFS= read -r -d '' field; do
    if [[ -z $field ]]; then
      if [[ $primary == true ]]; then
        primary=false
      elif [[ -n $path && -e $path/.git && $head =~ ^[0-9a-f]{40}$ ]]; then
        paths+=("$path")
        heads+=("$head")
        branches+=("$branch")
        locked_flags+=("$locked")
        ((worktree_count += 1))
      fi
      path=''
      head=''
      branch=''
      locked=false
      continue
    fi

    case "$field" in
      'worktree '*) path=${field#worktree } ;;
      'HEAD '*) head=${field#HEAD } ;;
      'branch refs/heads/'*) branch=${field#branch refs/heads/} ;;
      locked*) locked=true ;;
    esac
  done < <(git -C "$repository" worktree list --porcelain -z 2>/dev/null)

  ((${#paths[@]})) || return
  # Local-only repositories have no remote integration evidence to refresh.
  if ! git -C "$repository" remote get-url origin >/dev/null 2>&1; then
    for path in "${paths[@]}"; do
      keep "$path" no-origin
    done
    return
  fi
  if ! fetch_origin "$repository" --prune '+refs/heads/*:refs/remotes/origin/*'; then
    record_error "$repository" fetch-failed
    return
  fi
  slug=$(github_repository_for "$repository") || slug=''
  target=$(default_target_for "$repository") || {
    record_error "$repository" default-branch-missing
    return
  }

  for i in "${!paths[@]}"; do
    path=${paths[$i]}
    head=${heads[$i]}
    branch=${branches[$i]}
    locked=${locked_flags[$i]}
    created=$(created_time_for "$path")
    if ((created <= 0)); then
      keep "$path" unknown-age
      continue
    fi
    age=$(((now - created) / 86400))
    ((age >= stale_days)) || continue
    ((old_count += 1))

    if ! status=$(git -C "$path" status --porcelain=v1 --untracked-files=all 2>/dev/null); then
      record_error "$path" status-failed
      continue
    fi
    if [[ -n $status ]]; then
      keep "$path" dirty
      continue
    fi
    if has_live_claim "$path"; then
      keep "$path" claimed
      continue
    fi
    if [[ $locked == true ]]; then
      keep "$path" locked
      continue
    fi
    if [[ -z $branch ]]; then
      keep "$path" detached
      continue
    fi
    proof=git
    if ! is_integrated "$repository" "$head" "$target"; then
      proof=github
    fi
    if [[ $proof == github ]] && ! is_github_integrated "$repository" "$head" "$branch" "$slug"; then
      keep "$path" not-integrated
      continue
    fi

    ((ready_count += 1))
    if [[ $apply == false ]]; then
      printf 'ready\t%s\tbranch=%s\tage_days=%d\tstate=integrated\n' "$path" "$branch" "$age"
      continue
    fi

    current_head=$(git -C "$path" rev-parse HEAD 2>/dev/null || true)
    if [[ $current_head != "$head" ]]; then
      keep "$path" changed
      continue
    fi
    if ! status=$(git -C "$path" status --porcelain=v1 --untracked-files=all 2>/dev/null); then
      record_error "$path" status-failed
      continue
    fi
    if [[ -n $status ]]; then
      keep "$path" dirty
      continue
    fi
    if has_live_claim "$path"; then
      keep "$path" claimed
      continue
    fi
    if [[ $proof == git ]] && ! is_integrated "$repository" "$head" "$target"; then
      keep "$path" changed
      continue
    fi
    if [[ $proof == github ]] && ! is_github_integrated "$repository" "$head" "$branch" "$slug"; then
      keep "$path" changed
      continue
    fi

    # Remote checks can take time. Recheck the local head and claim at removal.
    if [[ $(git -C "$path" rev-parse HEAD 2>/dev/null) != "$head" ||
      $(git -C "$path" symbolic-ref --quiet --short HEAD 2>/dev/null) != "$branch" ]]; then
      keep "$path" changed
      continue
    fi
    if has_live_claim "$path"; then
      keep "$path" claimed
      continue
    fi

    if removal=$("$worktrunk_bin" -C "$repository" remove --foreground --format=json "$branch"); then
      ((removed_count += 1))
      printf 'removed\t%s\tbranch=%s\n' "$path" "$branch"
    else
      record_error "$path" worktrunk-remove-failed
      [[ -n $removal ]] && printf '%s\n' "$removal" >&2
    fi
  done
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
