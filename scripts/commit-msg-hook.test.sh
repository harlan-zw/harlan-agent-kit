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
accepts 'feat(Nuxt): rename the module'
accepts 'feat(@harlan/agent-kit): widen the scope charset'

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

# A `## Scopes` table in GLOSSARY.md retires a scope and names its replacement.
cat > "$sandbox/pkg/inside/GLOSSARY.md" <<'GLOSSARY'
# Glossary

## Scopes

| Never | Use instead | Why |
| --- | --- | --- |
| `github-agent` | `agent` | One service, one word |
| worktrunk | worktrees | The tool is not the concept |

## Banned

| Never | Use instead | Why |
| --- | --- | --- |
| `ci` | `workflows` | This row sits outside Scopes and must not apply |
GLOSSARY
git -C "$sandbox/pkg/inside" add GLOSSARY.md >/dev/null 2>&1
git -C "$sandbox/pkg/inside" commit --quiet --message 'docs(agent): add the glossary' >/dev/null 2>&1

refuses 'fix(github-agent): read the review label'
refuses 'feat(worktrunk): seed the env file'
accepts 'fix(agent): read the review label'
accepts 'fix(worktrees): seed the env file'
# An unknown scope passes, because the table is a denylist and not an allowlist.
accepts 'fix(dashboard): show the queue depth'
# A ban outside the Scopes table must not reach commit scopes.
accepts 'chore(ci): keep four runners warm'

if grep -q 'Use `agent` instead' <(cd "$sandbox/pkg/inside" && printf 'fix(github-agent): x\n' > "$sandbox/msg" && bash "$sandbox/hooks/commit-msg" "$sandbox/msg" 2>&1); then
  pass 'names the replacement scope in the refusal'
else
  bad 'the refusal does not name the replacement scope'
fi

rm -f "$sandbox/pkg/inside/GLOSSARY.md"
git -C "$sandbox/pkg/inside" rm --quiet --cached GLOSSARY.md >/dev/null 2>&1 || true
git -C "$sandbox/pkg/inside" commit --quiet --message 'docs(agent): drop the glossary' >/dev/null 2>&1 || true
# With no GLOSSARY.md the scope rule does not fire at all.
accepts 'fix(github-agent): read the review label'

# A repository outside the trusted roots keeps its own rules.
if try_commit "$sandbox/elsewhere/outside" 'no convention here'; then
  pass 'ignores a repository outside ~/pkg and ~/sites'
else
  bad 'refused a commit outside the trusted roots'
fi

[ "$fail" -eq 0 ] || exit 1
printf '\nAll commit-msg hook checks passed.\n'
