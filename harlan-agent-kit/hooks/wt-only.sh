#!/bin/bash
# Keeps every worktree under the `wt` (worktrunk) tool and its canonical path.
#
# `wt` places each worktree at `<parent>/<repo>.<branch-slug>`, fixed by
# ~/.config/worktrunk/config.toml. Raw `git worktree add` and harness worktree
# options scatter checkouts into the banned harness directory and other ad hoc
# paths.
#
# Read-only `git worktree list` stays allowed.
#
# A call counts only at a command position, matching pr-skill-only.sh and
# himalaya-read-only.sh. Prose that names a command or the banned path is not a
# call, so heredoc bodies and quoted spans are dropped before the match. An
# inline environment assignment before the binary is not matched, which is the
# known gap in this shape. A quoted real path is not matched either.
source "$(dirname "$0")/check-config.sh"
is_hook_disabled "wt-only" && exit 0

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

[ -n "$command" ] || exit 0

block() {
  jq -nc --arg reason "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}

# Prints what the shell would run, with every heredoc body and quoted span gone.
# Quote state carries across lines, so a multi-line string stays prose.
drop_prose() {
  awk '
    function strip(line,   i, c, out) {
      out = ""
      for (i = 1; i <= length(line); i++) {
        c = substr(line, i, 1)
        if (quote == 0) {
          if (c == "\047") { quote = 1; continue }
          if (c == "\042") { quote = 2; continue }
          out = out c
          continue
        }
        if (quote == 1 && c == "\047") quote = 0
        else if (quote == 2 && c == "\042") quote = 0
      }
      return out
    }
    BEGIN { quote = 0; body = 0 }
    body == 1 {
      if ($0 ~ "^[[:space:]]*" marker "[[:space:]]*$") body = 0
      next
    }
    {
      guarded = $0
      # A here string carries no body, so it must not open one.
      gsub(/<<</, "===", guarded)
      if (match(guarded, /<<-?[[:space:]]*[\047\042]?[A-Za-z_][A-Za-z0-9_]*[\047\042]?/)) {
        marker = substr(guarded, RSTART, RLENGTH)
        sub(/^<<-?[[:space:]]*/, "", marker)
        gsub(/[\047\042]/, "", marker)
        body = 1
      }
      print strip($0)
    }
  '
}

# Each line starts a command, so a newline reads as a separator.
code=$(printf '%s\n' "$command" | drop_prose | tr '\n' ';')

command_start='(^|[|&;\(][[:space:]]*)'
command_end='([[:space:]]|;|$)'
banned_path='.claude/worktrees'
git_worktree="${command_start}git[[:space:]]+([^|&;]*[[:space:]])?worktree[[:space:]]+(add|remove|move|prune)${command_end}"
wt_clobber="${command_start}wt[[:space:]]+[^|&;]*--clobber(=|${command_end})"
wt_force_remove="${command_start}wt[[:space:]]+remove[[:space:]]+[^|&;]*--force"

if [[ "$code" =~ $git_worktree ]]; then
  block "Use wt, not git worktree. Create: wt switch --create <branch> --base <base>. Enter: wt switch <branch>. Remove: wt remove <branch>. Read paths from wt list --format=json. See references/worktree-isolation.md."
fi

if [[ "$code" == *"$banned_path"* ]]; then
  block "$banned_path is banned. wt owns every worktree at <parent>/<repo>.<branch-slug>. See references/worktree-isolation.md."
fi

if [[ "$code" =~ $wt_clobber ]]; then
  block "wt switch --clobber destroys another task's worktree. Pick a different branch name."
fi

if [[ "$code" =~ $wt_force_remove ]]; then
  block "wt remove --force drops unmerged work. Merge or land the branch first."
fi

exit 0
