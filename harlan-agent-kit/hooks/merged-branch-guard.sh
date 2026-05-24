#!/bin/bash
# PreToolUse (Bash): block modifications to branches with merged PRs
# Prevents accidental pushes/commits to already-merged branches

source "$(dirname "$0")/check-config.sh"
is_hook_disabled "merged-branch-guard" && exit 0

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

[ -z "$command" ] && exit 0

# Only check git mutation commands
if ! [[ "$command" =~ ^git[[:space:]]+(push|commit|rebase|cherry-pick|merge|reset) ]]; then
  exit 0
fi

deny() {
  jq -nc --arg reason "$1" '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$reason}}'
  exit 0
}

# Get current branch
branch=$(git branch --show-current 2>/dev/null)
[ -z "$branch" ] && exit 0
[ "$branch" = "main" ] || [ "$branch" = "master" ] && exit 0

# Check if branch has a merged PR (cache per session)
CACHE_FILE="/tmp/claude-merged-branch-${CLAUDE_SESSION_ID:-$$}"
if [ -f "$CACHE_FILE" ] && grep -qF "$branch" "$CACHE_FILE"; then
  deny "Branch \`$branch\` has a merged PR. Switch to a new branch or main before making changes."
fi

# Query GitHub — only if gh is available
if ! command -v gh &>/dev/null; then
  exit 0
fi

merged_pr=$(gh pr list --head "$branch" --state merged --json number --jq '.[0].number' 2>/dev/null)

if [ -n "$merged_pr" ]; then
  echo "$branch" >> "$CACHE_FILE"
  deny "Branch \`$branch\` has a merged PR (#$merged_pr). Switch to a new branch or main before making changes."
fi
