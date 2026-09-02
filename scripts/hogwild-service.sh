#!/usr/bin/env bash
# Updates the Hogwild service from desktop while keeping its Agent context equal.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HOGWILD_HOST="${HARLAN_GITHUB_AGENT_HOGWILD_HOST:-hogwild}"
HOGWILD_ORIGIN="${HARLAN_GITHUB_AGENT_HOGWILD_ORIGIN:-https://hogwild.tailcad325.ts.net}"
REMOTE_HOME="${HARLAN_GITHUB_AGENT_HOGWILD_HOME:-/home/harlan}"
PASSWORD_FILE="${HARLAN_GITHUB_AGENT_PASSWORD_FILE:-$HOME/.config/harlan-github-agent/dashboard-password}"
readonly RESTART_POLL_SECONDS=2
readonly MAXIMUM_RESTART_SECONDS=$((55 * 60))
REMOTE_CHECKOUT="$REMOTE_HOME/.local/share/harlan-github-agent/service"
SERVICE_OVERRIDE_FILE="$SCRIPT_DIR/hogwild-service.conf"
REMOTE_OVERRIDE_DIR="$REMOTE_HOME/.config/systemd/user/harlan-github-agent.service.d"
REMOTE_OVERRIDE="$REMOTE_OVERRIDE_DIR/hogwild.conf"
REMOTE_OVERRIDE_NEXT="$REMOTE_OVERRIDE.next"

require_inputs() {
  if [[ ! "$HOGWILD_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
    echo "The Hogwild host name contains unsupported characters." >&2
    exit 1
  fi
  if [[ ! "$REMOTE_HOME" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    echo "The Hogwild home path contains unsupported characters." >&2
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

request_restart() {
  controller_request \
    --header 'Content-Type: application/json' \
    --request POST \
    --data '{"source":"helper"}' \
    "$HOGWILD_ORIGIN/api/service/restart" \
    | jq --exit-status --raw-output '.id'
}

controller_supports_restart() {
  local state
  if ! state=$(controller_request "$HOGWILD_ORIGIN/api/state"); then
    echo "Hogwild did not answer while checking Restart request support." >&2
    return 1
  fi
  if jq --exit-status 'has("restartRequest")' <<< "$state" >/dev/null; then
    return 0
  fi
  return 2
}

wait_for_restart() {
  local restart_id=$1
  local attempt state tag reason
  for attempt in $(seq 1 $((MAXIMUM_RESTART_SECONDS / RESTART_POLL_SECONDS))); do
    state=$(controller_request "$HOGWILD_ORIGIN/api/state" 2>/dev/null || true)
    if [ -z "$state" ]; then
      sleep "$RESTART_POLL_SECONDS"
      continue
    fi
    tag=$(jq --exit-status --raw-output --arg id "$restart_id" \
      'if .restartRequest.id == $id then .restartRequest._tag else "Unknown" end' <<< "$state")
    case "$tag" in
      Completed) return ;;
      Requested|Restarting) ;;
      ActionRequired)
        reason=$(jq --raw-output '.restartRequest.reason' <<< "$state")
        echo "Hogwild requires action before restart: $reason" >&2
        exit 1
        ;;
      *)
        echo "Hogwild lost Restart request $restart_id." >&2
        exit 1
        ;;
    esac
    sleep "$RESTART_POLL_SECONDS"
  done
  echo "Hogwild did not complete Restart request $restart_id." >&2
  exit 1
}

restore_legacy_agent_control() {
  local resume_required=$1
  if [ "$resume_required" != true ]; then
    return
  fi
  if ! controller_request --request POST "$HOGWILD_ORIGIN/api/agents/resume" >/dev/null; then
    echo "Hogwild restarted, but could not restore Running Agent control." >&2
    return 1
  fi
}

# The deployed service before schema 47 has no Restart request endpoint.
# Drain it once, preserve manual Pause, then let the new service own restarts.
legacy_safe_restart() {
  local state tag safe attempt
  local resume_required=false
  if ! state=$(controller_request "$HOGWILD_ORIGIN/api/state"); then
    echo "Hogwild did not answer before its compatibility restart." >&2
    return 1
  fi
  if ! tag=$(jq --exit-status --raw-output '.agentControl._tag' <<< "$state"); then
    echo "Hogwild returned invalid Agent control state." >&2
    return 1
  fi
  case "$tag" in
    Running)
      if ! controller_request --request POST "$HOGWILD_ORIGIN/api/agents/pause" >/dev/null; then
        echo "Hogwild could not stop new Agent claims." >&2
        return 1
      fi
      resume_required=true
      ;;
    Paused) ;;
    *)
      echo "Hogwild returned unknown Agent control state: $tag" >&2
      return 1
      ;;
  esac

  for attempt in $(seq 1 $((MAXIMUM_RESTART_SECONDS / RESTART_POLL_SECONDS))); do
    if ! state=$(controller_request "$HOGWILD_ORIGIN/api/state"); then
      restore_legacy_agent_control "$resume_required" || true
      echo "Hogwild stopped answering before its compatibility restart." >&2
      return 1
    fi
    if ! safe=$(jq --raw-output \
      'if .agentControl._tag == "Paused" then .agentControl.safeToRestart else false end' <<< "$state"); then
      restore_legacy_agent_control "$resume_required" || true
      echo "Hogwild returned invalid Agent restart state." >&2
      return 1
    fi
    if [ "$safe" = true ]; then
      if ! remote_service restart; then
        restore_legacy_agent_control "$resume_required" || true
        return 1
      fi
      restore_legacy_agent_control "$resume_required"
      return
    fi
    sleep "$RESTART_POLL_SECONDS"
  done

  restore_legacy_agent_control "$resume_required" || true
  echo "Hogwild did not finish active work before its compatibility restart." >&2
  return 1
}

safe_restart() {
  local support_status restart_id
  if controller_supports_restart; then
    restart_id=$(request_restart)
    wait_for_restart "$restart_id"
    return
  else
    support_status=$?
  fi
  if [ "$support_status" -ne 2 ]; then
    return 1
  fi
  echo "Hogwild uses the compatibility restart for this update."
  legacy_safe_restart
}

sync_context() {
  HARLAN_AGENT_CONTEXT_HOGWILD_HOST="$HOGWILD_HOST" \
    HARLAN_AGENT_CONTEXT_HOGWILD_HOME="$REMOTE_HOME" \
    bash "$SCRIPT_DIR/sync-agent-context.sh" hogwild
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

command="${1:-update}"
case "$command" in
  update)
    ref="${2:-origin/main}"
    if [[ ! "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
      echo "The Git ref contains unsupported characters." >&2
      exit 1
    fi
    sync_context
    sync_service_override
    remote_service prepare-update "$ref"
    safe_restart
    remote_service status
    ;;
  restart)
    sync_context
    sync_service_override
    safe_restart
    remote_service status
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
