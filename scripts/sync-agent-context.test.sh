#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

test_home="$test_root/home"
calls="$test_root/calls"
mkdir -p "$test_home" "$test_root/bin"

HARLAN_AGENT_CONTEXT_HOME="$test_home" bash "$script_dir/sync-agent-context.sh" local >/dev/null

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

claude_hash=$(/usr/bin/sha256sum "$test_home/.claude/CLAUDE.md" | cut -d' ' -f1)
codex_hash=$(/usr/bin/sha256sum "$test_home/.codex/AGENTS.md" | cut -d' ' -f1)
hook_hash=$(/usr/bin/sha256sum "$repo_root/agent-context/git-hooks/commit-msg" | cut -d' ' -f1)
export HARLAN_AGENT_CONTEXT_TEST_CALLS="$calls"
export HARLAN_AGENT_CONTEXT_TEST_CLAUDE_HASH="$claude_hash"
export HARLAN_AGENT_CONTEXT_TEST_CODEX_HASH="$codex_hash"
export HARLAN_AGENT_CONTEXT_TEST_HOOK_HASH="$hook_hash"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''ssh %s\n'\'' "$*" >> "$HARLAN_AGENT_CONTEXT_TEST_CALLS"' \
  'if [[ "$*" == *CLAUDE.md.next*sha256sum* || "$*" == *sha256sum*CLAUDE.md.next* ]]; then printf '\''%s  CLAUDE.md.next\n'\'' "$HARLAN_AGENT_CONTEXT_TEST_CLAUDE_HASH"; fi' \
  'if [[ "$*" == *AGENTS.md.next*sha256sum* || "$*" == *sha256sum*AGENTS.md.next* ]]; then printf '\''%s  AGENTS.md.next\n'\'' "$HARLAN_AGENT_CONTEXT_TEST_CODEX_HASH"; fi' \
  'if [[ "$*" == *commit-msg.next*sha256sum* || "$*" == *sha256sum*commit-msg.next* ]]; then printf '\''%s  commit-msg.next\n'\'' "$HARLAN_AGENT_CONTEXT_TEST_HOOK_HASH"; fi' \
  > "$test_root/bin/ssh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''scp %s\n'\'' "$*" >> "$HARLAN_AGENT_CONTEXT_TEST_CALLS"' \
  > "$test_root/bin/scp"
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
export HARLAN_AGENT_CONTEXT_TEST_CODEX_HASH=different
if PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/sync-agent-context.sh" hogwild >/dev/null 2>&1; then
  printf '%s\n' 'Hogwild accepted different Agent instructions.' >&2
  exit 1
fi
if grep -F "mv '" "$calls" >/dev/null; then
  printf '%s\n' 'Hogwild installed unverified Agent instructions.' >&2
  exit 1
fi

printf '%s\n' 'Agent context sync tests passed'
