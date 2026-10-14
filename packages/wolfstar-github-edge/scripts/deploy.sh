#!/usr/bin/env bash
# Creates the Cloudflare resources on first run, then deploys the Worker and the Container.
# Every step is idempotent, so the same command also ships each update.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
repository_root=$(cd ../.. && pwd)

wrangler() {
  pnpm exec wrangler "$@"
}

ensure() {
  local description=$1
  shift
  local output
  if output=$("$@" 2>&1); then
    printf 'Created %s.\n' "$description"
  elif grep -qiE 'already exists|already taken|is already|must be unique' <<<"$output"; then
    printf 'Found %s.\n' "$description"
  else
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

wrangler whoami >/dev/null
ensure 'queue wolfstar-github-webhooks' wrangler queues create wolfstar-github-webhooks
ensure 'queue wolfstar-github-webhooks-dlq' wrangler queues create wolfstar-github-webhooks-dlq
ensure 'bucket wolfstar-github-agent-state' wrangler r2 bucket create wolfstar-github-agent-state
# A delivery left in the dead letter queue keeps its body here. A week is long enough to redeliver it.
ensure 'lifecycle rule for deliveries' wrangler r2 bucket lifecycle add wolfstar-github-agent-state \
  expire-deliveries deliveries/ --expire-days 7 --force

# The dashboard shows which commit runs. The image has no .git, so the commit travels as a file.
git -C "$repository_root" rev-parse HEAD >"$repository_root/.deployed-commit"
wrangler deploy
