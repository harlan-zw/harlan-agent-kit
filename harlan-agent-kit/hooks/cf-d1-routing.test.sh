#!/usr/bin/env bash
# Verifies the cf-d1-routing hook sends remote D1 queries to cf and never names a database id.
set -uo pipefail

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Hook decisions append to the hit log. Keep test runs out of the real one.
export XDG_STATE_HOME="$work/state"
unset CLOUDFLARE_API_TOKEN

hook="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cf-d1-routing.sh"
fail=0

# A stand-in cf on PATH. The hook only checks that cf exists.
mkdir -p "$work/bin"
printf '#!/bin/sh\nexit 0\n' > "$work/bin/cf"
chmod +x "$work/bin/cf"
with_cf="$work/bin:/usr/bin:/bin"
without_cf="/usr/bin:/bin"

# A config with a real-looking id beside the call. The reason must still name none,
# because the shell text cannot prove which config and environment the call reads.
mkdir -p "$work/app"
cat > "$work/app/wrangler.toml" <<'TOML'
[[d1_databases]]
binding = "DB"
database_name = "app-db"
database_id = "11111111-1111-1111-1111-111111111111"
preview_database_id = "22222222-2222-2222-2222-222222222222"
TOML

# Prints the decision, then the reason when the hook denies.
run() {
  local path=$1 cmd=$2 out
  out="$(jq -nc --arg c "$cmd" --arg cwd "$work/app" '{cwd:$cwd,tool_input:{command:$c}}' | PATH="$path" bash "$hook")"
  [ -n "$out" ] || { echo allow; return; }
  printf '%s' "$out" | jq -r '"\(.hookSpecificOutput.permissionDecision) \(.hookSpecificOutput.permissionDecisionReason)"'
}

expect() {
  local want=$1 cmd=$2 got
  got="$(run "$with_cf" "$cmd")"
  if [ "${got%% *}" != "$want" ]; then
    printf 'FAIL  expected %s, got %s for: %s\n' "$want" "$got" "$cmd"
    fail=1
  fi
}

# Remote queries with --command, through every runner.
expect deny 'wrangler d1 execute app-db --remote --command "SELECT 1"'
expect deny 'pnpm exec wrangler d1 execute app-db --remote --json --config wrangler.prod.toml --command "SELECT 1"'
expect deny 'cd apps/pro && pnpm exec wrangler d1 execute app-db --remote --command "SELECT 1"'
expect deny 'pnpm -C apps/pro exec wrangler d1 execute app-db --remote --command "SELECT 1"'
expect deny 'pnpm dlx wrangler@4 d1 execute app-db --remote --command="SELECT 1"'
expect deny 'npx -y wrangler d1 execute app-db --command "SELECT 1" --remote'
expect deny './node_modules/.bin/wrangler d1 execute app-db --remote --command "SELECT 1"'
expect deny 'CLOUDFLARE_ACCOUNT_ID=abc wrangler --config wrangler.prod.toml d1 execute app-db --remote --command "SELECT 1"'
expect deny 'git status; wrangler d1 execute app-db --remote --command "SELECT 1" | jq .'

# Preview retries must not select the primary database_id from this fixture.
expect allow 'wrangler d1 execute DB --remote --preview --config wrangler.toml --command "DELETE FROM sessions"'
expect allow 'pnpm exec wrangler d1 execute DB --remote --preview=true --config wrangler.toml --command "DELETE FROM sessions"'
expect allow 'pnpm dlx wrangler@4 d1 execute DB --preview --remote --command="SELECT 1"'

# Calls that cf does not replace, or that need no login.
expect allow 'wrangler d1 execute app-db --local --command "SELECT 1"'
expect allow 'wrangler d1 execute app-db --command "SELECT 1"'
expect allow 'wrangler d1 execute app-db --remote --file dump.sql'
expect allow 'wrangler d1 migrations apply app-db --remote'
expect allow 'wrangler deploy --config wrangler.prod.toml'
expect allow 'wrangler d1 execute app-db --local --command "SELECT 1 -- --remote"'
expect allow 'CLOUDFLARE_API_TOKEN=x wrangler d1 execute app-db --remote --command "SELECT 1"'

# Prose that names the call is not a call.
expect allow 'rg -n "wrangler d1 execute app-db --remote --command" docs/'
expect allow "echo 'run wrangler d1 execute app-db --remote --command'"
expect allow "$(printf 'cat > notes.md <<EOF\nwrangler d1 execute app-db --remote --command "SELECT 1"\nEOF\n')"
expect deny "$(printf 'cat > notes.md <<EOF\nprose\nEOF\nwrangler d1 execute app-db --remote --command "SELECT 1"\n')"

# The reason gives the cf call with a placeholder and never an id.
for cmd in 'wrangler d1 execute app-db --remote --command "SELECT 1"' 'wrangler d1 execute DB --remote --config wrangler.toml --command "SELECT 1"'; do
  got="$(run "$with_cf" "$cmd")"
  [[ "$got" == *'cf d1 query <database_id> -q --sql'* ]] || { printf 'FAIL  reason lacks the cf call for: %s\n' "$cmd"; fail=1; }
  if printf '%s' "$got" | grep -qE '[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}'; then
    printf 'FAIL  reason names a database id for: %s\n' "$cmd"
    fail=1
  fi
done

# Without cf, or with a token wrangler can use, the call goes through as written.
got="$(run "$without_cf" 'wrangler d1 execute app-db --remote --command "SELECT 1"')"
[ "$got" = allow ] || { printf 'FAIL  expected allow without cf, got %s\n' "$got"; fail=1; }
got="$(jq -nc '{tool_input:{command:"wrangler d1 execute app-db --remote --command \"SELECT 1\""}}' | PATH="$with_cf" CLOUDFLARE_API_TOKEN=x bash "$hook")"
[ -z "$got" ] || { printf 'FAIL  expected allow with CLOUDFLARE_API_TOKEN, got %s\n' "$got"; fail=1; }

[ "$fail" -eq 0 ] && echo 'ok    cf-d1-routing'
exit "$fail"
