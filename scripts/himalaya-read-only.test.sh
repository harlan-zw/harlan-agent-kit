#!/usr/bin/env bash
# Drives the himalaya-read-only hook over its real stdin and stdout contract.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hook="$repo_root/harlan-agent-kit/hooks/himalaya-read-only.sh"

fail=0
pass() { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }

[ -x "$hook" ] || { printf 'FAIL  The hook is not executable: %s\n' "$hook"; exit 1; }

# Answers the hook's decision for one command, or "allow" when it says nothing.
decision() {
  local out
  out=$(jq -nc --arg c "$1" '{tool_input:{command:$c}}' | bash "$hook" 2>/dev/null)
  [ -n "$out" ] || { printf 'allow\n'; return; }
  printf '%s\n' "$out" | jq -r '.hookSpecificOutput.permissionDecision // "allow"'
}

allows() {
  if [ "$(decision "$1")" = 'allow' ]; then pass "allows: $1"; else bad "denied, should allow: $1"; fi
}

denies() {
  if [ "$(decision "$1")" = 'deny' ]; then pass "denies: $1"; else bad "allowed, should deny: $1"; fi
}

# Reading mail is the whole point of granting access.
allows 'himalaya envelope list'
allows 'himalaya envelope list --folder INBOX'
allows 'himalaya envelope thread 42'
allows 'himalaya message read 42'
allows 'himalaya message export 42'
allows 'himalaya folder list'
allows 'himalaya attachment download 42'
allows 'himalaya account list'
allows 'himalaya --version'
allows 'himalaya --help'

# Sending, and the three IMAP mutations a read only agent must not reach.
denies 'himalaya message send'
denies 'himalaya message delete 42'
denies 'himalaya message move 42 Archive'
denies 'himalaya message copy 42 Archive'
denies 'himalaya flag add 42 Seen'
denies 'himalaya flag remove 42 Seen'
denies 'himalaya folder create Archive'
denies 'himalaya folder delete Archive'
denies 'himalaya folder expunge INBOX'
denies 'himalaya template send'
denies 'himalaya account configure harlanzw'

# A mutating call hidden later in a pipeline still counts.
denies 'himalaya envelope list | head -5 && himalaya message delete 42'
denies 'echo hi; himalaya message send'

# Commands that merely mention the word are not himalaya calls.
allows 'rg himalaya ~/.claude/CLAUDE.md'
allows 'echo "use himalaya message send to reply"'

[ "$fail" -eq 0 ] || exit 1
printf '\nAll himalaya read-only checks passed.\n'
