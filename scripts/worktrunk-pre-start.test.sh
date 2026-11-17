#!/usr/bin/env bash
# Verifies the worktree install keeps scripts off, except for an allowlisted git-hosted build.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

export HOME="$test_root/home"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_NOSYSTEM=1
unset HARLAN_GITHUB_AGENT XDG_CONFIG_HOME WORKTRUNK_CONFIG_PATH
mkdir -p "$HOME" "$test_root/bin"
git config --global init.defaultBranch main
bash "$script_dir/worktrunk-config.sh" update >/dev/null

# A fake pnpm records the install arguments of each worktree.
cat >"$test_root/bin/pnpm" <<'FAKE_PNPM'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$PWD/.pnpm-args"
FAKE_PNPM
chmod +x "$test_root/bin/pnpm"
export PATH="$test_root/bin:$PATH"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

# Creates a primary clone whose workspace file allowlists the given build.
install_args() {
  local name=$1 allowed=$2 value=$3
  local root="$test_root/$name"
  git init --quiet --bare "$root/origin.git"
  git clone --quiet "$root/origin.git" "$root/repo" 2>/dev/null
  printf 'lockfileVersion: 9.0\n' >"$root/repo/pnpm-lock.yaml"
  printf 'allowBuilds:\n  %s: %s\n  esbuild: false\ncatalog:\n  vue: ^3.5.0\n' "$allowed" "$value" >"$root/repo/pnpm-workspace.yaml"
  git -C "$root/repo" add pnpm-lock.yaml pnpm-workspace.yaml
  git -C "$root/repo" commit --quiet -m first
  git -C "$root/repo" push --quiet origin main
  wt -C "$root/repo" --config "$HOME/.config/worktrunk/config.toml" -y switch --create task --base origin/main --no-cd 2>"$root/stderr" \
    || fail "$name: the switch failed: $(cat "$root/stderr")"
  [ -f "$root/repo.task/.pnpm-args" ] || fail "$name: the worktree install did not run."
  cat "$root/repo.task/.pnpm-args"
}

# A registry build keeps every script off.
args=$(install_args registry "node-pty" true)
[[ "$args" == *--ignore-scripts* ]] || fail "registry: the install ran scripts: $args"

# --ignore-scripts would leave a git-hosted dependency unbuilt, so the repository's allowlist wins.
args=$(install_args git-hosted "'@harlan-zw/octorun@https://codeload.github.com/harlan-zw/octorun/tar.gz/f1eaeb53'" true)
[[ "$args" != *--ignore-scripts* ]] || fail "git-hosted: the install skipped the allowlisted build: $args"
[[ "$args" == *--frozen-lockfile* ]] || fail "git-hosted: the install dropped --frozen-lockfile: $args"

# A git-hosted entry set to false is no allowlist.
args=$(install_args git-denied "'@acme/tool@https://codeload.github.com/acme/tool/tar.gz/abc'" false)
[[ "$args" == *--ignore-scripts* ]] || fail "git-denied: the install ran scripts: $args"

# A branch that adds a git-hosted entry cannot turn scripts on for itself: the primary checkout decides.
root="$test_root/branch-only"
git init --quiet --bare "$root/origin.git"
git clone --quiet "$root/origin.git" "$root/repo" 2>/dev/null
printf 'lockfileVersion: 9.0\n' >"$root/repo/pnpm-lock.yaml"
printf 'allowBuilds:\n  esbuild: false\n' >"$root/repo/pnpm-workspace.yaml"
git -C "$root/repo" add pnpm-lock.yaml pnpm-workspace.yaml
git -C "$root/repo" commit --quiet -m first
git -C "$root/repo" push --quiet origin main
git -C "$root/repo" switch --quiet -c evil
printf 'allowBuilds:\n  %s: true\n' "'@acme/tool@https://codeload.github.com/acme/tool/tar.gz/abc'" >"$root/repo/pnpm-workspace.yaml"
git -C "$root/repo" commit --quiet -am 'turn scripts on'
git -C "$root/repo" push --quiet origin evil
git -C "$root/repo" switch --quiet main
wt -C "$root/repo" --config "$HOME/.config/worktrunk/config.toml" -y switch --create task --base origin/evil --no-cd 2>"$root/stderr" \
  || fail "branch-only: the switch failed: $(cat "$root/stderr")"
args=$(cat "$root/repo.task/.pnpm-args")
[[ "$args" == *--ignore-scripts* ]] || fail "branch-only: the branch turned scripts on: $args"

printf '%s\n' 'Worktrunk pre-start tests passed'
