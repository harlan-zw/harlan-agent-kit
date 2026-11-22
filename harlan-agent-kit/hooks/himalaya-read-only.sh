#!/usr/bin/env bash
# PreToolUse (Bash): keeps email access read only by default.
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
source "$(dirname "$0")/hit-log.sh"
is_hook_disabled "himalaya-read-only" && exit 0

input=$(cat)
command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

[ -n "$command" ] || exit 0

# A user-level setting can allow one standalone save to Zoho Drafts.
# Match literal file paths and fixed account and folder arguments.
draft_path="((/|~/)[a-zA-Z0-9_./-]+\\.eml|'/[a-zA-Z0-9_./ -]+\\.eml')"
draft_save="^[[:blank:]]*himalaya[[:blank:]]+message[[:blank:]]+save[[:blank:]]+-a[[:blank:]]+harlanzw[[:blank:]]+-f[[:blank:]]+Drafts[[:blank:]]*<[[:blank:]]*${draft_path}[[:blank:]]*$"
if [[ "$command" =~ $draft_save ]] \
  && jq -e '.allowZohoDrafts == true' "${XDG_CONFIG_HOME:-$HOME/.config}/harlan-agent-kit/email.json" >/dev/null 2>&1; then
  exit 0
fi

deny() {
  jq -nc --arg reason "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  log_hook_hit deny "$1" "$input"
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
  deny "Email access is read only by default. \`himalaya ${subcommand}\` can change or send mail. For an authorized Zoho draft, see the email-usage skill. Ask Harlan to make any other change."
fi

exit 0
