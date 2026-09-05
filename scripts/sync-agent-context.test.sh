#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

test_home="$test_root/home"
calls="$test_root/calls"
mkdir -p "$test_home" "$test_root/bin"

# Project memory fixtures: one primary checkout, one wt worktree sibling, and
# one project directory that no checkout matches.
memory_root="$test_root/projects"
checkout_root="$test_root/pkg"
mkdir -p "$checkout_root/demo-pkg/.git" "$checkout_root/demo-pkg.feat-thing"
printf '%s\n' 'gitdir: /elsewhere' > "$checkout_root/demo-pkg.feat-thing/.git"
primary_slug=$(printf '%s' "$checkout_root/demo-pkg" | tr -c 'A-Za-z0-9' '-')
worktree_slug=$(printf '%s' "$checkout_root/demo-pkg.feat-thing" | tr -c 'A-Za-z0-9' '-')
mkdir -p "$memory_root/$primary_slug/memory" "$memory_root/$worktree_slug/memory" "$memory_root/-unrelated/memory"
printf '%s\n' '- [Deployment](deployment.md)' > "$memory_root/$primary_slug/memory/MEMORY.md"
printf '%s\n' '# Deployment' > "$memory_root/$primary_slug/memory/deployment.md"
printf '%s\n' '- [Worktree](worktree.md)' > "$memory_root/$worktree_slug/memory/MEMORY.md"
printf '%s\n' '- [Unrelated](unrelated.md)' > "$memory_root/-unrelated/memory/MEMORY.md"
export HARLAN_AGENT_CONTEXT_MEMORY_ROOT="$memory_root"
export HARLAN_AGENT_CONTEXT_CHECKOUT_ROOTS="$checkout_root"

HARLAN_AGENT_CONTEXT_HOME="$test_home" bash "$script_dir/sync-agent-context.sh" local >/dev/null

cmp "$memory_root/$primary_slug/memory/MEMORY.md" "$test_home/.claude/projects/$primary_slug/memory/MEMORY.md"
cmp "$memory_root/$primary_slug/memory/deployment.md" "$test_home/.claude/projects/$primary_slug/memory/deployment.md"
if [ -e "$test_home/.claude/projects/$worktree_slug" ]; then
  printf '%s\n' 'The sync copied memory for a wt worktree sibling.' >&2
  exit 1
fi
if [ -e "$test_home/.claude/projects/-unrelated" ]; then
  printf '%s\n' 'The sync copied memory for a project with no checkout.' >&2
  exit 1
fi

# A note the desktop deleted must not survive on the worker host.
printf '%s\n' '# Stale' > "$test_home/.claude/projects/$primary_slug/memory/stale.md"
HARLAN_AGENT_CONTEXT_HOME="$test_home" bash "$script_dir/sync-agent-context.sh" local >/dev/null
if [ -e "$test_home/.claude/projects/$primary_slug/memory/stale.md" ]; then
  printf '%s\n' 'The sync kept a note the desktop no longer has.' >&2
  exit 1
fi

cmp "$repo_root/agent-context/context.md" "$test_home/.claude/CLAUDE.md"
cmp "$repo_root/agent-context/context.md" "$test_home/.codex/AGENTS.md"
if rg -F '{{> context.md}}' "$test_home/.claude/CLAUDE.md" "$test_home/.codex/AGENTS.md" >/dev/null; then
  printf '%s\n' 'Installed Agent instructions contain a template tag.' >&2
  exit 1
fi
if rg -F 'Once work turns long with no name assigned' "$test_home/.claude/CLAUDE.md" "$test_home/.codex/AGENTS.md" >/dev/null; then
  printf '%s\n' 'Installed Agent instructions contain the chat rename rule.' >&2
  exit 1
fi

# Every hook plugin.json registers, plus the loader they source. The sync
# script derives this list, so a hook missing here never deployed.
opencode_hooks=(check-config.sh session-start.sh pnpm-only.sh wt-only.sh himalaya-read-only.sh pr-skill-only.sh merged-branch-guard.sh pre-commit-push.sh eslint.sh command-not-found.sh)
for hook_file in "${opencode_hooks[@]}"; do
  cmp "$repo_root/harlan-agent-kit/hooks/$hook_file" "$test_home/.local/share/harlan-agent-kit/hooks/$hook_file"
  if [ ! -x "$test_home/.local/share/harlan-agent-kit/hooks/$hook_file" ]; then
    printf '%s\n' "The installed hook is not executable: $hook_file" >&2
    exit 1
  fi
done
cmp "$repo_root/harlan-agent-kit/plugins/opencode/harlan-hooks.ts" "$test_home/.config/opencode/plugins/harlan-hooks.ts"
# The opencode plugin reads its hook list from the installed manifest.
cmp "$repo_root/harlan-agent-kit/.claude-plugin/plugin.json" \
  "$test_home/.local/share/harlan-agent-kit/.claude-plugin/plugin.json"

# The fake ssh answers a batched sha256sum from this basename to hash table.
opencode_hashes="$test_root/opencode-hashes"
: > "$opencode_hashes"
for hook_file in "${opencode_hooks[@]}"; do
  printf '%s %s\n' "$hook_file" \
    "$(/usr/bin/sha256sum "$repo_root/harlan-agent-kit/hooks/$hook_file" | cut -d' ' -f1)" >> "$opencode_hashes"
done
printf '%s %s\n' harlan-hooks.ts \
  "$(/usr/bin/sha256sum "$repo_root/harlan-agent-kit/plugins/opencode/harlan-hooks.ts" | cut -d' ' -f1)" >> "$opencode_hashes"
printf '%s %s\n' plugin.json \
  "$(/usr/bin/sha256sum "$repo_root/harlan-agent-kit/.claude-plugin/plugin.json" | cut -d' ' -f1)" >> "$opencode_hashes"
export HARLAN_AGENT_CONTEXT_TEST_OPENCODE_HASHES="$opencode_hashes"
export HARLAN_AGENT_CONTEXT_TEST_OPENCODE_BAD=''

claude_hash=$(/usr/bin/sha256sum "$test_home/.claude/CLAUDE.md" | cut -d' ' -f1)
codex_hash=$(/usr/bin/sha256sum "$test_home/.codex/AGENTS.md" | cut -d' ' -f1)
hook_hash=$(/usr/bin/sha256sum "$repo_root/agent-context/git-hooks/commit-msg" | cut -d' ' -f1)
export HARLAN_AGENT_CONTEXT_TEST_CALLS="$calls"
export HARLAN_AGENT_CONTEXT_TEST_CLAUDE_HASH="$claude_hash"
export HARLAN_AGENT_CONTEXT_TEST_CODEX_HASH="$codex_hash"
export HARLAN_AGENT_CONTEXT_TEST_HOOK_HASH="$hook_hash"

cat > "$test_root/bin/ssh" <<'FAKE_SSH'
#!/usr/bin/env bash
printf 'ssh %s\n' "$*" >> "$HARLAN_AGENT_CONTEXT_TEST_CALLS"
# Real ssh reads stdin unless it is given -n, and that is exactly how the
# memory loop lost every slug after the first. Copy that for the memory calls
# only. Draining every call would hang the ones made in command substitution,
# because their stdin is the caller's and nothing closes it.
if [[ "$1" != '-n' && ( "$*" == *"tar -C"* || "$*" == *"/memory'"* ) ]]; then cat >/dev/null; fi
if [[ "$*" == *CLAUDE.md.next*sha256sum* || "$*" == *sha256sum*CLAUDE.md.next* ]]; then printf '%s  CLAUDE.md.next\n' "$HARLAN_AGENT_CONTEXT_TEST_CLAUDE_HASH"; fi
if [[ "$*" == *AGENTS.md.next*sha256sum* || "$*" == *sha256sum*AGENTS.md.next* ]]; then printf '%s  AGENTS.md.next\n' "$HARLAN_AGENT_CONTEXT_TEST_CODEX_HASH"; fi
if [[ "$*" == *commit-msg.next*sha256sum* || "$*" == *sha256sum*commit-msg.next* ]]; then printf '%s  commit-msg.next\n' "$HARLAN_AGENT_CONTEXT_TEST_HOOK_HASH"; fi
# The opencode files are verified in one batched sha256sum, so answer per path.
if [[ "$*" == *"sha256sum "* && "$*" == *harlan-hooks.ts.next* ]]; then
  for token in $*; do
    case "$token" in
      *.next*)
        path=${token//\'/}
        name=$(basename "${path%.next}")
        if [ "$name" = "$HARLAN_AGENT_CONTEXT_TEST_OPENCODE_BAD" ]; then
          printf 'different  %s\n' "$path"
        else
          printf '%s  %s\n' "$(grep -m1 "^$name " "$HARLAN_AGENT_CONTEXT_TEST_OPENCODE_HASHES" | cut -d' ' -f2)" "$path"
        fi
        ;;
    esac
  done
fi
if [[ -n "$HARLAN_AGENT_CONTEXT_TEST_SSH_FAIL" && "$*" == *core.hooksPath* ]]; then exit 42; fi
FAKE_SSH
cat > "$test_root/bin/scp" <<'FAKE_SCP'
#!/usr/bin/env bash
printf 'scp %s\n' "$*" >> "$HARLAN_AGENT_CONTEXT_TEST_CALLS"
FAKE_SCP
chmod +x "$test_root/bin/ssh" "$test_root/bin/scp"

PATH="$test_root/bin:/usr/bin:/bin" \
  HARLAN_AGENT_CONTEXT_HOGWILD_HOST=hogwild \
  HARLAN_AGENT_CONTEXT_HOGWILD_HOME=/home/harlan \
  bash "$script_dir/sync-agent-context.sh" hogwild >/dev/null

grep -F 'hogwild:/home/harlan/.claude/CLAUDE.md.next' "$calls" >/dev/null
grep -F 'hogwild:/home/harlan/.codex/AGENTS.md.next' "$calls" >/dev/null
grep -F "mv '/home/harlan/.claude/CLAUDE.md.next' '/home/harlan/.claude/CLAUDE.md'" "$calls" >/dev/null
grep -F "mv '/home/harlan/.codex/AGENTS.md.next' '/home/harlan/.codex/AGENTS.md'" "$calls" >/dev/null
grep -F 'hogwild:/home/harlan/.config/git/hooks/commit-msg.next' "$calls" >/dev/null
grep -F "mv '/home/harlan/.config/git/hooks/commit-msg.next' '/home/harlan/.config/git/hooks/commit-msg'" "$calls" >/dev/null
grep -F "core.hooksPath '/home/harlan/.config/git/hooks'" "$calls" >/dev/null
for hook_file in "${opencode_hooks[@]}"; do
  grep -F "hogwild:/home/harlan/.local/share/harlan-agent-kit/hooks/$hook_file.next" "$calls" >/dev/null
  grep -F "mv '/home/harlan/.local/share/harlan-agent-kit/hooks/$hook_file.next' '/home/harlan/.local/share/harlan-agent-kit/hooks/$hook_file'" "$calls" >/dev/null
done
grep -F 'hogwild:/home/harlan/.config/opencode/plugins/harlan-hooks.ts.next' "$calls" >/dev/null

# Memory reaches Hogwild for the primary checkout only, over the tar fallback
# because the fake ssh reports no remote rsync.
grep -F "tar -C '/home/harlan/.claude/projects/$primary_slug/memory' -xzf -" "$calls" >/dev/null

# A second primary checkout proves the loop survives its own ssh calls. Without
# -n the first ssh eats the slug list and only one repository ever syncs.
second_slug=$(printf '%s' "$test_root/pkg/second" | tr -c 'A-Za-z0-9' '-')
mkdir -p "$test_root/pkg/second/.git" "$memory_root/$second_slug/memory"
printf '%s\n' '- [Second](second.md)' > "$memory_root/$second_slug/memory/MEMORY.md"
: > "$calls"
PATH="$test_root/bin:/usr/bin:/bin" \
  HARLAN_AGENT_CONTEXT_HOGWILD_HOST=hogwild \
  HARLAN_AGENT_CONTEXT_HOGWILD_HOME=/home/harlan \
  bash "$script_dir/sync-agent-context.sh" hogwild >/dev/null
for slug in "$primary_slug" "$second_slug"; do
  if ! grep -F "tar -C '/home/harlan/.claude/projects/$slug/memory' -xzf -" "$calls" >/dev/null; then
    printf '%s\n' "Hogwild memory sync stopped before $slug. An ssh call read the slug list." >&2
    exit 1
  fi
done
if grep -F "/home/harlan/.claude/projects/$worktree_slug" "$calls" >/dev/null; then
  printf '%s\n' 'Hogwild received memory for a wt worktree sibling.' >&2
  exit 1
fi
if grep -F '/home/harlan/.claude/projects/-unrelated' "$calls" >/dev/null; then
  printf '%s\n' 'Hogwild received memory for a project with no checkout.' >&2
  exit 1
fi
grep -F "mv '/home/harlan/.config/opencode/plugins/harlan-hooks.ts.next' '/home/harlan/.config/opencode/plugins/harlan-hooks.ts'" "$calls" >/dev/null
grep -F "chmod 644 '/home/harlan/.config/opencode/plugins/harlan-hooks.ts.next'" "$calls" >/dev/null
manifest_target=/home/harlan/.local/share/harlan-agent-kit/.claude-plugin/plugin.json
grep -F "hogwild:$manifest_target.next" "$calls" >/dev/null
grep -F "mv '$manifest_target.next' '$manifest_target'" "$calls" >/dev/null
grep -F "chmod 644 '$manifest_target.next'" "$calls" >/dev/null

# A hook added to plugin.json must reach both installs with no other edit.
fixture="$test_root/fixture"
mkdir -p "$fixture/scripts" "$fixture/harlan-agent-kit/hooks" \
  "$fixture/harlan-agent-kit/.claude-plugin" "$fixture/harlan-agent-kit/plugins/opencode"
cp "$repo_root/scripts/sync-agent-context.sh" "$repo_root/scripts/agent-context-hooks.sh" "$fixture/scripts/"
cp -r "$repo_root/agent-context" "$fixture/agent-context"
cp "$repo_root/harlan-agent-kit/hooks/"*.sh "$fixture/harlan-agent-kit/hooks/"
cp "$repo_root/harlan-agent-kit/plugins/opencode/harlan-hooks.ts" "$fixture/harlan-agent-kit/plugins/opencode/"
printf '%s\n' '#!/usr/bin/env bash' 'source "$(dirname "$0")/check-config.sh"' 'exit 0' \
  > "$fixture/harlan-agent-kit/hooks/proof-hook.sh"
jq '.hooks.PreToolUse[0].hooks += [{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/hooks/proof-hook.sh","timeout":7000}]' \
  "$repo_root/harlan-agent-kit/.claude-plugin/plugin.json" \
  > "$fixture/harlan-agent-kit/.claude-plugin/plugin.json"

fixture_home="$test_root/fixture-home"
mkdir -p "$fixture_home"
HARLAN_AGENT_CONTEXT_HOME="$fixture_home" bash "$fixture/scripts/sync-agent-context.sh" local >/dev/null
fixture_hooks_dir="$fixture_home/.local/share/harlan-agent-kit/hooks"
if [ ! -x "$fixture_hooks_dir/proof-hook.sh" ]; then
  printf '%s\n' 'A hook added to plugin.json did not reach the local install.' >&2
  exit 1
fi
if [ ! -x "$fixture_hooks_dir/check-config.sh" ]; then
  printf '%s\n' 'The config loader did not reach the local install.' >&2
  exit 1
fi
cmp "$fixture/harlan-agent-kit/.claude-plugin/plugin.json" \
  "$fixture_home/.local/share/harlan-agent-kit/.claude-plugin/plugin.json"

source "$repo_root/scripts/agent-context-hooks.sh"
mapfile -t fixture_hook_files < <(agent_context_installed_hooks \
  "$fixture/harlan-agent-kit/hooks" "$fixture/harlan-agent-kit/.claude-plugin/plugin.json")
fixture_hashes="$test_root/fixture-hashes"
: > "$fixture_hashes"
for hook_file in "${fixture_hook_files[@]}"; do
  printf '%s %s\n' "$hook_file" \
    "$(/usr/bin/sha256sum "$fixture/harlan-agent-kit/hooks/$hook_file" | cut -d' ' -f1)" >> "$fixture_hashes"
done
printf '%s %s\n' plugin.json \
  "$(/usr/bin/sha256sum "$fixture/harlan-agent-kit/.claude-plugin/plugin.json" | cut -d' ' -f1)" >> "$fixture_hashes"
printf '%s %s\n' harlan-hooks.ts \
  "$(/usr/bin/sha256sum "$fixture/harlan-agent-kit/plugins/opencode/harlan-hooks.ts" | cut -d' ' -f1)" >> "$fixture_hashes"

: > "$calls"
PATH="$test_root/bin:/usr/bin:/bin" \
  HARLAN_AGENT_CONTEXT_TEST_OPENCODE_HASHES="$fixture_hashes" \
  HARLAN_AGENT_CONTEXT_HOGWILD_HOST=hogwild \
  HARLAN_AGENT_CONTEXT_HOGWILD_HOME=/home/harlan \
  bash "$fixture/scripts/sync-agent-context.sh" hogwild >/dev/null
proof_target=/home/harlan/.local/share/harlan-agent-kit/hooks/proof-hook.sh
grep -F "hogwild:$proof_target.next" "$calls" >/dev/null
grep -F "mv '$proof_target.next' '$proof_target'" "$calls" >/dev/null
: > "$calls"

# An opencode hook that arrives changed must stop the whole install.
: > "$calls"
export HARLAN_AGENT_CONTEXT_TEST_OPENCODE_BAD=wt-only.sh
opencode_log="$test_root/opencode-hook.log"
if PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/sync-agent-context.sh" hogwild >"$opencode_log" 2>&1; then
  printf '%s\n' 'Hogwild accepted a different opencode hook.' >&2
  exit 1
fi
if ! grep -F 'Hogwild received different hook files.' "$opencode_log" >/dev/null; then
  printf '%s\n' 'The opencode hook refusal named the wrong failure.' >&2
  exit 1
fi
if grep -F "mv '" "$calls" >/dev/null; then
  printf '%s\n' 'Hogwild installed an unverified opencode hook.' >&2
  exit 1
fi
export HARLAN_AGENT_CONTEXT_TEST_OPENCODE_BAD=''

# The plugin itself gets the same refusal.
: > "$calls"
export HARLAN_AGENT_CONTEXT_TEST_OPENCODE_BAD=harlan-hooks.ts
opencode_log="$test_root/opencode-plugin.log"
if PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/sync-agent-context.sh" hogwild >"$opencode_log" 2>&1; then
  printf '%s\n' 'Hogwild accepted a different opencode plugin.' >&2
  exit 1
fi
if ! grep -F 'Hogwild received different hook files.' "$opencode_log" >/dev/null; then
  printf '%s\n' 'The opencode plugin refusal named the wrong failure.' >&2
  exit 1
fi
if grep -F "mv '" "$calls" >/dev/null; then
  printf '%s\n' 'Hogwild installed an unverified opencode plugin.' >&2
  exit 1
fi
export HARLAN_AGENT_CONTEXT_TEST_OPENCODE_BAD=''

# A hook that arrives changed must stop the install, the same as the instructions.
: > "$calls"
saved_hook_hash="$HARLAN_AGENT_CONTEXT_TEST_HOOK_HASH"
export HARLAN_AGENT_CONTEXT_TEST_HOOK_HASH=different
if PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/sync-agent-context.sh" hogwild >/dev/null 2>&1; then
  printf '%s\n' 'Hogwild accepted a different commit-msg hook.' >&2
  exit 1
fi
if grep -F "mv '" "$calls" >/dev/null; then
  printf '%s\n' 'Hogwild installed an unverified commit-msg hook.' >&2
  exit 1
fi
export HARLAN_AGENT_CONTEXT_TEST_HOOK_HASH="$saved_hook_hash"

: > "$calls"
saved_codex_hash="$HARLAN_AGENT_CONTEXT_TEST_CODEX_HASH"
export HARLAN_AGENT_CONTEXT_TEST_CODEX_HASH=different
if PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/sync-agent-context.sh" hogwild >/dev/null 2>&1; then
  printf '%s\n' 'Hogwild accepted different Agent instructions.' >&2
  exit 1
fi
if grep -F "mv '" "$calls" >/dev/null; then
  printf '%s\n' 'Hogwild installed unverified Agent instructions.' >&2
  exit 1
fi
export HARLAN_AGENT_CONTEXT_TEST_CODEX_HASH="$saved_codex_hash"

# A failed remote activation must fail the sync, the hook stays absent on Hogwild.
: > "$calls"
export HARLAN_AGENT_CONTEXT_TEST_SSH_FAIL=1
activation_log="$test_root/activation.log"
if PATH="$test_root/bin:/usr/bin:/bin" HARLAN_AGENT_CONTEXT_TEST_CALLS="$calls" \
  bash "$script_dir/sync-agent-context.sh" hogwild >"$activation_log" 2>&1; then
  printf '%s\n' 'Hogwild reported success on a failed remote activation.' >&2
  exit 1
fi
unset HARLAN_AGENT_CONTEXT_TEST_SSH_FAIL
activation_calls=$(grep -cF 'core.hooksPath' "$calls" || true)
if [ "$activation_calls" -ne 1 ]; then
  printf '%s\n' 'The activation test never reached the remote activation.' >&2
  exit 1
fi
if grep -F 'Synced Hogwild Agent instructions.' "$activation_log" >/dev/null; then
  printf '%s\n' 'Hogwild reported success on a failed remote activation.' >&2
  exit 1
fi

printf '%s\n' 'Agent context sync tests passed'
