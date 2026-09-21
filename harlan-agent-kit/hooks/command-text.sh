#!/bin/bash
# Shared command text helpers for hooks.
# Source this in other hooks: source "$(dirname "$0")/command-text.sh"
#
# A hook matches a call only at a command position. Prose that names a command
# is not a call, so heredoc bodies and quoted spans drop out first. Each line
# starts a command, so every newline becomes a separator.

# Prints what the shell would run, with every heredoc body and quoted span gone.
# Quote state carries across lines, so a multi-line string stays prose.
# Bash joins a backslash-newline outside quotes into one command, so the
# continuation lines merge here, before any newline becomes a separator.
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
    function open_heredoc(line,   guarded) {
      guarded = line
      # A here string carries no body, so it must not open one.
      gsub(/<<</, "===", guarded)
      if (match(guarded, /<<-?[[:space:]]*[\047\042]?[A-Za-z_][A-Za-z0-9_]*[\047\042]?/)) {
        marker = substr(guarded, RSTART, RLENGTH)
        sub(/^<<-?[[:space:]]*/, "", marker)
        gsub(/[\047\042]/, "", marker)
        body = 1
      }
    }
    BEGIN { quote = 0; body = 0; pending = "" }
    body == 1 {
      # A heredoc opener can sit in pending from a backslash continuation.
      # Flush it, so the held line never swallows the command that follows
      # the heredoc; pending stays empty until the body ends.
      if (pending != "") { print pending; pending = "" }
      if ($0 ~ "^[[:space:]]*" marker "[[:space:]]*$") body = 0
      next
    }
    {
      open_heredoc($0)
      pending = pending strip($0)
      # A backslash that survives stripping sits outside quotes, so bash
      # drops it together with the newline and the command keeps going.
      if (pending ~ /\\$/) {
        sub(/\\$/, "", pending)
        next
      }
      print pending
      pending = ""
    }
    END { if (pending != "") print pending }
  '
}

# Prints one line where every command position follows ^, |, &, ;, ( or a space.
command_code() {
  printf '%s\n' "$1" | drop_prose | tr '\n' ';'
}
