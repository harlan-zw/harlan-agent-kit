#!/usr/bin/env bash
# Verifies hooks that add context answer in the shape Claude Code reads.
# Inputs copy the fields Claude Code 2.1.326 sent to a live hook.
set -uo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work" || exit 1

# Prints hookEventName and additionalContext, or "none" when the hook is silent.
context() {
  local hook=$1 input=$2 out
  out=$(printf '%s' "$input" | CLAUDE_SESSION_ID="test-$RANDOM-$RANDOM" bash "$dir/$hook")
  [ -n "$out" ] || { echo none; return; }
  printf '%s' "$out" | jq -r '"\(.hookSpecificOutput.hookEventName) \(.hookSpecificOutput.additionalContext // "missing")"'
}

expect() {
  local label=$1 pattern=$2 got=$3
  if ! printf '%s' "$got" | grep -qE "$pattern"; then
    printf 'FAIL  %s: got %s\n' "$label" "$got"
    fail=1
  fi
}

# Claude Code sends a failed Bash call to PostToolUseFailure with an error field.
got=$(context command-not-found.sh "$(jq -nc '{hook_event_name:"PostToolUseFailure",tool_name:"Bash",tool_input:{command:"ripgrepx --version"},error:"Exit code 127\n(eval):1: command not found: ripgrepx"}')")
expect 'zsh failure' '^PostToolUseFailure .*`ripgrepx` is not installed' "$got"

got=$(context command-not-found.sh "$(jq -nc '{hook_event_name:"PostToolUseFailure",tool_name:"Bash",tool_input:{command:"fdx ."},error:"Exit code 127\nbash: fdx: command not found"}')")
expect 'bash failure' '^PostToolUseFailure .*`fdx` is not installed' "$got"

# A successful call reports through tool_response.
got=$(context command-not-found.sh "$(jq -nc '{hook_event_name:"PostToolUse",tool_name:"Bash",tool_input:{command:"sed -E x"},tool_response:{stdout:"",stderr:"sed: invalid option -- E"}}')")
expect 'tool_response stderr' '^PostToolUse .*for `sed`' "$got"

# The opencode plugin sends tool_output and no event name.
got=$(context command-not-found.sh "$(jq -nc '{tool_input:{command:"jqx ."},tool_output:"bash: jqx: command not found"}')")
expect 'opencode input' '^PostToolUse .*`jqx` is not installed' "$got"

got=$(context command-not-found.sh "$(jq -nc '{hook_event_name:"PostToolUse",tool_name:"Bash",tool_input:{command:"echo hi"},tool_response:{stdout:"hi",stderr:""}}')")
expect 'clean output' '^none$' "$got"

got=$(context pre-commit-push.sh "$(jq -nc '{hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"git commit -m \"fix: x\""}}')")
expect 'commit format' '^PreToolUse Commit format: type\(scope\)' "$got"

got=$(context pre-commit-push.sh "$(jq -nc '{hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:"git status"}}')")
expect 'other git command' '^none$' "$got"

[ "$fail" -eq 0 ] && echo 'ok    hook output contract'
exit "$fail"
