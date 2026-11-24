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

# A repository where each config binds the same names to different databases.
# The Hook must read the one config wrangler would read, never a neighbour.
repo="$work/repo"
mkdir -p "$repo/apps/pro" "$repo/apps/site" "$repo/.generated"
git -C "$repo" init -q
printf '.generated/\n' > "$repo/.gitignore"
cat > "$repo/wrangler.toml" <<'TOML'
d1_databases = [
  { binding = "DB", database_name = "main-db", database_id = "55555555-5555-5555-5555-555555555555" },
]
TOML
cat > "$repo/.generated/wrangler.json" <<'JSON'
{ "d1_databases": [{ "binding": "DB", "database_name": "main-db-staging", "database_id": "88888888-8888-8888-8888-888888888888" }] }
JSON
cat > "$repo/apps/pro/wrangler.toml" <<'TOML'
name = "pro"
# [[d1_databases]]
# database_id = "00000000-0000-0000-0000-000000000000"

[[d1_databases]]
binding = "PRO_DB"
database_name = "pro-db"
database_id = "12121212-1212-1212-1212-121212121212"

[env.staging]
name = "pro-staging"

[[env.staging.d1_databases]]
binding = "PRO_DB"
database_name = "pro-db-staging"
database_id = "66666666-6666-6666-6666-666666666666"
TOML
# `wrangler d1 execute` ignores a deploy redirect, so the default config still decides.
mkdir -p "$repo/apps/pro/.wrangler/deploy"
printf '{"configPath":"../../wrangler.prod.toml"}\n' > "$repo/apps/pro/.wrangler/deploy/config.json"
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
  // the site reads the shared table, see https://example.com/d1
  /* retired: { "binding": "SITE_DB", "database_id": "44444444-4444-4444-4444-444444444444" } */
  "d1_databases": [
    { "database_id": "33333333-3333-3333-3333-333333333333", "binding": "SITE_DB", "database_name": "site-db", "preview_database_id": "99999999-9999-9999-9999-999999999999" },
  ],
  "env": {
    "staging": { "d1_databases": [{ "binding": "SITE_DB", "database_name": "site-db-staging", "database_id": "77777777-7777-7777-7777-777777777777" }] },
  },
}
JSONC

# Prints the decision, then the reason when the hook denies. The call runs from $repo/$3.
run() {
  local path=$1 cmd=$2 out
  out="$(jq -nc --arg c "$cmd" --arg cwd "$repo/${3:-}" '{cwd:$cwd,tool_input:{command:$c}}' | PATH="$path" bash "$hook")"
  [ -n "$out" ] || { echo allow; return; }
  printf '%s' "$out" | jq -r '"\(.hookSpecificOutput.permissionDecision) \(.hookSpecificOutput.permissionDecisionReason)"'
}

expect() {
  local want=$1 cmd=$2 got
  got="$(run "$with_cf" "$cmd" apps/pro)"
  if [ "${got%% *}" != "$want" ]; then
    printf 'FAIL  expected %s, got %s for: %s\n' "$want" "$got" "$cmd"
    fail=1
  fi
}

# Usage: expect_reason <directory> <text the reason must hold> <command>
expect_reason() {
  local dir=$1 pattern=$2 cmd=$3 got
  got="$(run "$with_cf" "$cmd" "$dir")"
  if ! printf '%s' "$got" | grep -qF -- "$pattern"; then
    printf 'FAIL  expected reason with %s, got %s for: %s (in %s)\n' "$pattern" "$got" "$cmd" "$dir"
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

# The reason names the id from the config wrangler reads for this call, found by name or binding.
staging='cf d1 query 88888888-8888-8888-8888-888888888888 -q --sql'
expect_reason '' "$staging" 'wrangler d1 execute DB --remote --config .generated/wrangler.json --command "SELECT 1"'
expect_reason '' "$staging" 'pnpm exec wrangler d1 execute main-db-staging --remote -c .generated/wrangler.json --command "SELECT 1"'
expect_reason '' 'cf d1 query 55555555-5555-5555-5555-555555555555 -q --sql' 'wrangler d1 execute DB --remote --command "SELECT 1"'
expect_reason apps/pro 'cf d1 query 55555555-5555-5555-5555-555555555555 -q --sql' 'wrangler d1 execute DB --remote --cwd ../.. --command "SELECT 1"'
prod='cf d1 query 11111111-1111-1111-1111-111111111111 -q --sql'
expect_reason apps/pro "$prod" 'pnpm exec wrangler d1 execute pro-db --remote --json --config wrangler.prod.toml --command "SELECT 1"'
expect_reason apps/pro "$prod" 'wrangler d1 execute --config=wrangler.prod.toml PRO_DB --remote --command "SELECT 1"'
expect_reason '' "$prod" 'cd apps/pro && pnpm exec wrangler d1 execute pro-db --remote --config wrangler.prod.toml --command "SELECT 1"'
expect_reason '' "$prod" 'cd "apps/pro" && wrangler d1 execute pro-db --remote --config wrangler.prod.toml --command "SELECT 1"'
expect_reason '' 'cf d1 query 22222222-2222-2222-2222-222222222222 -q --sql' 'pnpm -C apps/pro exec wrangler d1 execute PAGES_DB --remote -c wrangler.prod.toml --command "SELECT 1"'
expect_reason apps/pro 'cf d1 query 12121212-1212-1212-1212-121212121212 -q --sql' 'wrangler d1 execute pro-db --remote --command "SELECT 1"'
expect_reason apps/pro 'cf d1 query 66666666-6666-6666-6666-666666666666 -q --sql' 'wrangler d1 execute PRO_DB --remote --env staging --command "SELECT 1"'
expect_reason apps/site 'cf d1 query 33333333-3333-3333-3333-333333333333 -q --sql' 'wrangler d1 execute --remote site-db --command "SELECT 1"'
expect_reason apps/site 'cf d1 query 77777777-7777-7777-7777-777777777777 -q --sql' 'wrangler d1 execute SITE_DB --remote -e staging --command "SELECT 1"'
expect_reason apps/pro 'cf d1 query 66666666-6666-6666-6666-666666666666 -q --sql' 'CLOUDFLARE_ENV=staging wrangler d1 execute PRO_DB --remote --command "SELECT 1"'

# Without a certain config and environment, the reason names no id.
unknown='cf d1 query <database_id> -q --sql'
expect_reason apps/pro "$unknown" 'wrangler d1 execute pro-db --remote --config wrangler.dev.toml --command "SELECT 1"'
expect_reason apps/pro "$unknown" 'wrangler d1 execute pro-db --remote --env production --command "SELECT 1"'
expect_reason apps/pro "$unknown" 'wrangler d1 execute pages-db --remote --command "SELECT 1"'
expect_reason '' "$unknown" 'cd "$APP" && wrangler d1 execute pro-db --remote --config wrangler.prod.toml --command "SELECT 1"'
expect_reason '' "$unknown" 'pnpm --filter pro exec wrangler d1 execute pro-db --remote --command "SELECT 1"'
expect_reason '' "$unknown" '(cd apps/pro && ls); wrangler d1 execute pro-db --remote --config wrangler.prod.toml --command "SELECT 1"'
expect_reason '' "$unknown" 'wrangler d1 execute DB --remote --config missing.toml --command "SELECT 1"'
expect_reason apps/pro "$unknown" 'wrangler d1 execute "pro-db" --remote --command "SELECT 1"'
expect_reason apps/pro 'from the d1_databases entry of the wrangler config this call reads' 'wrangler d1 execute missing-db --remote --command "SELECT 1"'
for id in 55555555-5555-5555-5555-555555555555 44444444-4444-4444-4444-444444444444 99999999-9999-9999-9999-999999999999; do
  for cmd in 'wrangler d1 execute DB --remote --config .generated/wrangler.json --command "SELECT 1"' 'cd apps/site && wrangler d1 execute SITE_DB --remote --command "SELECT 1"'; do
    got="$(run "$with_cf" "$cmd")"
    [[ "$got" != *"$id"* ]] || { printf 'FAIL  reason names %s for: %s\n' "$id" "$cmd"; fail=1; }
  done
done

# Without cf, or with a token wrangler can use, the call goes through as written.
got="$(run "$without_cf" 'wrangler d1 execute pro-db --remote --command "SELECT 1"')"
[ "$got" = allow ] || { printf 'FAIL  expected allow without cf, got %s\n' "$got"; fail=1; }
got="$(jq -nc '{tool_input:{command:"wrangler d1 execute pro-db --remote --command \"SELECT 1\""}}' | PATH="$with_cf" CLOUDFLARE_API_TOKEN=x bash "$hook")"
[ -z "$got" ] || { printf 'FAIL  expected allow with CLOUDFLARE_API_TOKEN, got %s\n' "$got"; fail=1; }

[ "$fail" -eq 0 ] && echo 'ok    cf-d1-routing'
exit "$fail"
