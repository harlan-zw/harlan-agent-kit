#!/usr/bin/env bash
# Verifies installed Agent instructions match their tracked sources.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_HOME="${HARLAN_AGENT_CONTEXT_HOME:-$HOME}"
CLAUDE="$TARGET_HOME/.claude/CLAUDE.md"
CODEX="$TARGET_HOME/.codex/AGENTS.md"
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

HARLAN_AGENT_CONTEXT_HOME="$EXPECTED_HOME" bash "$REPO_ROOT/scripts/sync-agent-context.sh" local >/dev/null

cmp -s "$EXPECTED_CLAUDE" "$CLAUDE" || bad "Claude instructions differ. Run pnpm sync:context."
cmp -s "$EXPECTED_CODEX" "$CODEX" || bad "Codex instructions differ. Run pnpm sync:context."

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
