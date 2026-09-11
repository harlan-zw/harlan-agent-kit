#!/usr/bin/env bash
# Publishes one Artifact fragment as a local HTML file, wrapped in the same
# skeleton claude.ai uses, so a fragment publishes unchanged on either host.
#
# Usage: publish.sh <slug> <fragment.html> [--open]
# Writes: $HARLAN_ARTIFACT_DIR/<slug>.html (default ~/scratch/artifacts)
set -uo pipefail

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skeleton="$skill_dir/templates/skeleton.html"
mermaid_tag='<script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.15.0/mermaid.min.js"></script><script>mermaid.initialize({ startOnLoad: true, theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" })</script>'

fail() { printf '%s\n' "$1" >&2; exit 1; }

slug="${1:-}"
fragment="${2:-}"
open_after=0
[ "${3:-}" = "--open" ] && open_after=1

[ -n "$slug" ] && [ -n "$fragment" ] || fail 'Usage: publish.sh <slug> <fragment.html> [--open]'
[[ "$slug" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || fail "The slug must use lowercase letters, digits, and single hyphens: $slug"
[ -f "$fragment" ] || fail "The fragment does not exist: $fragment"
[ -f "$skeleton" ] || fail "The skeleton is missing: $skeleton"

# A full document renders differently on the two hosts. Refuse it here so the
# author fixes the fragment instead of shipping two versions of one page.
if grep -qiE '<!doctype|<html[[:space:]>]|<head[[:space:]>]|<body[[:space:]>]' "$fragment"; then
  fail 'The fragment must not contain <!doctype>, <html>, <head>, or <body>. Start with <title> and <style>.'
fi
grep -qi '<title>' "$fragment" || fail 'The fragment needs a <title> near the top. Name the page like a product.'

size=$(wc -c < "$fragment")
[ "$size" -le $((16 * 1024 * 1024)) ] || fail 'The fragment is over 16 MB. Embedded data URIs count.'

out_dir="${HARLAN_ARTIFACT_DIR:-$HOME/scratch/artifacts}"
mkdir -p "$out_dir" || fail "Could not create $out_dir"
out="$out_dir/$slug.html"

mermaid=''
grep -q 'class="mermaid"' "$fragment" && mermaid="$mermaid_tag"

# awk keeps the fragment byte for byte; sed would interpret its backslashes.
awk -v fragment="$fragment" -v mermaid="$mermaid" '
  $0 == "<!-- artifact:mermaid -->" { if (mermaid != "") print mermaid; next }
  $0 == "<!-- artifact:fragment -->" {
    while ((getline line < fragment) > 0) print line
    close(fragment)
    next
  }
  { print }
' "$skeleton" > "$out.tmp" && mv "$out.tmp" "$out" || fail "Could not write $out"

printf '%s\n' "$out"
if [ "$open_after" -eq 1 ]; then
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$out" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then open "$out"
  else printf 'No opener found. Open the path above in a browser.\n' >&2
  fi
fi
