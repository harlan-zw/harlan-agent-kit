#!/usr/bin/env bash
# PreToolUse (Bash): keeps every agent's email access read only.
#
# Hogwild's himalaya configuration carries no send backend, so sending already
# fails there. IMAP still allows an agent to delete, move, and flag a real
# message, and that config guarantee does not travel to the desktop. This hook
# closes both, and it runs under opencode too through the opencode plugin.
#
# The rule is an allowlist. A denylist of mutating subcommands would miss the
# next subcommand himalaya adds.
#
# A call counts only at a command position, matching pr-skill-only.sh. Prose
# that names a command, in a heredoc or an echo, is not a call. An inline
# environment assignment before the binary is not matched, which is the known
# gap in this shape.
source "$(dirname "$0")/check-config.sh"
is_hook_disabled "himalaya-read-only" && exit 0

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

[ -n "$command" ] || exit 0

deny() {
  jq -nc --arg reason "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}

# Every himalaya call in the command, wherever it sits in a pipeline.
printf '%s\n' "$command" \
  | grep -oE '(^|[|&;(][[:space:]]*)himalaya([[:space:]]+[^|&;)]*)?' \
  | while IFS= read -r call; do
      # Strip the leading separator and the binary name.
      arguments=$(printf '%s' "$call" | sed -E 's/^[^h]*himalaya[[:space:]]*//')
      # Options carry no subcommand, so read the first two bare words.
      words=$(printf '%s' "$arguments" | tr ' ' '\n' | grep -vE '^-' | grep -v '^$' | head -2 | tr '\n' ' ')
      first=$(printf '%s' "$words" | cut -d' ' -f1)
      second=$(printf '%s' "$words" | cut -d' ' -f2)

      # No subcommand means help or version output.
      [ -n "$first" ] || continue

      case "$first $second" in
        'envelope list '* | 'envelope list' | 'envelope thread'* | 'envelope watch'*) continue ;;
        'message read'* | 'message export'*) continue ;;
        'folder list'*) continue ;;
        'attachment download'*) continue ;;
        'account list'*) continue ;;
        'manual '* | 'completion '*) continue ;;
      esac
      case "$first" in
        envelope | message | folder | attachment | account | flag | template | send | manual | completion)
          printf 'DENY %s\n' "$first${second:+ $second}"
          ;;
        *) continue ;;
      esac
    done > /tmp/.himalaya-hook-$$ 2>/dev/null

blocked=$(head -1 /tmp/.himalaya-hook-$$ 2>/dev/null)
rm -f /tmp/.himalaya-hook-$$

if [ -n "$blocked" ]; then
  subcommand=${blocked#DENY }
  deny "Email access is read only. \`himalaya ${subcommand}\` can change or send mail. Read with: envelope list, envelope thread, message read, message export, folder list, attachment download, account list. If you need a change, ask Harlan to make it."
fi

exit 0
