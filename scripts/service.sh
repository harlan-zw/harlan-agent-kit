#!/usr/bin/env bash
# Controls the harlan-github-agent systemd service.
#
#   service.sh update [REF]   move to REF (default origin/main), rebuild, restart
#   service.sh restart        restart the revision already deployed
#   service.sh status         report what is deployed and whether it answers
#
# The service runs from its own checkout, never from this one, so switching a
# branch here cannot change what production runs. This script is the only
# supported way to move it.
set -euo pipefail

SERVICE_CHECKOUT="${HARLAN_GITHUB_AGENT_CHECKOUT:-$HOME/.local/share/harlan-github-agent/service}"
SERVICE_UNIT=harlan-github-agent
HEALTH_URL=http://127.0.0.1:3210/health
CONFIG_FILE="$HOME/.config/harlan-github-agent/config.yml"
PASSWORD_FILE="$HOME/.config/harlan-github-agent/dashboard-password"

HEALTH_HOST=$(node --input-type=commonjs - "$CONFIG_FILE" <<'NODE'
const { readFileSync } = require('node:fs')

const text = readFileSync(process.argv[2], 'utf8')
const match = text.match(/^\s*allowed_origin:\s*["']?([^\s#"']+)["']?\s*(?:#.*)?$/m)
if (match === null)
  throw new Error('The service configuration needs server.allowed_origin.')
process.stdout.write(new URL(match[1]).host)
NODE
)

deployed() {
  git -C "$SERVICE_CHECKOUT" log --oneline -1
}

# A failed start rolls straight into a systemd restart loop, which looks alive.
# Only a health response proves the new revision actually came up.
wait_for_health() {
  local attempt
  for attempt in $(seq 1 60); do
    if systemctl --user is-active --quiet "$SERVICE_UNIT" \
      && curl -sf -m 5 -o /dev/null \
        -u "agent:$(cat "$PASSWORD_FILE")" \
        -H "Host: $HEALTH_HOST" \
        "$HEALTH_URL"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

report() {
  echo "Deployed: $(deployed)"
  echo "Restarts: $(systemctl --user show "$SERVICE_UNIT" -p NRestarts --value)"
}

require_checkout() {
  if [ ! -d "$SERVICE_CHECKOUT/.git" ]; then
    echo "No service checkout at $SERVICE_CHECKOUT." >&2
    echo "Create one with: git clone git@github.com:harlan-zw/harlan-agent-kit.git $SERVICE_CHECKOUT" >&2
    exit 1
  fi
}

restart_and_verify() {
  echo "Restarting"
  systemctl --user restart "$SERVICE_UNIT"
  if ! wait_for_health; then
    echo "The service did not answer its health check." >&2
    systemctl --user status "$SERVICE_UNIT" --no-pager --lines 20 >&2
    exit 1
  fi
  report
}

command="${1:-update}"
case "$command" in
  update)
    require_checkout
    ref="${2:-origin/main}"
    # The checkout is a deployment. Anything local in it is a mistake worth
    # seeing rather than silently overwriting.
    if [ -n "$(git -C "$SERVICE_CHECKOUT" status --porcelain)" ]; then
      echo "The service checkout has local changes. Inspect it before updating:" >&2
      git -C "$SERVICE_CHECKOUT" status --short >&2
      exit 1
    fi
    echo "Fetching $ref"
    git -C "$SERVICE_CHECKOUT" fetch --quiet origin
    before="$(git -C "$SERVICE_CHECKOUT" rev-parse HEAD)"
    git -C "$SERVICE_CHECKOUT" reset --hard --quiet "$ref"
    if [ "$before" = "$(git -C "$SERVICE_CHECKOUT" rev-parse HEAD)" ]; then
      echo "Already on $(deployed)"
    else
      echo "Moved to $(deployed)"
    fi
    echo "Installing dependencies"
    (cd "$SERVICE_CHECKOUT" && pnpm install --frozen-lockfile >/dev/null)
    echo "Building the dashboard"
    (cd "$SERVICE_CHECKOUT/packages/harlan-github-agent" && pnpm dashboard:build >/dev/null 2>&1)
    restart_and_verify
    ;;
  restart)
    require_checkout
    restart_and_verify
    ;;
  status)
    require_checkout
    report
    if wait_for_health; then
      echo "Health: answering"
    else
      echo "Health: not answering"
      exit 1
    fi
    ;;
  *)
    echo "Unknown command: $command" >&2
    echo "Use update, restart, or status." >&2
    exit 1
    ;;
esac
