#!/usr/bin/env bash
# Verifies the cf-d1-routing hook sends remote D1 queries to cf and names the database id.
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

# A repository with one TOML config, one JSONC config, and a name that two configs disagree on.
repo="$work/repo"
mkdir -p "$repo/apps/pro" "$repo/apps/site"
git -C "$repo" init -q
cat > "$repo/apps/pro/wrangler.prod.toml" <<'TOML'
name = "pro"

[[d1_databases]]
binding = "PRO_DB"
database_name = "pro-db"
database_id = "11111111-1111-1111-1111-111111111111"
preview_database_id = "99999999-9999-9999-9999-999999999999"

[[d1_databases]]
binding = "PAGES_DB"
database_name = "pages-db"
database_id = "22222222-2222-2222-2222-222222222222"

[vars]
database_id = "not-a-database"
TOML
cat > "$repo/apps/pro/wrangler.dev.toml" <<'TOML'
[[d1_databases]]
binding = "PRO_DB"
database_name = "pro-db"
database_id = "local"
TOML
cat > "$repo/apps/site/wrangler.jsonc" <<'JSONC'
{
  // the site reads the shared table
  "d1_databases": [
    { "database_id": "33333333-3333-3333-3333-333333333333", "binding": "SITE_DB", "database_name": "site-db", "preview_database_id": "88888888-8888-8888-8888-888888888888" },
    { "binding": "TWIN", "database_name": "twin-db", "database_id": "44444444-4444-4444-4444-444444444444" }
  ]
}
JSONC
cat > "$repo/wrangler.staging.toml" <<'TOML'
d1_databases = [{ binding = "TWIN", database_name = "twin-db", database_id = "55555555-5555-5555-5555-555555555555" }]
TOML

# Prints the decision, then the reason when the hook denies.
run() {
  local path=$1 cmd=$2 out
  out="$(jq -nc --arg c "$cmd" --arg cwd "$repo/apps/pro" '{cwd:$cwd,tool_input:{command:$c}}' | PATH="$path" bash "$hook")"
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

expect_reason() {
  local pattern=$1 cmd=$2 got
  got="$(run "$with_cf" "$cmd")"
  if ! printf '%s' "$got" | grep -qF -- "$pattern"; then
    printf 'FAIL  expected reason with %s, got %s for: %s\n' "$pattern" "$got" "$cmd"
    fail=1
  fi
}

# Remote queries with --command, through every runner.
expect deny 'wrangler d1 execute pro-db --remote --command "SELECT 1"'
expect deny 'pnpm exec wrangler d1 execute pro-db --remote --json --config wrangler.prod.toml --command "SELECT 1"'
expect deny 'cd apps/pro && pnpm exec wrangler d1 execute pro-db --remote --command "SELECT 1"'
expect deny 'pnpm -C apps/pro exec wrangler d1 execute pro-db --remote --command "SELECT 1"'
expect deny 'pnpm dlx wrangler@4 d1 execute pro-db --remote --command="SELECT 1"'
expect deny 'npx -y wrangler d1 execute pro-db --command "SELECT 1" --remote'
expect deny './node_modules/.bin/wrangler d1 execute pro-db --remote --command "SELECT 1"'
expect deny 'CLOUDFLARE_ACCOUNT_ID=abc wrangler --config wrangler.prod.toml d1 execute pro-db --remote --command "SELECT 1"'
expect deny 'git status; wrangler d1 execute pro-db --remote --command "SELECT 1" | jq .'

# Calls that cf does not replace, or that need no login.
expect allow 'wrangler d1 execute pro-db --local --command "SELECT 1"'
expect allow 'wrangler d1 execute pro-db --command "SELECT 1"'
expect allow 'wrangler d1 execute pro-db --remote --file dump.sql'
expect allow 'wrangler d1 migrations apply pro-db --remote'
expect allow 'wrangler deploy --config wrangler.prod.toml'
expect allow 'wrangler d1 execute pro-db --local --command "SELECT 1 -- --remote"'
expect allow 'CLOUDFLARE_API_TOKEN=x wrangler d1 execute pro-db --remote --command "SELECT 1"'

# Prose that names the call is not a call.
expect allow 'rg -n "wrangler d1 execute pro-db --remote --command" docs/'
expect allow "echo 'run wrangler d1 execute pro-db --remote --command'"
expect allow "$(printf 'cat > notes.md <<EOF\nwrangler d1 execute pro-db --remote --command "SELECT 1"\nEOF\n')"
expect deny "$(printf 'cat > notes.md <<EOF\nprose\nEOF\nwrangler d1 execute pro-db --remote --command "SELECT 1"\n')"

# The reason names the database id, found by name or binding in any wrangler config.
expect_reason 'cf d1 query 11111111-1111-1111-1111-111111111111 -q --sql' 'wrangler d1 execute pro-db --remote --command "SELECT 1"'
expect_reason 'cf d1 query 22222222-2222-2222-2222-222222222222 -q --sql' 'wrangler d1 execute PAGES_DB --remote --command "SELECT 1"'
expect_reason 'cf d1 query 33333333-3333-3333-3333-333333333333 -q --sql' 'wrangler d1 execute --remote site-db --command "SELECT 1"'
expect_reason 'cf d1 query 11111111-1111-1111-1111-111111111111 -q --sql' 'wrangler d1 execute --config wrangler.prod.toml pro-db --remote --command "SELECT 1"'
expect_reason '44444444-4444-4444-4444-444444444444 (apps/site/wrangler.jsonc), 55555555-5555-5555-5555-555555555555 (wrangler.staging.toml)' 'wrangler d1 execute twin-db --remote --command "SELECT 1"'
expect_reason 'Read database_id for `missing-db` from the d1_databases entry' 'wrangler d1 execute missing-db --remote --command "SELECT 1"'
expect_reason 'cf d1 query <database_id> -q --sql' 'wrangler d1 execute "pro-db" --remote --command "SELECT 1"'

# Without cf, or with a token wrangler can use, the call goes through as written.
got="$(run "$without_cf" 'wrangler d1 execute pro-db --remote --command "SELECT 1"')"
[ "$got" = allow ] || { printf 'FAIL  expected allow without cf, got %s\n' "$got"; fail=1; }
got="$(jq -nc '{tool_input:{command:"wrangler d1 execute pro-db --remote --command \"SELECT 1\""}}' | PATH="$with_cf" CLOUDFLARE_API_TOKEN=x bash "$hook")"
[ -z "$got" ] || { printf 'FAIL  expected allow with CLOUDFLARE_API_TOKEN, got %s\n' "$got"; fail=1; }

[ "$fail" -eq 0 ] && echo 'ok    cf-d1-routing'
exit "$fail"
