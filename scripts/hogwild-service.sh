#!/usr/bin/env bash
# Updates the Hogwild service from desktop while keeping its Agent context equal.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HOGWILD_HOST="${HARLAN_GITHUB_AGENT_HOGWILD_HOST:-hogwild}"
HOGWILD_ORIGIN="${HARLAN_GITHUB_AGENT_HOGWILD_ORIGIN:-https://hogwild.tailcad325.ts.net}"
REMOTE_HOME="${HARLAN_GITHUB_AGENT_HOGWILD_HOME:-/home/harlan}"
CONTEXT_FILE="${HARLAN_GITHUB_AGENT_CONTEXT_FILE:-$HOME/.codex/AGENTS.md}"
PASSWORD_FILE="${HARLAN_GITHUB_AGENT_PASSWORD_FILE:-$HOME/.config/harlan-github-agent/dashboard-password}"
readonly DRAIN_POLL_SECONDS=2
readonly MAXIMUM_DRAIN_SECONDS=$((50 * 60))
REMOTE_CHECKOUT="$REMOTE_HOME/.local/share/harlan-github-agent/service"
REMOTE_CONTEXT="$REMOTE_HOME/.codex/AGENTS.md"
REMOTE_CONTEXT_NEXT="$REMOTE_CONTEXT.next"
SERVICE_OVERRIDE_FILE="$SCRIPT_DIR/hogwild-service.conf"
REMOTE_OVERRIDE_DIR="$REMOTE_HOME/.config/systemd/user/harlan-github-agent.service.d"
REMOTE_OVERRIDE="$REMOTE_OVERRIDE_DIR/hogwild.conf"
REMOTE_OVERRIDE_NEXT="$REMOTE_OVERRIDE.next"

resume_required=false

require_inputs() {
  if [[ ! "$HOGWILD_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
    echo "The Hogwild host name contains unsupported characters." >&2
    exit 1
  fi
  if [[ ! "$REMOTE_HOME" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    echo "The Hogwild home path contains unsupported characters." >&2
    exit 1
  fi
  if [ ! -f "$CONTEXT_FILE" ]; then
    echo "The global Agent instructions do not exist: $CONTEXT_FILE" >&2
    exit 1
  fi
  if [ ! -f "$PASSWORD_FILE" ]; then
    echo "The dashboard password does not exist: $PASSWORD_FILE" >&2
    exit 1
  fi
  if [ ! -f "$SERVICE_OVERRIDE_FILE" ]; then
    echo "The Hogwild service settings do not exist: $SERVICE_OVERRIDE_FILE" >&2
    exit 1
  fi
}

controller_request() {
  curl --fail --silent --show-error \
    --user "agent:$(cat "$PASSWORD_FILE")" \
    --header "Origin: $HOGWILD_ORIGIN" \
    "$@"
}

prepare_restart() {
  local control
  control=$(controller_request "$HOGWILD_ORIGIN/api/state" | jq --raw-output '.agentControl._tag')
  case "$control" in
    Running)
      controller_request --request POST "$HOGWILD_ORIGIN/api/agents/pause" >/dev/null
      resume_required=true
      ;;
    Paused) ;;
    *)
      echo "Hogwild returned an unknown Agent control: $control" >&2
      exit 1
      ;;
  esac
  # Agent leases last up to 45 minutes. Keep five minutes for publication.
  local attempt
  for attempt in $(seq 1 $((MAXIMUM_DRAIN_SECONDS / DRAIN_POLL_SECONDS))); do
    if controller_request "$HOGWILD_ORIGIN/api/state" | jq --exit-status '.agentControl.safeToRestart == true' >/dev/null; then
      return
    fi
    sleep "$DRAIN_POLL_SECONDS"
  done
  echo "Hogwild did not become safe to restart." >&2
  exit 1
}

resume_agents() {
  if $resume_required; then
    controller_request --request POST "$HOGWILD_ORIGIN/api/agents/resume" >/dev/null
    resume_required=false
  fi
}

resume_after_failure() {
  local status=$?
  trap - EXIT
  if $resume_required && ! resume_agents; then
    echo "Hogwild could not resume after the failed operation." >&2
    status=1
  fi
  exit "$status"
}

sync_context() {
  local local_hash remote_hash
  local_hash=$(sha256sum "$CONTEXT_FILE" | cut -d' ' -f1)
  ssh -o BatchMode=yes "$HOGWILD_HOST" "mkdir -p '$REMOTE_HOME/.codex'"
  scp -q "$CONTEXT_FILE" "$HOGWILD_HOST:$REMOTE_CONTEXT_NEXT"
  remote_hash=$(ssh -o BatchMode=yes "$HOGWILD_HOST" "sha256sum '$REMOTE_CONTEXT_NEXT'" | cut -d' ' -f1)
  if [ "$local_hash" != "$remote_hash" ]; then
    ssh -o BatchMode=yes "$HOGWILD_HOST" "rm -f '$REMOTE_CONTEXT_NEXT'"
    echo "Hogwild received different global Agent instructions." >&2
    exit 1
  fi
  ssh -o BatchMode=yes "$HOGWILD_HOST" "chmod 644 '$REMOTE_CONTEXT_NEXT' && mv '$REMOTE_CONTEXT_NEXT' '$REMOTE_CONTEXT'"
}

sync_service_override() {
  local local_hash remote_hash
  local_hash=$(sha256sum "$SERVICE_OVERRIDE_FILE" | cut -d' ' -f1)
  ssh -o BatchMode=yes "$HOGWILD_HOST" "mkdir -p '$REMOTE_OVERRIDE_DIR'"
  scp -q "$SERVICE_OVERRIDE_FILE" "$HOGWILD_HOST:$REMOTE_OVERRIDE_NEXT"
  remote_hash=$(ssh -o BatchMode=yes "$HOGWILD_HOST" "sha256sum '$REMOTE_OVERRIDE_NEXT'" | cut -d' ' -f1)
  if [ "$local_hash" != "$remote_hash" ]; then
    ssh -o BatchMode=yes "$HOGWILD_HOST" "rm -f '$REMOTE_OVERRIDE_NEXT'"
    echo "Hogwild received different service settings." >&2
    exit 1
  fi
  ssh -o BatchMode=yes "$HOGWILD_HOST" \
    "chmod 644 '$REMOTE_OVERRIDE_NEXT' && mv '$REMOTE_OVERRIDE_NEXT' '$REMOTE_OVERRIDE' && systemctl --user daemon-reload"
}

remote_service() {
  local command=$1
  local ref=${2:-}
  ssh -o BatchMode=yes "$HOGWILD_HOST" \
    "export PATH=\"\$HOME/.local/bin:\$PATH\" HARLAN_GITHUB_AGENT_CHECKOUT='$REMOTE_CHECKOUT'; bash -s -- '$command'${ref:+ '$ref'}" \
    < "$SCRIPT_DIR/service.sh"
}

require_inputs
trap resume_after_failure EXIT

command="${1:-update}"
case "$command" in
  update)
    ref="${2:-origin/main}"
    if [[ ! "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
      echo "The Git ref contains unsupported characters." >&2
      exit 1
    fi
    prepare_restart
    sync_context
    sync_service_override
    remote_service update "$ref"
    resume_agents
    ;;
  restart)
    prepare_restart
    sync_context
    sync_service_override
    remote_service restart
    resume_agents
    ;;
  status)
    remote_service status
    ;;
  sync-context)
    sync_context
    ;;
  *)
    echo "Unknown command: $command" >&2
    echo "Use update, restart, status, or sync-context." >&2
    exit 1
    ;;
esac

trap - EXIT
