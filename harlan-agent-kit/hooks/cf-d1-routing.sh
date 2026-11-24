#!/usr/bin/env bash
# PreToolUse (Bash): send remote D1 queries through cf, which keeps its own login.
# The wrangler OAuth login expires. A non-interactive agent cannot renew it,
# so `wrangler d1 execute --remote` fails with "Not logged in".
#
# The reason never names a database id. The id depends on the working directory,
# config, environment, and preview mode that this one call selects, and the
# shell text cannot settle all of those. The agent reads the id itself.
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

IFS=';|&' read -r -a calls <<< "$code"
for call in "${calls[@]}"; do
  [[ "$call" =~ $call_re ]] || continue
  # Local queries need no login. cf d1 query has no --file, so files stay with wrangler.
  [[ "$call" =~ [[:space:]]--remote(=true)?([[:space:]]|$) ]] || continue
  [[ "$call" =~ [[:space:]]--command([[:space:]=]|$) ]] || continue
  # Preview can select preview_database_id. The cf retry guidance selects database_id.
  [[ "$call" =~ [[:space:]]--preview([[:space:]=]|$) ]] && continue
  deny 'The wrangler login expires, and an agent cannot renew it. Query remote D1 with cf, which keeps its own login. Run: cf d1 query <database_id> -q --sql "<SQL>". Read database_id from the d1_databases entry in the wrangler config and environment this call uses. The output is one JSON result set per statement, as with wrangler --json. If you set CLOUDFLARE_API_TOKEN, wrangler works as written.'
done
exit 0
