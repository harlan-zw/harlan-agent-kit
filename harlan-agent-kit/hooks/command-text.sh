#!/bin/bash
# Shared command text helpers for hooks.
# Source this in other hooks: source "$(dirname "$0")/command-text.sh"
#
# A hook matches a call only at a command position. Prose that names a command
# is not a call, so heredoc bodies and quoted spans drop out first. Each command
# line becomes one output line, so every newline between them is a separator.

# Prints what the shell would run, with every heredoc body and quoted span gone.
# One scanner reads the text character by character, so quotes, escapes and
# heredoc openers all read the same state. A heredoc opener found inside a
# quoted span is prose, and a body starts only once the command line ends.
drop_prose() {
  awk '
    # Reads one physical line. Returns its command text.
    # Sets cont when the line ends in a continuation, so the caller joins it.
    function scan(line,   i, n, c, rest, opener, out) {
      out = ""
      cont = 0
      i = 1
      n = length(line)
      while (i <= n) {
        c = substr(line, i, 1)
        if (quote == 1) {
          # A single quoted span takes no escapes.
          if (c == "\047") quote = 0
          i++
          continue
        }
        if (c == "\\") {
          # A backslash escapes the next character. At the end of the line it
          # joins the next line instead.
          if (i == n) cont = 1
          i += 2
          continue
        }
        if (quote == 2) {
          if (c == "\042") quote = 0
          i++
          continue
        }
        if (c == "\047") { quote = 1; i++; continue }
        if (c == "\042") { quote = 2; i++; continue }
        # A here string carries no body, so it must not open one.
        if (substr(line, i, 3) == "<<<") { i += 3; continue }
        if (substr(line, i, 2) == "<<") {
          rest = substr(line, i)
          if (match(rest, /^<<-?[[:space:]]*[\047\042]?[A-Za-z_][A-Za-z0-9_]*[\047\042]?/)) {
            opener = substr(rest, 1, RLENGTH)
            i += RLENGTH
            sub(/^<<-?[[:space:]]*/, "", opener)
            gsub(/[\047\042]/, "", opener)
            pending = opener
            continue
          }
          i += 2
          continue
        }
        out = out c
        i++
      }
      return out
    }
    BEGIN { quote = 0; body = 0; pending = ""; held = "" }
    body == 1 {
      if ($0 ~ "^[[:space:]]*" marker "[[:space:]]*$") body = 0
      next
    }
    {
      held = held scan($0)
      # A continuation or an open quoted span means the command line goes on.
      if (cont == 1 || quote != 0) next
      print held
      held = ""
      if (pending != "") { marker = pending; pending = ""; body = 1 }
    }
    END { if (held != "") print held }
  '
}

# Prints one line where every command position follows ^, |, &, ;, ( or a space.
command_code() {
  printf '%s\n' "$1" | drop_prose | tr '\n' ';'
}
