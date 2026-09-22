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
# The site inventory fixture stands in for ~/sites/SITES.md on the desktop.
sites_fixture="$test_root/desktop-sites/SITES.md"
mkdir -p "$(dirname "$sites_fixture")"
printf '%s\n' '# Sites' '- example.com' > "$sites_fixture"
export HARLAN_AGENT_CONTEXT_SITES_FILE="$sites_fixture"

HARLAN_AGENT_CONTEXT_HOME="$test_home" bash "$script_dir/sync-agent-context.sh" local >/dev/null

cmp "$memory_root/$primary_slug/memory/MEMORY.md" "$test_home/.claude/projects/$primary_slug/memory/MEMORY.md"
cmp "$memory_root/$primary_slug/memory/deployment.md" "$test_home/.claude/projects/$primary_slug/memory/deployment.md"
cmp "$sites_fixture" "$test_home/sites/SITES.md"
test "$(stat -c %a "$test_home/sites/SITES.md")" = 644
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

# Every hook plugin.json registers, plus the files they source. The list comes
# from the same derivation the sync script uses, so a new hook needs no edit
# here and can never deploy unverified.
source "$repo_root/scripts/agent-context-hooks.sh"
mapfile -t opencode_hooks < <(agent_context_installed_hooks \
  "$repo_root/harlan-agent-kit/hooks" "$repo_root/harlan-agent-kit/.claude-plugin/plugin.json")
if [ "${#opencode_hooks[@]}" -lt 2 ]; then
  printf '%s\n' 'The hook derivation returned no hooks.' >&2
  exit 1
fi
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
export HARLAN_AGENT_CONTEXT_TEST_SITES_HASH="$(/usr/bin/sha256sum "$sites_fixture" | cut -d' ' -f1)"

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
if [[ "$*" == *sha256sum*SITES.md.next* ]]; then printf '%s  SITES.md.next\n' "${HARLAN_AGENT_CONTEXT_TEST_SITES_HASH:-different}"; fi
# The opencode files are verified in one batched sha256sum, so answer per path.
if [[ "$*" == *"sha256sum "* && "$*" == *harlan-hooks.ts.next* ]]; then
  for token in $*; do
    case "$token" in
      *.next*)
        path=${token//\'/}
        name=$(basename "${path%%.next*}")
        if [ "$name" = "$HARLAN_AGENT_CONTEXT_TEST_OPENCODE_BAD" ]; then
          printf 'different  %s\n' "$path"
        else
          printf '%s  %s\n' "$(grep -m1 "^$name " "$HARLAN_AGENT_CONTEXT_TEST_OPENCODE_HASHES" | cut -d' ' -f2)" "$path"
        fi
        ;;
    esac
  done
fi
if [[ -n "$HARLAN_AGENT_CONTEXT_TEST_SSH_VERIFY_FAIL" && "$*" == *sha256sum* ]]; then exit 42; fi
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

grep -E 'hogwild:/home/harlan/.claude/CLAUDE.md.next\.[0-9.]+' "$calls" >/dev/null
grep -E 'hogwild:/home/harlan/.codex/AGENTS.md.next\.[0-9.]+' "$calls" >/dev/null
grep -E "mv '/home/harlan/.claude/CLAUDE.md.next\.[0-9.]+' '/home/harlan/.claude/CLAUDE.md'" "$calls" >/dev/null
grep -E "mv '/home/harlan/.codex/AGENTS.md.next\.[0-9.]+' '/home/harlan/.codex/AGENTS.md'" "$calls" >/dev/null
grep -E 'hogwild:/home/harlan/.config/git/hooks/commit-msg.next\.[0-9.]+' "$calls" >/dev/null
grep -E 'hogwild:/home/harlan/sites/SITES.md.next\.[0-9.]+' "$calls" >/dev/null
grep -E "mv '/home/harlan/sites/SITES.md.next\.[0-9.]+' '/home/harlan/sites/SITES.md'" "$calls" >/dev/null
grep -E "mv '/home/harlan/.config/git/hooks/commit-msg.next\.[0-9.]+' '/home/harlan/.config/git/hooks/commit-msg'" "$calls" >/dev/null
grep -F "core.hooksPath '/home/harlan/.config/git/hooks'" "$calls" >/dev/null
for hook_file in "${opencode_hooks[@]}"; do
  grep -F "hogwild:/home/harlan/.local/share/harlan-agent-kit/hooks/$hook_file.next" "$calls" >/dev/null
  grep -E "mv '/home/harlan/.local/share/harlan-agent-kit/hooks/$hook_file.next\.[0-9.]+' '/home/harlan/.local/share/harlan-agent-kit/hooks/$hook_file'" "$calls" >/dev/null
done
grep -E 'hogwild:/home/harlan/.config/opencode/plugins/harlan-hooks.ts.next\.[0-9.]+' "$calls" >/dev/null

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
grep -E "mv '/home/harlan/.config/opencode/plugins/harlan-hooks.ts.next\.[0-9.]+' '/home/harlan/.config/opencode/plugins/harlan-hooks.ts'" "$calls" >/dev/null
grep -E "chmod 644 '/home/harlan/.config/opencode/plugins/harlan-hooks.ts.next\.[0-9.]+'" "$calls" >/dev/null
manifest_target=/home/harlan/.local/share/harlan-agent-kit/.claude-plugin/plugin.json
grep -F "hogwild:$manifest_target.next" "$calls" >/dev/null
grep -E "mv '$manifest_target.next\.[0-9.]+' '$manifest_target'" "$calls" >/dev/null
grep -E "chmod 644 '$manifest_target.next\.[0-9.]+'" "$calls" >/dev/null

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
grep -E "mv '$proof_target.next\.[0-9.]+' '$proof_target'" "$calls" >/dev/null
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

# Two syncs can reach Hogwild at once: the service updates itself on merge,
# and a person can deploy by hand in the same minute. Each run stages, checks
# the digest, then moves. If both runs stage to one path, one can move the
# file the other staged, and install content it never checked. So no two runs
# may ever share a staging path.
: > "$calls"
PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/sync-agent-context.sh" hogwild >/dev/null
first_stage=$(grep -oE "hogwild:/home/harlan/\.claude/CLAUDE\.md\.next[^ ']*" "$calls" | head -1)
: > "$calls"
PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/sync-agent-context.sh" hogwild >/dev/null
second_stage=$(grep -oE "hogwild:/home/harlan/\.claude/CLAUDE\.md\.next[^ ']*" "$calls" | head -1)
if [ -z "$first_stage" ] || [ -z "$second_stage" ]; then
  printf '%s\n' 'The staging test never saw a staged Claude file.' >&2
  exit 1
fi
if [ "$first_stage" = "$second_stage" ]; then
  printf '%s\n' "Two syncs staged to the same path, $first_stage, so one can install what the other staged." >&2
  exit 1
fi

# A run may only clean up what it staged. Removing another run's staged files
# is what failed a hand deploy on 2026-09-16 while the service updated itself.
# Cleanup only runs when a digest check fails, so force that path.
: > "$calls"
saved_codex_hash="$HARLAN_AGENT_CONTEXT_TEST_CODEX_HASH"
export HARLAN_AGENT_CONTEXT_TEST_CODEX_HASH=different
PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/sync-agent-context.sh" hogwild >/dev/null 2>&1 || true
export HARLAN_AGENT_CONTEXT_TEST_CODEX_HASH="$saved_codex_hash"
failed_stage=$(grep -oE "hogwild:/home/harlan/\.claude/CLAUDE\.md\.next[^ ']*" "$calls" | head -1)
failed_token=${failed_stage##*CLAUDE.md.}
cleanup_call=$(grep -F 'rm -f' "$calls" || true)
if [ -z "$cleanup_call" ]; then
  printf '%s\n' 'The cleanup test never reached cleanup.' >&2
  exit 1
fi
if printf '%s' "$cleanup_call" | grep -E "\.next'" >/dev/null; then
  printf '%s\n' 'A run cleaned up a bare .next path that any concurrent run could own.' >&2
  exit 1
fi
if ! printf '%s' "$cleanup_call" | grep -F "CLAUDE.md.$failed_token'" >/dev/null; then
  printf '%s\n' "Cleanup did not remove this run's own staged file, $failed_token." >&2
  exit 1
fi

# An interrupted run must not strand its staged files on Hogwild. The shared
# .next name used to self-heal: the next deploy overwrote the orphan. A unique
# token ends that reclamation, so the run itself must reclaim what it staged,
# on every exit path. Every scp succeeds, then the verification ssh dies, so
# set -e ends the run between staging and activation, where no explicit
# cleanup branch runs.
: > "$calls"
export HARLAN_AGENT_CONTEXT_TEST_SSH_VERIFY_FAIL=1
interrupted_log="$test_root/interrupted.log"
if PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/sync-agent-context.sh" hogwild >"$interrupted_log" 2>&1; then
  printf '%s\n' 'Hogwild sync reported success on a dying verification ssh.' >&2
  exit 1
fi
unset HARLAN_AGENT_CONTEXT_TEST_SSH_VERIFY_FAIL
reclaim_call=$(grep -F 'rm -f' "$calls" | tail -n 1 || true)
if [ -z "$reclaim_call" ]; then
  printf '%s\n' 'An interrupted sync left its staged files on Hogwild with no cleanup.' >&2
  exit 1
fi
if [ "$reclaim_call" != "$(tail -n 1 "$calls")" ]; then
  printf '%s\n' 'The interrupted run recorded a call after its cleanup.' >&2
  exit 1
fi
if printf '%s' "$reclaim_call" | grep -E "\.next'" >/dev/null; then
  printf '%s\n' 'An interrupted sync cleaned up a bare .next path any concurrent run could own.' >&2
  exit 1
fi
while IFS= read -r staged_call; do
  staged_path=${staged_call##* }
  if ! printf '%s' "$reclaim_call" | grep -F "'${staged_path#hogwild:}'" >/dev/null; then
    printf '%s\n' "An interrupted sync left $staged_path on Hogwild." >&2
    exit 1
  fi
done < <(grep '^scp ' "$calls")

printf '%s\n' 'Agent context sync tests passed'
