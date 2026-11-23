#!/usr/bin/env bash
# PreToolUse (Bash): send remote D1 queries through cf, which keeps its own login.
# The wrangler OAuth login expires. A non-interactive agent cannot renew it,
# so `wrangler d1 execute --remote` fails with "Not logged in".
source "$(dirname "$0")/check-config.sh"
source "$(dirname "$0")/command-text.sh"
source "$(dirname "$0")/hit-log.sh"
is_hook_disabled "cf-d1-routing" && exit 0

input=$(cat)

deny() {
  jq -nc --arg reason "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  log_hook_hit deny "$1" "$input"
  exit 0
}

command=$(printf '%s' "$input" | jq -r '.tool_input.command // .tool_input.cmd // empty')
[ -n "$command" ] || exit 0
# Without cf there is nothing to send the agent to.
command -v cf >/dev/null 2>&1 || exit 0
# An API token keeps wrangler signed in, so the call works as written.
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] && exit 0
[[ "$command" == *CLOUDFLARE_API_TOKEN* ]] && exit 0

# Quoted spans drop out, so SQL text and prose never read as flags.
code=$(command_code "$command")
lead_item='[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|command|exec|time|timeout[[:space:]]+[^[:space:]]+|do|then|else|!'
runner='(pnpm([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*([[:space:]]+(exec|dlx))?|pnpx|npx([[:space:]]+-[^[:space:]]+)*|bunx|bun[[:space:]]+x|yarn)[[:space:]]+'
call_re="^[[:space:]\(\`]*((${lead_item})[[:space:]]+)*(${runner})?([^[:space:]]*/)?wrangler(@[^[:space:]]+)?[[:space:]]+([^[:space:]]+[[:space:]]+)*d1[[:space:]]+execute([[:space:]]|$)"

database=''
matched=false
IFS=';|&' read -r -a calls <<< "$code"
for call in "${calls[@]}"; do
  [[ "$call" =~ $call_re ]] || continue
  # Local queries need no login. cf d1 query has no --file, so files stay with wrangler.
  [[ "$call" =~ [[:space:]]--remote(=true)?([[:space:]]|$) ]] || continue
  [[ "$call" =~ [[:space:]]--command([[:space:]=]|$) ]] || continue
  matched=true
  # The database is the first positional word after `execute`. A quoted name dropped out above.
  read -r -a words <<< "${call#*d1*execute}"
  skip=false
  for word in "${words[@]}"; do
    if [ "$skip" = true ]; then skip=false; continue; fi
    case "$word" in
      --config|-c|--env|-e|--file|--persist-to|--batch-size|--cwd) skip=true ;;
      -*) ;;
      *) database=$word; break ;;
    esac
  done
  break
done
[ "$matched" = true ] || exit 0

# Prints "id<TAB>name<TAB>binding" for each D1 database in one wrangler config.
d1_databases() {
  local file=$1
  if [[ "$file" == *.toml ]]; then
    awk '
      function value(line) { sub(/^[^=]*=[[:space:]]*"/, "", line); sub(/".*$/, "", line); return line }
      function flush() { if (inside && id != "") print id "\t" name "\t" binding; id = ""; name = ""; binding = "" }
      /^[[:space:]]*\[/ { flush(); inside = ($0 ~ /^[[:space:]]*\[\[([A-Za-z0-9_.-]+\.)?d1_databases\]\]/); next }
      inside && /^[[:space:]]*binding[[:space:]]*=/ { binding = value($0) }
      inside && /^[[:space:]]*database_name[[:space:]]*=/ { name = value($0) }
      inside && /^[[:space:]]*database_id[[:space:]]*=/ { id = value($0) }
      END { flush() }
    ' "$file"
  fi
  # JSON, JSONC, and TOML inline tables hold each database as one flat object.
  sed -E 's#^[[:space:]]*//.*##' "$file" | tr '\n' ' ' | grep -oE '\{[^{}]*database_id[^{}]*\}' | while read -r object; do
    field() { printf '%s' "$object" | sed -nE "s/.*(^|[^A-Za-z_])$1\"?[[:space:]]*[:=][[:space:]]*\"([^\"]*)\".*/\\2/p"; }
    printf '%s\t%s\t%s\n' "$(field database_id)" "$(field database_name)" "$(field binding)"
  done
}

reason='The wrangler login expires, and an agent cannot renew it. Query remote D1 with cf, which keeps its own login.'
usage='cf d1 query <database_id> -q --sql "<SQL>"'
if [ -n "$database" ]; then
  cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
  cwd=${cwd:-$PWD}
  root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$root" ]; then
    configs=$(git -C "$root" ls-files --cached --others --exclude-standard --full-name -- '*wrangler*.toml' '*wrangler*.json' '*wrangler*.jsonc' 2>/dev/null)
  else
    root=$cwd
    configs=$(cd "$cwd" && find . -maxdepth 3 -name 'wrangler*' -not -path '*/node_modules/*' \( -name '*.toml' -o -name '*.json' -o -name '*.jsonc' \) 2>/dev/null)
  fi
  matches=''
  while IFS= read -r config; do
    [ -n "$config" ] && [ -f "$root/$config" ] || continue
    while IFS=$'\t' read -r id name binding; do
      # A remote database id is a UUID. A local dev config can hold a placeholder such as "local".
      [[ "$id" =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]] || continue
      [ "$name" = "$database" ] || [ "$binding" = "$database" ] || continue
      matches+="$id"$'\t'"${config#./}"$'\n'
    done < <(d1_databases "$root/$config")
  done <<< "$configs"
  ids=$(printf '%s' "$matches" | cut -f1 | sort -u | sed '/^$/d')
  count=$(printf '%s' "$ids" | grep -c .)
  if [ "$count" -eq 1 ]; then
    usage="cf d1 query $ids -q --sql \"<SQL>\""
  elif [ "$count" -gt 1 ]; then
    list=$(printf '%s' "$matches" | sort -u | awk -F'\t' 'NF { printf "%s%s (%s)", sep, $1, $2; sep = ", " }')
    usage="$usage. \`$database\` has more than one database_id: $list"
  else
    usage="$usage. Read database_id for \`$database\` from the d1_databases entry in the wrangler config"
  fi
fi
deny "$reason Run: $usage. The output is one JSON result set per statement, as with wrangler --json. If you set CLOUDFLARE_API_TOKEN, wrangler works as written."
