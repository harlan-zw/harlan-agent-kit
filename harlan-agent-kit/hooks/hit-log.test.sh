#!/usr/bin/env bash
# Verifies each Hook decision appends one line to the hit log.
# A failed write must leave the decision and its output unchanged.
set -uo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# No git repository here, so merged-branch-guard.sh exits early unless a case builds one.
cd "$work" || exit 1

bad() { printf 'FAIL  %s\n' "$1"; fail=1; }
time_pattern='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'

# Runs one Hook in a clean environment, so the caller's agent variables never leak in.
# Usage: run_hook <hook> <stdin> <state dir> [NAME=value ...]
run_hook() {
  local hook=$1 input=$2 state=$3
  shift 3
  printf '%s' "$input" | env -i PATH="$PATH" HOME="$work/home" XDG_STATE_HOME="$state" "$@" bash "$dir/$hook"
}

command_input() { jq -nc --arg c "$1" '{tool_input:{command:$c}}'; }

# Counts the lines in a state directory's hit log. A missing log counts as zero.
hit_count() {
  local log="$1/harlan-agent-kit/hook-hits.jsonl"
  [ -f "$log" ] || { echo 0; return; }
  wc -l < "$log" | tr -d ' '
}

hit_line() { cat "$1/harlan-agent-kit/hook-hits.jsonl"; }

# Checks one Hook call that should log exactly one line with these fields.
# Usage: expect_hit <label> <hook> <stdin> <decision> <surface> [NAME=value ...]
expect_hit() {
  local label=$1 hook=$2 input=$3 decision=$4 surface=$5
  shift 5
  local state="$work/state-$RANDOM-$RANDOM" out line reason
  out=$(run_hook "$hook" "$input" "$state" "$@")
  [ -n "$out" ] || { bad "$label: the Hook allowed the call"; return; }
  [ "$(hit_count "$state")" = 1 ] || { bad "$label: expected 1 line, got $(hit_count "$state")"; return; }
  line=$(hit_line "$state")
  reason=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason')
  printf '%s' "$line" | jq -e \
    --arg hook "$hook" --arg decision "$decision" --arg surface "$surface" \
    --arg reason "$reason" --arg time_pattern "$time_pattern" '
      (keys == ["decision", "hook", "reason", "surface", "time"])
      and .hook == $hook
      and .decision == $decision
      and .surface == $surface
      and .reason == $reason[0:80]
      and (.time | test($time_pattern))
    ' >/dev/null || bad "$label: wrong fields: $line"
  # The log keeps the reason prefix only, never the command.
  local command
  command=$(printf '%s' "$input" | jq -r '.tool_input.command')
  [[ "$line" != *"$command"* ]] || bad "$label: the line holds the command: $line"
  [[ "$line" != *'s3cr3t-value'* ]] || bad "$label: the line holds a secret: $line"
}

# Checks one Hook call that allows the command and logs nothing.
expect_silent() {
  local label=$1 hook=$2 command=$3
  local state="$work/state-$RANDOM-$RANDOM" out decision
  out=$(run_hook "$hook" "$(command_input "$command")" "$state" CLAUDE_PROJECT_DIR=/project)
  decision=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null)
  [ -z "$decision" ] || bad "$label: the Hook decided $decision"
  [ "$(hit_count "$state")" = 0 ] || bad "$label: an allowed call logged: $(hit_line "$state")"
}

# Prints the surface one call logs under these variables and this stdin.
surface_for() {
  local input=$1
  shift
  local state="$work/state-$RANDOM-$RANDOM"
  run_hook wt-only.sh "$input" "$state" "$@" >/dev/null
  if [ "$(hit_count "$state")" = 1 ]; then hit_line "$state" | jq -r '.surface'; else echo "lines=$(hit_count "$state")"; fi
}

expect_surface() {
  local label=$1 want=$2 got
  shift 2
  got=$(surface_for "$@")
  [ "$got" = "$want" ] || bad "surface $label: expected $want, got $got"
}

# Every Hook that denies or rewrites logs its decision.
expect_hit 'wt-only deny' wt-only.sh "$(command_input 'git worktree add ../x TOKEN=s3cr3t-value')" deny claude CLAUDE_PROJECT_DIR=/project
expect_hit 'pnpm-only rewrite' pnpm-only.sh "$(command_input 'npm install s3cr3t-value')" rewrite opencode HARLAN_AGENT_HOOK_SURFACE=opencode
expect_hit 'npx rewrite' pnpm-only.sh "$(command_input 'npx eslint .')" rewrite claude CLAUDE_PROJECT_DIR=/project
expect_hit 'himalaya deny' himalaya-read-only.sh "$(command_input 'himalaya message delete 1')" deny claude CLAUDE_PROJECT_DIR=/project
expect_hit 'pr-skill-only deny' pr-skill-only.sh "$(command_input 'gh pr create --title x --body s3cr3t-value')" deny claude CLAUDE_PROJECT_DIR=/project
expect_hit 'github read deny' github-read-routing.sh "$(command_input 'gh pr view 1 --repo owner/public')" deny claude CLAUDE_PROJECT_DIR=/project
expect_hit 'github watch deny' github-read-routing.sh "$(command_input 'HARLAN_AGENT_GITHUB_PRIVATE=owner/private gh run watch 1 --repo owner/private')" deny codex PLUGIN_ROOT=/plugin

# merged-branch-guard.sh denies from its session cache, so no GitHub call runs.
repo="$work/merged-repo"
git init -q -b feat/merged "$repo"
session="hit-log-test-$RANDOM-$RANDOM"
printf 'feat/merged\n' > "/tmp/claude-merged-branch-$session"
merged_input=$(jq -nc --arg s "$session" '{session_id:$s,tool_input:{command:"git commit -m x"}}')
(cd "$repo" || exit 1; expect_hit 'merged branch deny' merged-branch-guard.sh "$merged_input" deny claude CLAUDE_PROJECT_DIR=/project; exit "$fail") || fail=1
rm -f "/tmp/claude-merged-branch-$session"

# An allowed call logs nothing.
expect_silent 'wt list' wt-only.sh 'wt list --format=json'
expect_silent 'pnpm install' pnpm-only.sh 'pnpm install'
expect_silent 'himalaya read' himalaya-read-only.sh 'himalaya envelope list'
expect_silent 'agent-gh read' github-read-routing.sh 'agent-gh pr view 1 --repo owner/public'
expect_silent 'pr skill create' pr-skill-only.sh 'HARLAN_AGENT_PR_SKILL=1 gh pr create --fill'
expect_silent 'commit context' pre-commit-push.sh 'git commit -m "fix: x"'

# Surface inference. The opencode plugin names itself. Claude Code sets
# CLAUDE_PROJECT_DIR on every Hook. Codex user Hooks inherit only the Codex
# process environment, so stdin turn_id marks them. Codex Plugin Hooks also get PLUGIN_ROOT.
deny_input=$(command_input 'git worktree prune')
codex_input=$(jq -nc '{session_id:"s",turn_id:"t",model:"m",tool_input:{command:"git worktree prune"}}')
expect_surface 'opencode' opencode "$deny_input" HARLAN_AGENT_HOOK_SURFACE=opencode CLAUDE_PROJECT_DIR=/project
expect_surface 'claude' claude "$deny_input" CLAUDE_PROJECT_DIR=/project
expect_surface 'claude before codex markers' claude "$codex_input" CLAUDE_PROJECT_DIR=/project
expect_surface 'codex user Hook' codex "$codex_input"
expect_surface 'codex Plugin Hook' codex "$deny_input" PLUGIN_ROOT=/plugin CLAUDE_PLUGIN_ROOT=/plugin
expect_surface 'unknown value falls through' claude "$deny_input" HARLAN_AGENT_HOOK_SURFACE=bogus CLAUDE_PROJECT_DIR=/project
# Variables a parent shell leaks into a child mark no surface.
expect_surface 'leaked Claude Code shell' unknown "$deny_input" CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=x CLAUDE_PLUGIN_ROOT=/plugin
expect_surface 'leaked Codex shell' unknown "$deny_input" CODEX_THREAD_ID=x

# A Hook registered twice runs twice for one tool call, for example from Codex user
# Hooks and an enabled Codex Plugin copy that still declares hooks. That call logs once.
call_input() { jq -nc --arg id "$1" '{session_id:"session-1",turn_id:"t",tool_use_id:$id,tool_input:{command:"git worktree prune"}}'; }
expect_lines() {
  local label=$1 want=$2 state=$3
  [ "$(hit_count "$state")" = "$want" ] || bad "$label: expected $want lines, got $(hit_count "$state")"
}
state="$work/state-double"
run_hook wt-only.sh "$(call_input call-1)" "$state" >/dev/null
run_hook wt-only.sh "$(call_input call-1)" "$state" PLUGIN_ROOT=/plugin >/dev/null
expect_lines 'one call, two runs' 1 "$state"
run_hook wt-only.sh "$(call_input call-2)" "$state" >/dev/null
expect_lines 'a second call' 2 "$state"
run_hook pr-skill-only.sh "$(jq -nc '{session_id:"session-1",tool_use_id:"call-2",tool_input:{command:"gh pr create --fill"}}')" "$state" >/dev/null
expect_lines 'another Hook on the same call' 3 "$state"
state="$work/state-parallel"
for _ in 1 2 3 4; do run_hook wt-only.sh "$(call_input call-3)" "$state" >/dev/null & done
wait
expect_lines 'parallel runs of one call' 1 "$state"
# Without both ids nothing marks the call, so each run logs.
state="$work/state-no-ids"
run_hook wt-only.sh "$deny_input" "$state" >/dev/null
run_hook wt-only.sh "$deny_input" "$state" >/dev/null
expect_lines 'no call ids' 2 "$state"
# The second run still prints its decision.
want=$(run_hook wt-only.sh "$(call_input call-4)" "$work/state-output")
got=$(run_hook wt-only.sh "$(call_input call-4)" "$work/state-output")
[ -n "$want" ] && [ "$got" = "$want" ] || bad "duplicate run: output changed: $got"

# Without XDG_STATE_HOME the log sits under HOME.
printf '%s' "$deny_input" | env -i PATH="$PATH" HOME="$work/home" CLAUDE_PROJECT_DIR=/project bash "$dir/wt-only.sh" >/dev/null
[ "$(hit_count "$work/home/.local/state")" = 1 ] || bad 'default state directory: no line under HOME'

# A failed write changes nothing. A regular file blocks the directory, even for root.
blocked="$work/blocked-state"
: > "$blocked"
for case in "wt-only.sh|git worktree add ../x" "pnpm-only.sh|npm install" "github-read-routing.sh|gh api repos/owner/public"; do
  hook=${case%%|*}
  command=${case#*|}
  writable="$work/state-$RANDOM-$RANDOM"
  want=$(run_hook "$hook" "$(command_input "$command")" "$writable" CLAUDE_PROJECT_DIR=/project)
  got=$(run_hook "$hook" "$(command_input "$command")" "$blocked" CLAUDE_PROJECT_DIR=/project 2>"$work/stderr")
  code=$?
  [ "$code" = 0 ] || bad "unwritable $hook: exit $code"
  [ -n "$want" ] && [ "$got" = "$want" ] || bad "unwritable $hook: output changed: $got"
  [ ! -s "$work/stderr" ] || bad "unwritable $hook: wrote stderr: $(cat "$work/stderr")"
done

[ "$fail" -eq 0 ] && echo 'ok    Hook hit log'
exit "$fail"
