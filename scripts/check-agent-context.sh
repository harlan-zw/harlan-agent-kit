#!/usr/bin/env bash
# Verifies installed Agent instructions match their tracked sources.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_HOME="${HARLAN_AGENT_CONTEXT_HOME:-$HOME}"
CLAUDE="$TARGET_HOME/.claude/CLAUDE.md"
CODEX="$TARGET_HOME/.codex/AGENTS.md"
COMMIT_HOOK="$TARGET_HOME/.config/git/hooks/commit-msg"
SOURCE_HOOK="$REPO_ROOT/agent-context/git-hooks/commit-msg"
PLUGIN_HOOKS_DIR="$REPO_ROOT/harlan-agent-kit/hooks"
SOURCE_PLUGIN="$REPO_ROOT/harlan-agent-kit/plugins/opencode/harlan-hooks.ts"
INSTALLED_HOOKS_DIR="$TARGET_HOME/.local/share/harlan-agent-kit/hooks"
INSTALLED_PLUGIN="$TARGET_HOME/.config/opencode/plugins/harlan-hooks.ts"
OPENCODE_HOOKS=(check-config.sh pnpm-only.sh wt-only.sh pr-skill-only.sh merged-branch-guard.sh pre-commit-push.sh eslint.sh)
SKILL="$REPO_ROOT/harlan-agent-kit/skills/ts-design-patterns/SKILL.md"
EXPECTED_HOME=$(mktemp -d)
trap 'rm -rf "$EXPECTED_HOME"' EXIT
EXPECTED_CLAUDE="$EXPECTED_HOME/.claude/CLAUDE.md"
EXPECTED_CODEX="$EXPECTED_HOME/.codex/AGENTS.md"

fail=0
note() { printf '%s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }

for f in "$REPO_ROOT/agent-context/context.md" "$REPO_ROOT/agent-context/CLAUDE.md" "$REPO_ROOT/agent-context/AGENTS.md" "$CLAUDE" "$CODEX" "$SKILL"; do
  [ -f "$f" ] || { bad "Missing file: $f"; }
done
[ "$fail" -eq 0 ] || exit 1

# Project memory is out of scope for this check. It compares installed files
# against tracked sources in this repository. Memory has no tracked source: it
# is Harlan's, it changes every session, so a difference is normal and reporting
# it as drift would make the check meaningless. The sandbox run skips it.
HARLAN_AGENT_CONTEXT_HOME="$EXPECTED_HOME" HARLAN_AGENT_CONTEXT_SKIP_MEMORY=1 \
  bash "$REPO_ROOT/scripts/sync-agent-context.sh" local >/dev/null

cmp -s "$EXPECTED_CLAUDE" "$CLAUDE" || bad "Claude instructions differ. Run pnpm sync:context."
cmp -s "$EXPECTED_CODEX" "$CODEX" || bad "Codex instructions differ. Run pnpm sync:context."

if [ ! -f "$COMMIT_HOOK" ]; then
  bad "The commit-msg hook is not installed. Run pnpm sync:context."
else
  cmp -s "$SOURCE_HOOK" "$COMMIT_HOOK" || bad "The commit-msg hook differs. Run pnpm sync:context."
  [ -x "$COMMIT_HOOK" ] || bad "The commit-msg hook is not executable. Run pnpm sync:context."
fi
[ "$(HOME="$TARGET_HOME" git config --global --get core.hooksPath)" = "$TARGET_HOME/.config/git/hooks" ] \
  || bad "core.hooksPath does not point at the installed hooks. Run pnpm sync:context."

# opencode reads the plugin hooks from a stable path, so drift there is silent.
for hook_file in "${OPENCODE_HOOKS[@]}"; do
  if [ ! -f "$INSTALLED_HOOKS_DIR/$hook_file" ]; then
    bad "The opencode hook is not installed: $hook_file. Run pnpm sync:context."
    continue
  fi
  cmp -s "$PLUGIN_HOOKS_DIR/$hook_file" "$INSTALLED_HOOKS_DIR/$hook_file" \
    || bad "The opencode hook differs: $hook_file. Run pnpm sync:context."
  [ -x "$INSTALLED_HOOKS_DIR/$hook_file" ] \
    || bad "The opencode hook is not executable: $hook_file. Run pnpm sync:context."
done
if [ ! -f "$INSTALLED_PLUGIN" ]; then
  bad "The opencode plugin is not installed. Run pnpm sync:context."
else
  cmp -s "$SOURCE_PLUGIN" "$INSTALLED_PLUGIN" || bad "The opencode plugin differs. Run pnpm sync:context."
fi

# Each principle is a bullet opening with a bold clause; compare the whole set.
principles() { grep -E '^- \*\*(Make illegal|Errors as|No silent|Parse, don|Explicit dep|Pure core)' "$1" | sort; }

c_p=$(principles "$EXPECTED_CLAUDE")
x_p=$(principles "$EXPECTED_CODEX")
s_p=$(principles "$SKILL")

[ -n "$c_p" ] || bad "No design principles found in rendered Claude instructions."
[ "$c_p" = "$x_p" ] || { bad "design principles differ between tracked files"; diff <(echo "$c_p") <(echo "$x_p") | sed 's/^/      /'; }
[ "$c_p" = "$s_p" ] || { bad "design principles differ from the skill"; diff <(echo "$c_p") <(echo "$s_p") | sed 's/^/      /'; }

[ "$fail" -eq 0 ] && note 'ok    Agent instructions match tracked sources'
exit "$fail"
