#!/usr/bin/env bash
# Updates the Hogwild service from desktop while keeping its Agent context equal.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HOGWILD_HOST="${HARLAN_GITHUB_AGENT_HOGWILD_HOST:-hogwild}"
HOGWILD_ORIGIN="${HARLAN_GITHUB_AGENT_HOGWILD_ORIGIN:-https://hogwild.tailcad325.ts.net}"
REMOTE_HOME="${HARLAN_GITHUB_AGENT_HOGWILD_HOME:-/home/harlan}"
PASSWORD_FILE="${HARLAN_GITHUB_AGENT_PASSWORD_FILE:-$HOME/.config/harlan-github-agent/dashboard-password}"
REPOSITORY_ENV_HOME="${HARLAN_REPOSITORY_ENV_HOME:-$HOME}"
readonly RESTART_POLL_SECONDS=2
readonly MAXIMUM_RESTART_SECONDS=$((55 * 60))
REMOTE_CHECKOUT="$REMOTE_HOME/.local/share/harlan-github-agent/service"
SERVICE_OVERRIDE_FILE="$SCRIPT_DIR/hogwild-service.conf"
REMOTE_OVERRIDE_DIR="$REMOTE_HOME/.config/systemd/user/harlan-github-agent.service.d"
REMOTE_OVERRIDE="$REMOTE_OVERRIDE_DIR/hogwild.conf"
WORKTRUNK_CONFIG_FILE="$SCRIPT_DIR/worktrunk.toml"
REPOSITORY_ENV_TOOL_FILE="$SCRIPT_DIR/repository-env.sh"
REPOSITORY_ENV_MANIFEST_FILE="${HARLAN_REPOSITORY_ENV_MANIFEST:-$SCRIPT_DIR/repository-env-files}"
REMOTE_WORKTRUNK_CONFIG="$REMOTE_HOME/.config/worktrunk/config.toml"
REMOTE_REPOSITORY_ENV_TOOL="$REMOTE_HOME/.local/bin/harlan-repository-env"
REMOTE_REPOSITORY_ENV_MANIFEST="$REMOTE_HOME/.config/harlan-agent-kit/repository-env-files"
REMOTE_REPOSITORY_ENV_STAGE=''

require_inputs() {
  if [[ ! "$HOGWILD_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
    echo "The Hogwild host name contains unsupported characters." >&2
    exit 1
  fi
  if [[ ! "$REMOTE_HOME" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    echo "The Hogwild home path contains unsupported characters." >&2
    exit 1
  fi
  if [[ ! "$REPOSITORY_ENV_HOME" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    echo "The repository environment home path contains unsupported characters." >&2
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
  if [ ! -f "$WORKTRUNK_CONFIG_FILE" ]; then
    echo "The Worktrunk configuration does not exist: $WORKTRUNK_CONFIG_FILE" >&2
    exit 1
  fi
  if [ ! -f "$REPOSITORY_ENV_TOOL_FILE" ]; then
    echo "The repository environment helper does not exist: $REPOSITORY_ENV_TOOL_FILE" >&2
    exit 1
  fi
  if [ ! -f "$REPOSITORY_ENV_MANIFEST_FILE" ]; then
    echo "The repository environment manifest does not exist: $REPOSITORY_ENV_MANIFEST_FILE" >&2
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

sync_verified_file() {
  local source=$1
  local target=$2
  local mode=$3
  local label=$4
  local next local_hash remote_hash
  next="$target.next"
  local_hash=$(sha256sum "$source" | cut -d' ' -f1)
  ssh -o BatchMode=yes "$HOGWILD_HOST" "mkdir -p '$(dirname "$target")'"
  scp -q "$source" "$HOGWILD_HOST:$next"
  remote_hash=$(ssh -o BatchMode=yes "$HOGWILD_HOST" "sha256sum '$next'" | cut -d' ' -f1)
  if [ "$local_hash" != "$remote_hash" ]; then
    ssh -o BatchMode=yes "$HOGWILD_HOST" "rm -f '$next'"
    echo "Hogwild received a different $label." >&2
    exit 1
  fi
  ssh -o BatchMode=yes "$HOGWILD_HOST" "chmod '$mode' '$next' && mv '$next' '$target'"
}

sync_context() {
  HARLAN_AGENT_CONTEXT_HOGWILD_HOST="$HOGWILD_HOST" \
    HARLAN_AGENT_CONTEXT_HOGWILD_HOME="$REMOTE_HOME" \
    bash "$SCRIPT_DIR/sync-agent-context.sh" hogwild
}

sync_service_override() {
  sync_verified_file "$SERVICE_OVERRIDE_FILE" "$REMOTE_OVERRIDE" 644 'service setting file'
  ssh -o BatchMode=yes "$HOGWILD_HOST" 'systemctl --user daemon-reload'
}

sync_worktrunk() {
  sync_verified_file "$REPOSITORY_ENV_TOOL_FILE" "$REMOTE_REPOSITORY_ENV_TOOL" 755 'repository environment helper'
  sync_verified_file "$REPOSITORY_ENV_MANIFEST_FILE" "$REMOTE_REPOSITORY_ENV_MANIFEST" 644 'repository environment manifest'
  sync_verified_file "$WORKTRUNK_CONFIG_FILE" "$REMOTE_WORKTRUNK_CONFIG" 644 'Worktrunk configuration'
}

cleanup_repository_environment_stage() {
  local suffix
  [ -n "$REMOTE_REPOSITORY_ENV_STAGE" ] || return
  suffix=${REMOTE_REPOSITORY_ENV_STAGE#"$REMOTE_HOME/.cache/harlan-repository-env."}
  if [ "$suffix" = "$REMOTE_REPOSITORY_ENV_STAGE" ] || [[ ! "$suffix" =~ ^[A-Za-z0-9]+$ ]]; then
    echo "The Hogwild repository environment stage is unsafe: $REMOTE_REPOSITORY_ENV_STAGE" >&2
    return 1
  fi
  ssh -o BatchMode=yes "$HOGWILD_HOST" "rm -rf -- '$REMOTE_REPOSITORY_ENV_STAGE'"
  REMOTE_REPOSITORY_ENV_STAGE=''
}

require_safe_repository_environment_stage() {
  local suffix
  suffix=${REMOTE_REPOSITORY_ENV_STAGE#"$REMOTE_HOME/.cache/harlan-repository-env."}
  if [ "$suffix" = "$REMOTE_REPOSITORY_ENV_STAGE" ] || [[ ! "$suffix" =~ ^[A-Za-z0-9]+$ ]]; then
    echo "Hogwild returned an unsafe repository environment stage: $REMOTE_REPOSITORY_ENV_STAGE" >&2
    REMOTE_REPOSITORY_ENV_STAGE=''
    exit 1
  fi
}

sync_repository_environment() {
  HARLAN_REPOSITORY_ENV_HOME="$REPOSITORY_ENV_HOME" \
  HARLAN_REPOSITORY_ENV_MANIFEST="$REPOSITORY_ENV_MANIFEST_FILE" \
    bash "$REPOSITORY_ENV_TOOL_FILE" validate-source >/dev/null

  if ! REMOTE_REPOSITORY_ENV_STAGE=$(ssh -o BatchMode=yes "$HOGWILD_HOST" \
    "umask 077; mkdir -p '$REMOTE_HOME/.cache'; mktemp -d '$REMOTE_HOME/.cache/harlan-repository-env.XXXXXX'"); then
    echo "Hogwild could not create the repository environment stage." >&2
    exit 1
  fi
  require_safe_repository_environment_stage
  if ! rsync --archive --relative --checksum --chmod=F600,D700 \
    --files-from=<(HARLAN_REPOSITORY_ENV_HOME="$REPOSITORY_ENV_HOME" \
      HARLAN_REPOSITORY_ENV_MANIFEST="$REPOSITORY_ENV_MANIFEST_FILE" \
      bash "$REPOSITORY_ENV_TOOL_FILE" list-paths) \
    "$REPOSITORY_ENV_HOME/" "$HOGWILD_HOST:$REMOTE_REPOSITORY_ENV_STAGE/"; then
    cleanup_repository_environment_stage || true
    echo "Hogwild could not receive the repository environment." >&2
    exit 1
  fi
  if ! ssh -o BatchMode=yes "$HOGWILD_HOST" \
    "HARLAN_REPOSITORY_ENV_HOME='$REMOTE_HOME' HARLAN_REPOSITORY_ENV_MANIFEST='$REMOTE_REPOSITORY_ENV_MANIFEST' '$REMOTE_REPOSITORY_ENV_TOOL' install-staged '$REMOTE_REPOSITORY_ENV_STAGE'"; then
    cleanup_repository_environment_stage || true
    echo "Hogwild could not install the repository environment." >&2
    exit 1
  fi
  cleanup_repository_environment_stage
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
    sync_worktrunk
    sync_repository_environment
    remote_service prepare-update "$ref"
    safe_restart
    remote_service status
    ;;
  restart)
    sync_context
    sync_service_override
    sync_worktrunk
    safe_restart
    remote_service status
    ;;
  status)
    remote_service status
    ;;
  sync-context)
    sync_context
    ;;
  sync-worktrunk)
    sync_worktrunk
    ;;
  sync-env)
    sync_worktrunk
    sync_repository_environment
    ;;
  *)
    echo "Unknown command: $command" >&2
    echo "Use update, restart, status, sync-context, sync-worktrunk, or sync-env." >&2
    exit 1
    ;;
esac
