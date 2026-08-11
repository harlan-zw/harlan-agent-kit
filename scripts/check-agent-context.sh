#!/usr/bin/env bash
# Verifies the global agent context files have not drifted.
#
# Two invariants:
#   1. ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md differ only where they must
#      (tooling differences). Any new divergence is unintended drift.
#   2. The six TypeScript design principles are identical in both context files
#      and in the ts-design-patterns skill.
set -uo pipefail

CLAUDE="${HOME}/.claude/CLAUDE.md"
CODEX="${HOME}/.codex/AGENTS.md"
SKILL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/harlan-agent-kit/skills/ts-design-patterns/SKILL.md"

# Divergences that are intentional. Update this when you deliberately add one.
EXPECTED_HUNKS=4

fail=0
note() { printf '%s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }

for f in "$CLAUDE" "$CODEX" "$SKILL"; do
  [ -f "$f" ] || { bad "missing $f"; }
done
[ "$fail" -eq 0 ] || exit 1

# 1. Divergence count
hunks=$(diff -u "$CODEX" "$CLAUDE" | grep -c '^@@' || true)
if [ "$hunks" -gt "$EXPECTED_HUNKS" ]; then
  bad "context files diverge in $hunks places, expected $EXPECTED_HUNKS"
  note "      run: diff -u $CODEX $CLAUDE"
elif [ "$hunks" -lt "$EXPECTED_HUNKS" ]; then
  note "note  context files diverge in $hunks places, fewer than the expected $EXPECTED_HUNKS"
  note "      if that was deliberate, lower EXPECTED_HUNKS in $0"
fi

# 2. Design principles match across all three files.
# Each principle is a bullet opening with a bold clause; compare the whole set.
principles() { grep -E '^- \*\*(Make illegal|Errors as|No silent|Parse, don|Explicit dep|Pure core)' "$1" | sort; }

c_p=$(principles "$CLAUDE")
x_p=$(principles "$CODEX")
s_p=$(principles "$SKILL")

[ -n "$c_p" ] || bad "no design principles found in $CLAUDE"
[ "$c_p" = "$x_p" ] || { bad "design principles differ between the two context files"; diff <(echo "$c_p") <(echo "$x_p") | sed 's/^/      /'; }
[ "$c_p" = "$s_p" ] || { bad "design principles differ between context files and the skill"; diff <(echo "$c_p") <(echo "$s_p") | sed 's/^/      /'; }

[ "$fail" -eq 0 ] && note "ok    agent context in sync ($hunks intentional divergences)"
exit "$fail"
