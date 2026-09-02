#!/usr/bin/env bash

set -euo pipefail

repository_home=${HARLAN_REPOSITORY_ENV_HOME:-$HOME}
manifest=${HARLAN_REPOSITORY_ENV_MANIFEST:-$HOME/.config/harlan-agent-kit/repository-env-files}
declare -a repository_files=()
declare -a repository_ids=()
resolved_repository_root=''
resolved_repository_id=''

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

load_manifest() {
  local repository_id relative_path extra
  declare -A seen=()

  [ -f "$manifest" ] || fail "The repository environment manifest does not exist: $manifest"
  while read -r repository_id relative_path extra || [ -n "${repository_id:-}" ]; do
    case "${repository_id:-}" in
      ''|'#'*) continue ;;
    esac
    [ -n "${relative_path:-}" ] && [ -z "${extra:-}" ] \
      || fail "The repository environment manifest has an invalid line."
    [[ "$repository_id" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] \
      || fail "The repository environment manifest has an invalid GitHub repository: $repository_id"
    if [[ ! "$relative_path" =~ ^(pkg|sites)/[A-Za-z0-9._/-]+$ ]] \
      || [[ "/$relative_path/" == *'/../'* ]] \
      || [[ "/$relative_path/" == *'/./'* ]] \
      || [[ "$relative_path" == *'//'* ]] \
      || [[ "$relative_path" == */ ]]; then
      fail "The repository environment manifest has an unsafe path: $relative_path"
    fi
    [ -z "${seen[$relative_path]:-}" ] || fail "The repository environment manifest repeats a path: $relative_path"
    seen[$relative_path]=1
    repository_ids+=("${repository_id,,}")
    repository_files+=("$relative_path")
  done < "$manifest"
  [ "${#repository_files[@]}" -gt 0 ] || fail "The repository environment manifest is empty."
}

read_repository_id() {
  local root=$1
  local remote
  remote=$(git -C "$root" remote get-url origin 2>/dev/null) \
    || fail "The repository environment repository has no origin remote: $root"
  case "$remote" in
    git@github.com:*) resolved_repository_id=${remote#git@github.com:} ;;
    https://github.com/*) resolved_repository_id=${remote#https://github.com/} ;;
    ssh://git@github.com/*) resolved_repository_id=${remote#ssh://git@github.com/} ;;
    *) fail "The repository environment repository does not use GitHub: $root" ;;
  esac
  resolved_repository_id=${resolved_repository_id%.git}
  resolved_repository_id=${resolved_repository_id,,}
}

normalize_home() {
  [ -d "$repository_home" ] || fail "The repository environment home does not exist: $repository_home"
  repository_home=$(realpath "$repository_home")
}

repository_root_for() {
  local target=$1
  local expected_repository_id=$2
  local parent root
  parent=$(dirname "$target")
  [ -d "$parent" ] || fail "The repository environment parent does not exist: $parent"
  root=$(git -C "$parent" rev-parse --show-toplevel 2>/dev/null) \
    || fail "The repository environment path is outside a Git repository: $target"
  root=$(realpath "$root")
  case "$root" in
    "$repository_home/pkg/"*|"$repository_home/sites/"*) ;;
    *) fail "The repository environment path is outside a trusted root: $target" ;;
  esac
  read_repository_id "$root"
  [ "$resolved_repository_id" = "$expected_repository_id" ] \
    || fail "The repository environment path belongs to another GitHub repository: $target"
  resolved_repository_root=$root
}

require_ignored_target() {
  local target=$1
  local expected_repository_id=$2
  local root relative
  repository_root_for "$target" "$expected_repository_id"
  root=$resolved_repository_root
  relative=${target#"$root/"}
  [ "$relative" != "$target" ] || fail "The repository environment path is outside its repository: $target"
  git -C "$root" check-ignore --quiet -- "$relative" \
    || fail "Git does not ignore the repository environment path: $target"
  resolved_repository_root=$root
}

require_safe_link_target() {
  local link_target=$1
  local link_path=$2
  local repository_root=$3
  local resolved
  [ -n "$link_target" ] || fail "The repository environment symlink has no target: $link_path"
  [[ "$link_target" != /* ]] || fail "The repository environment symlink must use a relative target: $link_path"
  resolved=$(realpath -m "$(dirname "$link_path")/$link_target")
  case "$resolved" in
    "$repository_root"|"$repository_root/"*) ;;
    *) fail "The repository environment symlink leaves its repository: $link_path" ;;
  esac
}

require_safe_link() {
  local link_path=$1
  local repository_root=$2
  local link_target
  link_target=$(readlink "$link_path")
  require_safe_link_target "$link_target" "$link_path" "$repository_root"
}

validate_source_entry() {
  local relative_path=$1
  local expected_repository_id=$2
  local source_path root resolved
  source_path="$repository_home/$relative_path"
  if [ -L "$source_path" ]; then
    require_ignored_target "$source_path" "$expected_repository_id"
    root=$resolved_repository_root
    require_safe_link "$source_path" "$root"
    resolved=$(realpath "$source_path")
    [ -f "$resolved" ] || fail "The repository environment symlink target is not a regular file: $source_path"
    return
  fi
  [ -f "$source_path" ] || fail "The repository environment source is not a regular file: $source_path"
  require_ignored_target "$source_path" "$expected_repository_id"
}

validate_install_entry() {
  local stage=$1
  local relative_path=$2
  local expected_repository_id=$3
  local staged_path target_path root staged_resolved link_target
  staged_path="$stage/$relative_path"
  target_path="$repository_home/$relative_path"
  require_ignored_target "$target_path" "$expected_repository_id"
  root=$resolved_repository_root
  [ ! -d "$target_path" ] || fail "The repository environment target is a directory: $target_path"
  if [ -L "$staged_path" ]; then
    link_target=$(readlink "$staged_path")
    require_safe_link_target "$link_target" "$target_path" "$root"
    staged_resolved=$(realpath "$staged_path")
    [ -f "$staged_resolved" ] || fail "The staged repository environment symlink target is missing: $staged_path"
    return
  fi
  [ -f "$staged_path" ] || fail "The staged repository environment file is missing: $staged_path"
}

install_entry() {
  local source_path=$1
  local target_path=$2
  local next_path link_target
  next_path="$target_path.harlan-env-next.$$"
  [ ! -e "$next_path" ] && [ ! -L "$next_path" ] \
    || fail "The repository environment staging path already exists: $next_path"
  mkdir -p "$(dirname "$target_path")"
  if [ -L "$source_path" ]; then
    link_target=$(readlink "$source_path")
    ln -s -- "$link_target" "$next_path"
  else
    install -m 600 -- "$source_path" "$next_path"
  fi
  if ! mv -fT -- "$next_path" "$target_path"; then
    unlink "$next_path" 2>/dev/null || true
    fail "The repository environment target could not be replaced: $target_path"
  fi
}

validate_source() {
  local index
  for index in "${!repository_files[@]}"; do
    validate_source_entry "${repository_files[$index]}" "${repository_ids[$index]}"
  done
  printf 'Repository environment is ready: %s files.\n' "${#repository_files[@]}"
}

install_staged() {
  local stage=$1
  local index relative_path
  [ -d "$stage" ] || fail "The repository environment stage does not exist: $stage"
  stage=$(realpath "$stage")
  for index in "${!repository_files[@]}"; do
    validate_install_entry "$stage" "${repository_files[$index]}" "${repository_ids[$index]}"
  done
  for relative_path in "${repository_files[@]}"; do
    install_entry "$stage/$relative_path" "$repository_home/$relative_path"
  done
  printf 'Repository environment synced: %s files.\n' "${#repository_files[@]}"
}

seed_worktree() {
  local primary=$1
  local worktree=$2
  local primary_relative relative_path environment_relative source_path target_path target_root link_target index
  local copied=0
  declare -a matching_indices=()

  primary=$(realpath "$primary")
  worktree=$(realpath "$worktree")
  case "$primary" in
    "$repository_home/pkg/"*|"$repository_home/sites/"*) ;;
    *) return ;;
  esac
  [ "$(git -C "$primary" rev-parse --show-toplevel 2>/dev/null)" = "$primary" ] \
    || fail "The primary worktree path is not a repository root: $primary"
  [ "$(git -C "$worktree" rev-parse --show-toplevel 2>/dev/null)" = "$worktree" ] \
    || fail "The destination worktree path is not a repository root: $worktree"
  primary_relative=${primary#"$repository_home/"}

  for index in "${!repository_files[@]}"; do
    relative_path=${repository_files[$index]}
    case "$relative_path" in
      "$primary_relative/"*) matching_indices+=("$index") ;;
    esac
  done
  [ "${#matching_indices[@]}" -gt 0 ] || return 0

  for index in "${matching_indices[@]}"; do
    relative_path=${repository_files[$index]}
    validate_source_entry "$relative_path" "${repository_ids[$index]}"
    environment_relative=${relative_path#"$primary_relative/"}
    source_path="$repository_home/$relative_path"
    target_path="$worktree/$environment_relative"
    require_ignored_target "$target_path" "${repository_ids[$index]}"
    target_root=$resolved_repository_root
    [ "$target_root" = "$worktree" ] || fail "The repository environment target belongs to another repository: $target_path"
    [ ! -d "$target_path" ] || fail "The repository environment target is a directory: $target_path"
    if [ -L "$source_path" ]; then
      link_target=$(readlink "$source_path")
      require_safe_link_target "$link_target" "$target_path" "$worktree"
    fi
  done

  for index in "${matching_indices[@]}"; do
    relative_path=${repository_files[$index]}
    environment_relative=${relative_path#"$primary_relative/"}
    source_path="$repository_home/$relative_path"
    target_path="$worktree/$environment_relative"
    if [ -e "$target_path" ] || [ -L "$target_path" ]; then
      continue
    fi
    install_entry "$source_path" "$target_path"
    copied=$((copied + 1))
  done
  printf 'Repository environment seeded: %s files.\n' "$copied"
}

list_paths() {
  printf '%s\n' "${repository_files[@]}"
}

normalize_home
load_manifest

command_name=${1:-}
case "$command_name" in
  validate-source)
    [ "$#" -eq 1 ] || fail "Usage: harlan-repository-env validate-source"
    validate_source
    ;;
  list-paths)
    [ "$#" -eq 1 ] || fail "Usage: harlan-repository-env list-paths"
    list_paths
    ;;
  install-staged)
    [ "$#" -eq 2 ] || fail "Usage: harlan-repository-env install-staged STAGE"
    install_staged "$2"
    ;;
  seed)
    [ "$#" -eq 3 ] || fail "Usage: harlan-repository-env seed PRIMARY WORKTREE"
    seed_worktree "$2" "$3"
    ;;
  *)
    fail "Use validate-source, list-paths, install-staged, or seed."
    ;;
esac
