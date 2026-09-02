#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tool="$script_dir/repository-env.sh"
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

source_home="$test_root/source"
source_repository="$source_home/sites/example"
manifest="$test_root/repository-env-files"
mkdir -p "$source_repository/app"
git init --quiet --initial-branch=main "$source_repository"
printf '%s\n' '.env' > "$source_repository/.gitignore"
printf '%s\n' 'SECRET=source' > "$source_repository/.env"
ln -s ../.env "$source_repository/app/.env"
git -C "$source_repository" add .gitignore
git -C "$source_repository" -c user.name=Fixture -c user.email=fixture@example.com commit --quiet -m fixture
git -C "$source_repository" remote add origin git@github.com:fixture/example.git
printf '%s\n' \
  'fixture/example sites/example/.env' \
  'fixture/example sites/example/app/.env' \
  > "$manifest"

HARLAN_REPOSITORY_ENV_HOME="$source_home" \
HARLAN_REPOSITORY_ENV_MANIFEST="$manifest" \
  bash "$tool" validate-source >/dev/null

remote_home="$test_root/remote"
remote_repository="$remote_home/sites/example"
stage="$test_root/stage"
mkdir -p "$remote_repository/app" "$stage/sites/example/app"
git init --quiet --initial-branch=main "$remote_repository"
printf '%s\n' '.env' > "$remote_repository/.gitignore"
git -C "$remote_repository" add .gitignore
git -C "$remote_repository" -c user.name=Fixture -c user.email=fixture@example.com commit --quiet -m fixture
git -C "$remote_repository" remote add origin https://github.com/fixture/example.git
cp -- "$source_repository/.env" "$stage/sites/example/.env"
cp --no-dereference -- "$source_repository/app/.env" "$stage/sites/example/app/.env"

HARLAN_REPOSITORY_ENV_HOME="$remote_home" \
HARLAN_REPOSITORY_ENV_MANIFEST="$manifest" \
  bash "$tool" install-staged "$stage" >/dev/null

cmp --silent "$source_repository/.env" "$remote_repository/.env"
test "$(stat -c %a "$remote_repository/.env")" = 600
test "$(readlink "$remote_repository/app/.env")" = ../.env

worktree="$source_home/sites/example.feature"
mkdir -p "$worktree/app"
git init --quiet --initial-branch=main "$worktree"
printf '%s\n' '.env' > "$worktree/.gitignore"
git -C "$worktree" add .gitignore
git -C "$worktree" -c user.name=Fixture -c user.email=fixture@example.com commit --quiet -m fixture
git -C "$worktree" remote add origin ssh://git@github.com/fixture/example.git

HARLAN_REPOSITORY_ENV_HOME="$source_home" \
HARLAN_REPOSITORY_ENV_MANIFEST="$manifest" \
  bash "$tool" seed "$source_repository" "$worktree" >/dev/null

cmp --silent "$source_repository/.env" "$worktree/.env"
test "$(stat -c %a "$worktree/.env")" = 600
test "$(readlink "$worktree/app/.env")" = ../.env

printf '%s\n' 'SECRET=worktree' > "$worktree/.env"
HARLAN_REPOSITORY_ENV_HOME="$source_home" \
HARLAN_REPOSITORY_ENV_MANIFEST="$manifest" \
  bash "$tool" seed "$source_repository" "$worktree" >/dev/null
grep -Fx 'SECRET=worktree' "$worktree/.env" >/dev/null

unlisted_primary="$source_home/pkg/unlisted"
unlisted_worktree="$source_home/pkg/unlisted.feature"
for repository in "$unlisted_primary" "$unlisted_worktree"; do
  git init --quiet --initial-branch=main "$repository"
  git -C "$repository" -c user.name=Fixture -c user.email=fixture@example.com commit --quiet --allow-empty -m fixture
done
HARLAN_REPOSITORY_ENV_HOME="$source_home" \
HARLAN_REPOSITORY_ENV_MANIFEST="$manifest" \
  bash "$tool" seed "$unlisted_primary" "$unlisted_worktree" >/dev/null

printf '%s\n' 'fixture/example sites/example/missing.env' > "$test_root/missing-files"
if HARLAN_REPOSITORY_ENV_HOME="$source_home" \
  HARLAN_REPOSITORY_ENV_MANIFEST="$test_root/missing-files" \
  bash "$tool" validate-source >/dev/null 2>&1; then
  printf '%s\n' 'Repository environment accepted a missing source file.' >&2
  exit 1
fi

unignored_repository="$source_home/sites/unignored"
mkdir -p "$unignored_repository"
git init --quiet --initial-branch=main "$unignored_repository"
git -C "$unignored_repository" remote add origin git@github.com:fixture/unignored.git
printf '%s\n' 'SECRET=unignored' > "$unignored_repository/.env"
printf '%s\n' 'fixture/unignored sites/unignored/.env' > "$test_root/unignored-files"
if HARLAN_REPOSITORY_ENV_HOME="$source_home" \
  HARLAN_REPOSITORY_ENV_MANIFEST="$test_root/unignored-files" \
  bash "$tool" validate-source >/dev/null 2>&1; then
  printf '%s\n' 'Repository environment accepted a file that Git does not ignore.' >&2
  exit 1
fi

unlink "$source_repository/app/.env"
ln -s ../../../outside "$source_repository/app/.env"
if HARLAN_REPOSITORY_ENV_HOME="$source_home" \
  HARLAN_REPOSITORY_ENV_MANIFEST="$manifest" \
  bash "$tool" validate-source >/dev/null 2>&1; then
  printf '%s\n' 'Repository environment accepted a symlink outside its repository.' >&2
  exit 1
fi

printf '%s\n' 'fixture/example ../escape' > "$test_root/unsafe-files"
if HARLAN_REPOSITORY_ENV_HOME="$source_home" \
  HARLAN_REPOSITORY_ENV_MANIFEST="$test_root/unsafe-files" \
  bash "$tool" validate-source >/dev/null 2>&1; then
  printf '%s\n' 'Repository environment accepted an unsafe manifest path.' >&2
  exit 1
fi

printf '%s\n' 'fixture/other sites/example/.env' > "$test_root/wrong-repository-files"
if HARLAN_REPOSITORY_ENV_HOME="$source_home" \
  HARLAN_REPOSITORY_ENV_MANIFEST="$test_root/wrong-repository-files" \
  bash "$tool" validate-source >/dev/null 2>&1; then
  printf '%s\n' 'Repository environment accepted the wrong GitHub repository.' >&2
  exit 1
fi

printf '%s\n' 'Repository environment tests passed'
