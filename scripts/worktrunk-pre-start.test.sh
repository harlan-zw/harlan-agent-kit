#!/usr/bin/env bash
# Exercise real pnpm lifecycle boundaries through Worktrunk setup.
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT
export HOME="$test_root/home"
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_NOSYSTEM=1
unset HARLAN_GITHUB_AGENT XDG_CONFIG_HOME WORKTRUNK_CONFIG_PATH
mkdir -p "$HOME" "$test_root/approved" "$test_root/unrelated" "$test_root/repo"
git config --global init.defaultBranch main
git config --global core.hooksPath /dev/null
bash "$script_dir/worktrunk-config.sh" update >/dev/null

fail() { printf '%s\n' "$1" >&2; exit 1; }

# An unrelated dependency becomes approved only on the branch.
cat > "$test_root/unrelated/package.json" <<JSON
{"name":"unrelated","version":"1.0.0","scripts":{"postinstall":"touch $test_root/unrelated-ran"}}
JSON
tar -czf "$test_root/unrelated.tgz" -C "$test_root" unrelated
# The approved git package needs preparation before consumers can load it.
# Its build tools must also install without lifecycle scripts.
cat > "$test_root/approved/package.json" <<JSON
{"name":"@fixture/approved","version":"1.0.0","main":"dist.cjs","devDependencies":{"unrelated":"file:$test_root/unrelated.tgz"},"scripts":{"prepare":"node -e \"require('fs').writeFileSync('dist.cjs', 'module.exports = 21')\"","prepack":"node -e \"require('fs').writeFileSync('dist.cjs', 'module.exports = ' + require('./dist.cjs') * 2)\""}}
JSON
printf 'allowBuilds:\n  "unrelated@file:%s/unrelated.tgz": true\n' "$test_root" > "$test_root/approved/pnpm-workspace.yaml"
git -C "$test_root/approved" init --quiet
git -C "$test_root/approved" add package.json pnpm-workspace.yaml
git -C "$test_root/approved" commit --quiet -m fixture
revision=$(git -C "$test_root/approved" rev-parse HEAD)
spec="git+file://$test_root/approved#$revision"
cat > "$test_root/repo/package.json" <<JSON
{"private":true,"packageManager":"pnpm@11.22.0","dependencies":{"@fixture/approved":"$spec","unrelated":"file:$test_root/unrelated.tgz"}}
JSON
printf 'allowBuilds:\n  "@fixture/approved@%s": true\n  "unrelated@file:../unrelated.tgz": false\n' "$spec" > "$test_root/repo/pnpm-workspace.yaml"
(cd "$test_root/repo" && pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile --reporter=append-only)
git init --quiet --bare "$test_root/origin.git"
git -C "$test_root/repo" init --quiet
git -C "$test_root/repo" remote add origin "$test_root/origin.git"
git -C "$test_root/repo" add package.json pnpm-lock.yaml pnpm-workspace.yaml
git -C "$test_root/repo" commit --quiet -m fixture
git -C "$test_root/repo" push --quiet origin main
git -C "$test_root/repo" switch --quiet -c evil
cat > "$test_root/repo/package.json" <<JSON
{"private":true,"packageManager":"pnpm@11.22.0","scripts":{"postinstall":"touch $test_root/root-ran"},"dependencies":{"@fixture/approved":"$spec","unrelated":"file:$test_root/unrelated.tgz"}}
JSON
printf 'allowBuilds:\n  "@fixture/approved@%s": true\n  "unrelated@file:../unrelated.tgz": true\npackages:\n  - child\n' "$spec" > "$test_root/repo/pnpm-workspace.yaml"
mkdir "$test_root/repo/child"
printf '{"name":"child","scripts":{"postinstall":"touch %s/child-ran"}}\n' "$test_root" > "$test_root/repo/child/package.json"
printf 'require("fs").writeFileSync("%s/pnpmfile-ran", "ran"); module.exports = {}\n' "$test_root" > "$test_root/repo/.pnpmfile.cjs"
(cd "$test_root/repo" && pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile --reporter=append-only)
git -C "$test_root/repo" add package.json pnpm-workspace.yaml pnpm-lock.yaml child .pnpmfile.cjs
git -C "$test_root/repo" commit --quiet -m attack
git -C "$test_root/repo" push --quiet origin evil
git -C "$test_root/repo" switch --quiet main
setup_status=0
wt -C "$test_root/repo" --config "$HOME/.config/worktrunk/config.toml" -y switch --create task --base origin/evil --no-cd || setup_status=$?
[ ! -e "$test_root/root-ran" ] || fail 'The branch root postinstall executed.'
[ ! -e "$test_root/child-ran" ] || fail 'The branch workspace postinstall executed.'
[ ! -e "$test_root/unrelated-ran" ] || fail 'The unrelated dependency postinstall executed.'
[ ! -e "$test_root/pnpmfile-ran" ] || fail 'The branch pnpmfile executed.'
[ "$setup_status" = 0 ] || fail "Worktrunk setup failed: $setup_status"
(cd "$test_root/repo.task" && node -e 'if (require("@fixture/approved") !== 42) process.exit(1)')

# Approval on the branch alone cannot prepare a git dependency.
printf 'allowBuilds:\n  "@fixture/approved@%s": false\n' "$spec" > "$test_root/repo/pnpm-workspace.yaml"
git -C "$test_root/repo" commit --quiet -am deny
git -C "$test_root/repo" push --quiet origin main
wt -C "$test_root/repo" --config "$HOME/.config/worktrunk/config.toml" -y switch --create denied --base origin/evil --no-cd
(cd "$test_root/repo.denied" && node -e 'if (require("@fixture/approved/package.json").version !== "1.0.0") process.exit(1); try { require("@fixture/approved"); process.exit(1) } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error }')

# A different revision never receives execution approval or the old build output.
printf 'allowBuilds:\n  "@fixture/approved@%s": true\n' "$spec" > "$test_root/repo/pnpm-workspace.yaml"
git -C "$test_root/repo" commit --quiet -am approve
git -C "$test_root/repo" push --quiet origin main
cat > "$test_root/approved/package.json" <<JSON
{"name":"@fixture/approved","version":"1.0.0","main":"dist.cjs","scripts":{"prepare":"touch $test_root/revision-ran"}}
JSON
git -C "$test_root/approved" commit --quiet -am attack
evil_revision=$(git -C "$test_root/approved" rev-parse HEAD)
git -C "$test_root/repo" switch --quiet evil
sed -i "s/$revision/$evil_revision/g" "$test_root/repo/package.json" "$test_root/repo/pnpm-workspace.yaml"
(cd "$test_root/repo" && pnpm install --lockfile-only --ignore-scripts --ignore-pnpmfile --reporter=append-only)
git -C "$test_root/repo" commit --quiet -am revision
git -C "$test_root/repo" push --quiet origin evil
git -C "$test_root/repo" switch --quiet main
wt -C "$test_root/repo" --config "$HOME/.config/worktrunk/config.toml" -y switch --create revision --base origin/evil --no-cd
(cd "$test_root/repo.revision" && node -e 'if (require("@fixture/approved/package.json").version !== "1.0.0") process.exit(1); try { require("@fixture/approved"); process.exit(1) } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error }')
for marker in root child unrelated pnpmfile revision; do
  [ ! -e "$test_root/$marker-ran" ] || fail "The unapproved $marker script executed."
done
printf '%s\n' 'Worktrunk pre-start tests passed'
