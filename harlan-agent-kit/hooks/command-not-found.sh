#!/bin/bash
# PostToolUse and PostToolUseFailure (Bash): detect "command not found" and BSD/GNU incompatibilities
# Suggests install fix once per session per command

source "$(dirname "$0")/check-config.sh"
is_hook_disabled "command-not-found" && exit 0

input=$(cat)
# Claude Code sends `error` on failure and `tool_response` on success. opencode sends `tool_output`.
tool_output=$(echo "$input" | jq -r '[.error, .tool_response.stdout, .tool_response.stderr, .tool_output] | map(strings) | join("\n")')
event=$(echo "$input" | jq -r '.hook_event_name // "PostToolUse"')
command=$(echo "$input" | jq -r '.tool_input.command // empty')

[ -z "$tool_output" ] && exit 0

# Session tracking — only suggest each command once
# Claude Code sends session_id on stdin. The opencode plugin sets CLAUDE_SESSION_ID.
session=$(echo "$input" | jq -r '.session_id // empty')
SESSION_FILE="/tmp/claude-cmd-notfound-${session:-${CLAUDE_SESSION_ID:-$$}}"

already_suggested() {
  [ -f "$SESSION_FILE" ] && grep -qF "$1" "$SESSION_FILE"
}

mark_suggested() {
  echo "$1" >> "$SESSION_FILE"
}

suggest() {
  jq -nc --arg event "$event" --arg msg "$1" '{"hookSpecificOutput":{"hookEventName":$event,"additionalContext":$msg}}'
  exit 0
}

# Detect "command not found" patterns
cmd_name=""
if echo "$tool_output" | grep -qiE '(command not found|not found in PATH)'; then
  # Extract command name from common error formats
  # zsh puts the name last: "(eval):1: command not found: name".
  cmd_name=$(echo "$tool_output" | grep -ioE 'command not found: [a-zA-Z0-9_.-]+' | head -1 | sed -E 's/.*: //')
  [ -z "$cmd_name" ] && cmd_name=$(echo "$tool_output" | grep -ioE '(bash: |zsh: )?([a-zA-Z0-9_.-]+): (command )?not found' | head -1 | sed -E 's/(bash: |zsh: )//;s/: (command )?not found//')
fi

# Detect "No such file or directory" for executables (not regular files)
if [ -z "$cmd_name" ] && echo "$tool_output" | grep -qE 'No such file or directory.*bin/'; then
  cmd_name=$(echo "$tool_output" | grep -oE '[a-zA-Z0-9_.-]+: No such file or directory' | head -1 | cut -d: -f1)
fi

if [ -n "$cmd_name" ]; then
  already_suggested "$cmd_name" && exit 0
  mark_suggested "$cmd_name"

  if [[ "$OSTYPE" == darwin* ]]; then
    suggest "⚠️ \`$cmd_name\` is not installed. Try: \`brew install $cmd_name\`"
  else
    suggest "⚠️ \`$cmd_name\` is not installed. Try: \`sudo apt install $cmd_name\` or \`pacman -S $cmd_name\`"
  fi
fi

# Detect BSD/GNU incompatibilities
if echo "$tool_output" | grep -qiE '(invalid option|illegal option|unrecognized option)'; then
  # Extract the problematic option
  bad_opt=$(echo "$tool_output" | grep -ioE "(invalid|illegal|unrecognized) option[: -]*['\"]?-?-?[a-zA-Z0-9-]+" | head -1)
  # Extract the base command
  base_cmd=$(echo "$command" | awk '{print $1}' | xargs basename 2>/dev/null)

  [ -z "$base_cmd" ] && exit 0
  already_suggested "compat-$base_cmd" && exit 0
  mark_suggested "compat-$base_cmd"

  if [[ "$OSTYPE" == darwin* ]]; then
    suggest "⚠️ BSD/GNU incompatibility: \`$bad_opt\` for \`$base_cmd\`. macOS ships BSD utils — install GNU version: \`brew install coreutils\` (or \`brew install gnu-sed\`, \`brew install grep\`, etc.)"
  else
    suggest "⚠️ \`$bad_opt\` for \`$base_cmd\` — check if the flag exists in this version (\`$base_cmd --help\`)."
  fi
fi
