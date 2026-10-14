#!/usr/bin/env bash
# Controls the wolfstar-github-agent systemd service.
#
#   service.sh update [REF]   move to REF (default origin/main), rebuild, restart
#   service.sh prepare-update [REF]   move to REF and rebuild without restarting
#   service.sh resolve-update [REF]   fetch and print REF without changing checkout
#   service.sh restart        restart the revision already deployed
#   service.sh revision       print the deployed commit
#   service.sh status         report what is deployed and whether it answers
#
# The service runs from its own checkout, never from this one, so switching a
# branch here cannot change what production runs. This script is the only
# supported way to move it.
set -euo pipefail

SERVICE_CHECKOUT="${WOLFSTAR_GITHUB_AGENT_CHECKOUT:-$HOME/.local/share/wolfstar-github-agent/service}"
SERVICE_UNIT=wolfstar-github-agent
HEALTH_URL=http://127.0.0.1:3210/health
CONFIG_FILE="$HOME/.config/wolfstar-github-agent/config.yml"
# The unit runs the service with this Node. The check below must use the same
# one, because a different version can accept source this one rejects.
SERVICE_NODE="${WOLFSTAR_GITHUB_AGENT_NODE:-$HOME/.local/lib/wolfstar-github-agent/node}"
PASSWORD_FILE="$HOME/.config/wolfstar-github-agent/dashboard-password"

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
      && curl --silent --show-error --max-time 5 --output /dev/null \
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
    echo "Create one with: git clone git@github.com:wolfstar-project/wolfstar-agent-kit.git $SERVICE_CHECKOUT" >&2
    exit 1
  fi
}

resolve_pnpm() {
  if [ -n "${WOLFSTAR_GITHUB_AGENT_PNPM:-}" ]; then
    if [ ! -x "$WOLFSTAR_GITHUB_AGENT_PNPM" ]; then
      echo "The configured pnpm executable does not exist: $WOLFSTAR_GITHUB_AGENT_PNPM" >&2
      exit 1
    fi
    printf '%s\n' "$WOLFSTAR_GITHUB_AGENT_PNPM"
    return
  fi
  if command -v pnpm >/dev/null 2>&1; then
    command -v pnpm
    return
  fi
  for candidate in "$HOME/.local/bin/pnpm" "$HOME"/.local/share/corepack-*/shims/pnpm; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  echo "pnpm is not installed. Install it or set WOLFSTAR_GITHUB_AGENT_PNPM." >&2
  exit 1
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

# Reads the live configuration with the revision that is about to run, while the
# running process keeps serving. A key that revision rejects, such as one naming
# an Agent role it retired, fails here. Starting instead leaves systemd retrying
# a process that can never start, which takes the service down until a person
# edits the configuration.
#
# Both paths that start a process run this: a deploy, where the revision is new,
# and a restart, where the configuration is what moved.
check_config() {
  local node_bin="$SERVICE_NODE"
  if [ ! -x "$node_bin" ]; then
    node_bin=$(command -v node)
  fi
  if [ -z "$node_bin" ]; then
    echo "No Node to check the configuration with." >&2
    exit 1
  fi
  if ! (cd "$SERVICE_CHECKOUT" \
    && "$node_bin" --experimental-strip-types packages/wolfstar-github-agent/src/cli.ts \
      check-config --config "$CONFIG_FILE"); then
    echo "The new revision rejects $CONFIG_FILE, so the running revision keeps serving." >&2
    echo "Fix the configuration, then deploy again." >&2
    exit 1
  fi
}

prepare_update() {
  require_checkout
  local pnpm_bin ref before
  pnpm_bin=$(resolve_pnpm)
  ref="${1:-origin/main}"
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
  (cd "$SERVICE_CHECKOUT" && "$pnpm_bin" install --frozen-lockfile >/dev/null)
  echo "Syncing Agent instructions"
  bash "$SERVICE_CHECKOUT/scripts/sync-agent-context.sh" local >/dev/null
  echo "Installing Worktrunk settings"
  bash "$SERVICE_CHECKOUT/scripts/worktrunk-config.sh" update >/dev/null
  echo "Building the dashboard"
  (cd "$SERVICE_CHECKOUT/packages/wolfstar-github-agent" && "$pnpm_bin" dashboard:build >/dev/null 2>&1)
  echo "Checking the configuration"
  check_config
}

command="${1:-update}"
case "$command" in
  update)
    prepare_update "${2:-origin/main}"
    restart_and_verify
    ;;
  prepare-update)
    prepare_update "${2:-origin/main}"
    ;;
  restart)
    require_checkout
    # The configuration moves on its own, so the revision already deployed can
    # stop accepting it between one start and the next.
    check_config
    restart_and_verify
    ;;
  revision)
    require_checkout
    git -C "$SERVICE_CHECKOUT" rev-parse HEAD
    ;;
  resolve-update)
    require_checkout
    git -C "$SERVICE_CHECKOUT" fetch --quiet origin
    git -C "$SERVICE_CHECKOUT" rev-parse --verify "${2:-origin/main}^{commit}"
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
    echo "Use update, prepare-update, resolve-update, restart, revision, or status." >&2
    exit 1
    ;;
esac
