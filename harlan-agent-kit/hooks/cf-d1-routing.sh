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
# The same calls with quoted words kept, for values such as a quoted directory.
# Separators outside quotes match, so both lists hold the same calls.
kept=$(command_code "$command" true)
lead_item='[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env|command|exec|time|timeout[[:space:]]+[^[:space:]]+|do|then|else|!'
runner='(pnpm([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*([[:space:]]+(exec|dlx))?|pnpx|npx([[:space:]]+-[^[:space:]]+)*|bunx|bun[[:space:]]+x|yarn)[[:space:]]+'
call_re="^[[:space:]\(\`]*((${lead_item})[[:space:]]+)*(${runner})?([^[:space:]]*/)?wrangler(@[^[:space:]]+)?[[:space:]]+([^[:space:]]+[[:space:]]+)*d1[[:space:]]+execute([[:space:]]|$)"

IFS=';|&' read -r -a calls <<< "$code"
IFS=';|&' read -r -a kept_calls <<< "$kept"
index=-1
for i in "${!calls[@]}"; do
  call=${calls[$i]}
  [[ "$call" =~ $call_re ]] || continue
  # Local queries need no login. cf d1 query has no --file, so files stay with wrangler.
  [[ "$call" =~ [[:space:]]--remote(=true)?([[:space:]]|$) ]] || continue
  [[ "$call" =~ [[:space:]]--command([[:space:]=]|$) ]] || continue
  index=$i
  break
done
[ "$index" -ge 0 ] || exit 0
call=${calls[$index]}

# The database is the first positional word after `execute`. A quoted name dropped out above.
database=''
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

# A database id is safe to name only from the config and environment wrangler would read.
# Any doubt about either leaves `unclear` set, and the reason then names no id.
unclear=false

# Prints a directory joined to a base. Fails for a value the shell would expand.
join_dir() {
  case "$2" in
    '' | *'$'* | *'`'* | *'*'* | *'?'*) return 1 ;;
    '~') printf '%s' "$HOME" ;;
    '~/'*) printf '%s/%s' "$HOME" "${2#'~/'}" ;;
    /*) printf '%s' "$2" ;;
    *) printf '%s/%s' "$1" "$2" ;;
  esac
}

dir=$(printf '%s' "$input" | jq -r '.cwd // empty')
dir=${dir:-$PWD}
# Earlier `cd` calls move the call. A subshell or `popd` hides where it lands.
for ((j = 0; j < index; j++)); do
  [[ "${calls[$j]}" == *')'* || "${calls[$j]}" =~ (^|[[:space:]])popd([[:space:]]|$) ]] && unclear=true
  [[ "${calls[$j]}" =~ ^[[:space:]\(]*(cd|pushd)([[:space:]]|$) ]] || continue
  if [[ "${kept_calls[$j]}" =~ ^[[:space:]\(]*(cd|pushd)[[:space:]]+([^[:space:]]+) ]]; then
    dir=$(join_dir "$dir" "${BASH_REMATCH[2]}") || unclear=true
  else
    dir=$HOME
  fi
done

# Reads flag values from the call with quoted words kept. A flag missing from the
# plain call sits inside quoted SQL or prose, and a repeated flag is unclear.
read -r -a plain <<< "$call"
read -r -a args <<< "${kept_calls[$index]}"
in_plain() {
  local word
  for word in "${plain[@]}"; do [[ "$word" == "$1" || "$word" == "$1="* ]] && return 0; done
  return 1
}
config='' env='' configs=0 envs=0 cwd_flag='' run_dir=''
for ((k = 0; k < ${#args[@]}; k++)); do
  word=${args[$k]}
  name=${word%%=*}
  if [[ "$word" == *=* ]]; then value=${word#*=}; else value=${args[$((k + 1))]:-}; fi
  case "$name" in
    --config | -c) in_plain "$name" && { config=$value; configs=$((configs + 1)); } ;;
    --env | -e) in_plain "$name" && { env=$value; envs=$((envs + 1)); } ;;
    --cwd) in_plain "$name" && cwd_flag=$value ;;
    -C | --dir) in_plain "$name" && run_dir=$value ;;
    --filter | -F | -r | --recursive | -w | --workspace-root) in_plain "$name" && unclear=true ;;
    # An assignment before the command selects the environment too.
    CLOUDFLARE_ENV)
      if [[ "$word" == *=* ]] && { [ "$k" -eq 0 ] || [[ "${args[$((k - 1))]}" == *=* ]]; }; then
        env=$value
        envs=$((envs + 1))
      fi
      ;;
  esac
done
[ "$configs" -le 1 ] && [ "$envs" -le 1 ] || unclear=true
[ "$envs" -eq 0 ] && env=${CLOUDFLARE_ENV:-}
[[ -z "$env" || "$env" =~ ^[A-Za-z0-9_-]+$ ]] || unclear=true
if [ -n "$run_dir" ]; then dir=$(join_dir "$dir" "$run_dir") || unclear=true; fi
if [ -n "$cwd_flag" ]; then dir=$(join_dir "$dir" "$cwd_flag") || unclear=true; fi
dir=$(cd "$dir" 2>/dev/null && pwd -P) || unclear=true

file=''
if [ "$unclear" = false ] && [ -n "$config" ]; then
  case "$config" in *.toml | *.json | *.jsonc) ;; *) unclear=true ;; esac
  file=$(join_dir "$dir" "$config") && [ -f "$file" ] || unclear=true
elif [ "$unclear" = false ]; then
  # Wrangler 4 searches up from the working directory for wrangler.json, then
  # wrangler.jsonc, then wrangler.toml. `d1 execute` ignores the deploy redirect.
  for candidate in wrangler.json wrangler.jsonc wrangler.toml; do
    search=$dir
    while [ -z "$file" ]; do
      [ -f "$search/$candidate" ] && file="$search/$candidate"
      [ "$search" = / ] && break
      search=$(dirname "$search")
    done
    [ -n "$file" ] && break
  done
  [ -n "$file" ] || unclear=true
fi

# Prints "id<TAB>name<TAB>binding" for each D1 database of one environment in a TOML config.
# Wrangler does not inherit d1_databases into an environment, so each scope stands alone.
toml_databases() {
  awk -v want="${2:+env.$2}" '
    function value(line) { sub(/^[^=]*=[[:space:]]*"/, "", line); sub(/".*$/, "", line); return line }
    function field(object, key,   text) {
      text = " " object
      if (!match(text, "[^A-Za-z_]" key "[[:space:]]*=[[:space:]]*\"[^\"]*\"")) return ""
      text = substr(text, RSTART, RLENGTH); sub(/^[^"]*"/, "", text); sub(/"$/, "", text); return text
    }
    function flush() { if (inside && scope == want && id != "") print id "\t" name "\t" binding; inside = 0; id = ""; name = ""; binding = "" }
    function inline(buffer,   count, parts, part, object) {
      count = split(buffer, parts, "}")
      for (part = 1; part <= count; part++) {
        if (!index(parts[part], "{")) continue
        object = substr(parts[part], index(parts[part], "{"))
        if (field(object, "database_id") != "") print field(object, "database_id") "\t" field(object, "database_name") "\t" field(object, "binding")
      }
    }
    {
      line = $0
      sub(/^[[:space:]]*#.*/, "", line)
      sub(/[[:space:]]#[^"]*$/, "", line)
    }
    collecting {
      buffer = buffer " " line
      depth += gsub(/\[/, "[", line) - gsub(/\]/, "]", line)
      if (depth <= 0) { collecting = 0; inline(buffer) }
      next
    }
    line ~ /^[[:space:]]*\[/ {
      flush()
      header = line
      array = (header ~ /^[[:space:]]*\[\[/)
      sub(/^[[:space:]]*\[\[?/, "", header); sub(/\]\]?.*$/, "", header); gsub(/[[:space:]"]/, "", header)
      table = header
      if (array && header ~ /(^|\.)d1_databases$/) { inside = 1; scope = header; sub(/\.?d1_databases$/, "", scope) }
      next
    }
    line ~ /^[[:space:]]*[A-Za-z0-9_."-]*d1_databases[[:space:]]*=/ {
      key = line; sub(/[[:space:]]*=.*$/, "", key); gsub(/[[:space:]"]/, "", key)
      full = (table == "" ? key : table "." key)
      sub(/\.?d1_databases$/, "", full)
      if (full != want) next
      buffer = line; sub(/^[^=]*=/, "", buffer)
      probe = buffer
      depth = gsub(/\[/, "[", probe) - gsub(/\]/, "]", probe)
      if (depth <= 0) inline(buffer); else collecting = 1
      next
    }
    inside && line ~ /^[[:space:]]*binding[[:space:]]*=/ { binding = value(line) }
    inside && line ~ /^[[:space:]]*database_name[[:space:]]*=/ { name = value(line) }
    inside && line ~ /^[[:space:]]*database_id[[:space:]]*=/ { id = value(line) }
    END { flush() }
  ' "$1"
}

# Prints the same lines for a JSON or JSONC config. Comments and trailing commas drop out first.
json_databases() {
  awk '
    {
      out = ""; count = length($0); i = 1
      while (i <= count) {
        c = substr($0, i, 1); pair = substr($0, i, 2)
        if (block) { if (pair == "*/") { block = 0; i += 2 } else i++; continue }
        if (string) {
          out = out c
          if (c == "\\") { out = out substr($0, i + 1, 1); i += 2; continue }
          if (c == "\"") string = 0
          i++; continue
        }
        if (pair == "//") break
        if (pair == "/*") { block = 1; i += 2; continue }
        if (c == "\"") string = 1
        out = out c; i++
      }
      print out
    }
  ' "$1" | tr '\n' ' ' | sed -E 's/,([[:space:]]*[]}])/\1/g' \
    | jq -r --arg env "$2" '(if $env == "" then . else (.env[$env] // {}) end) | (.d1_databases // [])[] | [(.database_id // ""), (.database_name // ""), (.binding // "")] | @tsv' 2>/dev/null
}

reason='The wrangler login expires, and an agent cannot renew it. Query remote D1 with cf, which keeps its own login.'
usage='cf d1 query <database_id> -q --sql "<SQL>"'
if [ -n "$database" ]; then
  ids=''
  if [ "$unclear" = false ]; then
    case "$file" in *.toml) entries=$(toml_databases "$file" "$env") ;; *) entries=$(json_databases "$file" "$env") ;; esac
    while IFS=$'\t' read -r id name binding; do
      # A remote database id is a UUID. A local dev config can hold a placeholder such as "local".
      [[ "$id" =~ ^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$ ]] || continue
      [ "$name" = "$database" ] || [ "$binding" = "$database" ] || continue
      ids+="$id"$'\n'
    done <<< "$entries"
    ids=$(printf '%s' "$ids" | sort -u | sed '/^$/d')
  fi
  if [ -n "$ids" ] && [ "$(printf '%s\n' "$ids" | wc -l)" -eq 1 ]; then
    usage="cf d1 query $ids -q --sql \"<SQL>\""
  else
    usage="$usage. Read database_id for \`$database\` from the d1_databases entry of the wrangler config this call reads"
  fi
fi
deny "$reason Run: $usage. The output is one JSON result set per statement, as with wrangler --json. If you set CLOUDFLARE_API_TOKEN, wrangler works as written."
