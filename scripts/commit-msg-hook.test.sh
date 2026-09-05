#!/usr/bin/env bash
# Exercises the commit-msg hook through a real git commit in a throwaway repo.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hook="$repo_root/agent-context/git-hooks/commit-msg"

fail=0
pass() { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }

[ -x "$hook" ] || { printf 'FAIL  The hook is not executable: %s\n' "$hook"; exit 1; }

# The hook only acts under ~/pkg and ~/sites, so HOME moves to the sandbox root.
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
export HOME="$sandbox"
mkdir -p "$sandbox/pkg/inside" "$sandbox/elsewhere/outside"
mkdir -p "$sandbox/hooks"
install -m 755 "$hook" "$sandbox/hooks/commit-msg"

start_repo() {
  local path=$1
  git -C "$path" init --quiet --initial-branch=main
  git -C "$path" config user.email 'test@example.com'
  git -C "$path" config user.name 'Test'
  git -C "$path" config core.hooksPath "$sandbox/hooks"
}

start_repo "$sandbox/pkg/inside"
start_repo "$sandbox/elsewhere/outside"

# Commits the subject and answers whether git accepted it.
try_commit() {
  local path=$1 subject=$2 file
  file="f$RANDOM"
  printf 'x\n' > "$path/$file"
  git -C "$path" add "$file" >/dev/null 2>&1
  git -C "$path" commit --quiet --message "$subject" >/dev/null 2>&1
}

accepts() {
  if try_commit "$sandbox/pkg/inside" "$1"; then pass "accepts: $1"; else bad "refused, should accept: $1"; fi
}

refuses() {
  if try_commit "$sandbox/pkg/inside" "$1"; then bad "accepted, should refuse: $1"; else pass "refuses: $1"; fi
}

accepts 'feat: add the widget'
accepts 'fix(store): keep the lease fence'
accepts 'chore(deps): raise vitest'
accepts 'feat!: drop the v1 route'
accepts 'refactor(agent/worker): split the scan turn'

refuses 'add the widget'
refuses 'Feat: add the widget'
refuses 'wip'
refuses 'feat add the widget'
refuses 'feat: end it with a period.'
refuses "feat: $(printf 'a%.0s' {1..80})"

# Git writes these subjects itself, so the hook must let them through.
accepts 'Merge origin/main into fix/thing'
accepts 'Revert "feat: add the widget"'
accepts 'fixup! feat: add the widget'

# A repository outside the trusted roots keeps its own rules.
if try_commit "$sandbox/elsewhere/outside" 'no convention here'; then
  pass 'ignores a repository outside ~/pkg and ~/sites'
else
  bad 'refused a commit outside the trusted roots'
fi

[ "$fail" -eq 0 ] || exit 1
printf '\nAll commit-msg hook checks passed.\n'
