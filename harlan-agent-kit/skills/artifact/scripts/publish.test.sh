#!/usr/bin/env bash
# Verifies publish.sh wraps a fragment like claude.ai does and refuses what it must.
set -uo pipefail

publish="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/publish.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export HARLAN_ARTIFACT_DIR="$work/out"
fail=0
bad() { printf 'FAIL  %s\n' "$1"; fail=1; }

printf '<title>Incident Review</title>\n<style>body{background:var(--bg)}</style>\n<p>a \\ backslash &amp; ampersand</p>\n' > "$work/plain.html"
out=$(bash "$publish" incident-review "$work/plain.html") || bad 'a plain fragment should publish'
[ "$out" = "$work/out/incident-review.html" ] || bad "unexpected output path: $out"
grep -q '^<!doctype html>' "$out" || bad 'the output should start with the skeleton doctype'
grep -q '<title>Incident Review</title>' "$out" || bad 'the fragment title should survive'
grep -qF 'a \ backslash &amp; ampersand' "$out" || bad 'the fragment body should survive byte for byte'
grep -q 'mermaid.min.js' "$out" && bad 'Mermaid should not load when no diagram uses it'

printf '<title>Flow</title>\n<pre class="mermaid">flowchart LR\nA-->B</pre>\n' > "$work/diagram.html"
out=$(bash "$publish" flow "$work/diagram.html") || bad 'a mermaid fragment should publish'
grep -q 'mermaid/11.15.0/mermaid.min.js' "$out" || bad 'Mermaid should load from cdnjs when a diagram uses it'
awk '/mermaid.min.js/ { seen = NR } /<pre class="mermaid">/ { if (!seen) exit 1 }' "$out" || bad 'Mermaid should load in the head, before the diagram'

bash "$publish" flow "$work/diagram.html" >/dev/null || bad 'republishing the same slug should overwrite'
[ "$(ls "$work/out" | wc -l)" -eq 2 ] || bad 'the same slug should keep the same path'

printf '<!doctype html><html><head><title>Doc</title></head><body>x</body></html>\n' > "$work/document.html"
bash "$publish" doc "$work/document.html" >/dev/null 2>&1 && bad 'a full document should be refused'

printf '<style>p{}</style><p>no title</p>\n' > "$work/untitled.html"
bash "$publish" untitled "$work/untitled.html" >/dev/null 2>&1 && bad 'a fragment without a title should be refused'

bash "$publish" 'Bad Slug' "$work/plain.html" >/dev/null 2>&1 && bad 'an uppercase or spaced slug should be refused'
bash "$publish" missing "$work/nope.html" >/dev/null 2>&1 && bad 'a missing fragment should be refused'

[ "$fail" -eq 0 ] && echo 'ok    artifact publish'
exit "$fail"
