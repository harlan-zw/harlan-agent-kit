#!/usr/bin/env bash
# Updates the Hogwild service from desktop while keeping its Agent context equal.
set -euo pipefail

# Each file is staged, digest checked, then moved into place. The service
# updates itself on merge and a person can deploy by hand in the same minute, so
# every run stages under its own name. A shared name let one run move a file
# another run staged, installing content it never checked.
stage_token="next.$(date +%s%N).$$.$RANDOM"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HOGWILD_HOST="${WOLFSTAR_GITHUB_AGENT_HOGWILD_HOST:-hogwild}"
HOGWILD_ORIGIN="${WOLFSTAR_GITHUB_AGENT_HOGWILD_ORIGIN:-https://hogwild.tailcad325.ts.net}"
REMOTE_HOME="${WOLFSTAR_GITHUB_AGENT_HOGWILD_HOME:-/home/wolfstar}"
PASSWORD_FILE="${WOLFSTAR_GITHUB_AGENT_PASSWORD_FILE:-$HOME/.config/wolfstar-github-agent/dashboard-password}"
REPOSITORY_ENV_HOME="${WOLFSTAR_REPOSITORY_ENV_HOME:-$HOME}"
readonly RESTART_POLL_SECONDS=2
readonly MAXIMUM_RESTART_SECONDS=$((55 * 60))
REMOTE_CHECKOUT="$REMOTE_HOME/.local/share/wolfstar-github-agent/service"
SERVICE_OVERRIDE_FILE="$SCRIPT_DIR/hogwild-service.conf"
REMOTE_OVERRIDE_DIR="$REMOTE_HOME/.config/systemd/user/wolfstar-github-agent.service.d"
REMOTE_OVERRIDE="$REMOTE_OVERRIDE_DIR/hogwild.conf"
WORKTRUNK_CONFIG_FILE="$SCRIPT_DIR/worktrunk.toml"
REPOSITORY_ENV_TOOL_FILE="$SCRIPT_DIR/repository-env.sh"
REPOSITORY_ENV_MANIFEST_FILE="${WOLFSTAR_REPOSITORY_ENV_MANIFEST:-$SCRIPT_DIR/repository-env-files}"
# Values Hogwild gets in place of the desktop's, such as a read-only Cloudflare
# token. It lives outside every repository and never leaves this machine as is.
HOGWILD_ENV_OVERRIDES_FILE="${WOLFSTAR_HOGWILD_ENV_OVERRIDES:-$HOME/.config/wolfstar-agent-kit/hogwild-env-overrides}"
REMOTE_WORKTRUNK_CONFIG="$REMOTE_HOME/.config/worktrunk/config.toml"
REMOTE_REPOSITORY_ENV_TOOL="$REMOTE_HOME/.local/bin/wolfstar-repository-env"
REMOTE_REPOSITORY_ENV_MANIFEST="$REMOTE_HOME/.config/wolfstar-agent-kit/repository-env-files"
REMOTE_REPOSITORY_ENV_STAGE=''

# Hold one descriptor through Hogwild restart, desktop preparation, and cleanup.
acquire_service_lock() {
  local directory="${XDG_STATE_HOME:-$HOME/.local/state}/wolfstar-agent-kit"
  mkdir -p "$directory"
  exec 9>"$directory/hogwild-service.lock"
  if ! flock --nonblock 9; then
    echo "Another Hogwild update or restart is running. Wait for it to finish." >&2
    return 1
  fi
}

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
  if [ ! -f "$SCRIPT_DIR/desktop-agent.service" ]; then
    echo "The desktop Agent unit does not exist: $SCRIPT_DIR/desktop-agent.service" >&2
    exit 1
  fi
}

controller_request() {
  curl --fail --silent --show-error \
    --user "agent:$(cat "$PASSWORD_FILE")" \
    --header "Origin: $HOGWILD_ORIGIN" \
    "$@"
}

# Refuses to start while an earlier deploy is still draining.
#
# Every deploy files a Restart request, then waits for the last Agent to finish,
# which can take many minutes. A second deploy started in that window moves the
# service checkout under a pending restart and files a second request. Two
# Claude Code sessions in this repository did that on 2026-09-16.
#
# The capability check below rejects controllers that cannot hold preparation.
refuse_while_restart_pending() {
  local state tag
  if ! state=$(controller_request "$HOGWILD_ORIGIN/api/state" 2>/dev/null); then
    return 0
  fi
  tag=$(jq --raw-output '.restartRequest._tag // "None"' <<< "$state" 2>/dev/null || printf '%s' None)
  case "$tag" in
    Requested|Restarting)
      echo "Hogwild already has a Restart request that is $tag, so another deploy is still draining." >&2
      echo "Wait for it to complete, then deploy again." >&2
      exit 1
      ;;
  esac
}

request_restart() {
  controller_request \
    --header 'Content-Type: application/json' \
    --request POST \
    --data '{"source":"helper"}' \
    "$HOGWILD_ORIGIN/api/service/restart" \
    | jq --exit-status --raw-output '.id'
}

request_update() {
  local target_commit=$1 request
  request=$(controller_request --header 'Content-Type: application/json' --request POST \
    --data "$(jq --null-input --arg commit "$target_commit" '{source:"helper",targetCommit:$commit,preparation:"Pending"}')" \
    "$HOGWILD_ORIGIN/api/service/update")
  jq --exit-status --raw-output --arg commit "$target_commit" \
    'if .operation._tag == "Update" and .operation.targetCommit == $commit and .operation.preparation == "Pending" then .id else error("Another Restart request owns the Service.") end' <<< "$request"
}

finish_update_preparation() {
  local request_id=$1 outcome=$2
  controller_request --header 'Content-Type: application/json' --request POST \
    --data "$(jq --null-input --arg id "$request_id" --arg outcome "$outcome" '{id:$id,_tag:$outcome,reason:"The update helper failed during file sync."}')" \
    "$HOGWILD_ORIGIN/api/service/update/preparation" >/dev/null
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
  local attempt state tag reason progress elapsed
  local started=$SECONDS last_reported=-30 last_progress=''
  for attempt in $(seq 1 $((MAXIMUM_RESTART_SECONDS / RESTART_POLL_SECONDS))); do
    state=$(controller_request "$HOGWILD_ORIGIN/api/state" 2>/dev/null || true)
    if [ -z "$state" ]; then
      if [ "$last_progress" != 'Waiting for Service response.' ] || ((SECONDS - last_reported >= 30)); then
        echo "Waiting for Service response. Elapsed: $((SECONDS - started))s."
        last_progress='Waiting for Service response.'
        last_reported=$SECONDS
      fi
      sleep "$RESTART_POLL_SECONDS"
      continue
    fi
    tag=$(jq --exit-status --raw-output --arg id "$restart_id" \
      'if .restartRequest.id == $id then .restartRequest._tag else "Unknown" end' <<< "$state")
    case "$tag" in
      Completed)
        echo "Hogwild restarted. Elapsed: $((SECONDS - started))s."
        return
        ;;
      Requested|Restarting)
        progress=$(jq --raw-output --arg tag "$tag" '
          if $tag == "Restarting" then "Restarting Hogwild."
          else
            (if (.tasks | type) == "array" then
              [.tasks[] | select(.state._tag == "Running" or .state._tag == "Publishing")] | length
            else "unknown" end) as $tasks |
            (if (.hostCapacity.localActive | type) == "number" and (.hostCapacity.desktopActive | type) == "number" then
              .hostCapacity.localActive + .hostCapacity.desktopActive
            else "unknown" end) as $slots |
            "Waiting for Restart: \($tasks) active Tasks, \($slots) occupied Agent slots."
          end' <<< "$state")
        if [ "$progress" != "$last_progress" ] || ((SECONDS - last_reported >= 30)); then
          elapsed=$((SECONDS - started))
          echo "$progress Elapsed: ${elapsed}s."
          last_progress=$progress
          last_reported=$SECONDS
        fi
        ;;
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

# The file sync_verified_file has staged on Hogwild but not yet moved into
# place. Recorded before the scp, so the EXIT trap reclaims it on every exit
# path, including the ones set -e takes with no cleanup branch in sight.
staged_file=''
# The local copy of the repository environment, with Hogwild overrides applied.
# It holds secrets, so every exit path removes it.
outgoing_env_stage=''
pending_update_id=''

cleanup_staged_file() {
  if [ -n "$pending_update_id" ]; then
    if ! finish_update_preparation "$pending_update_id" Failed; then
      echo "Update preparation cleanup failed. Inspect request $pending_update_id." >&2
    fi
    pending_update_id=''
  fi
  if [ -n "$staged_file" ]; then
    ssh -o BatchMode=yes "$HOGWILD_HOST" "rm -f '$staged_file'" >/dev/null 2>&1 || true
    staged_file=''
  fi
  if [ -n "$outgoing_env_stage" ]; then
    rm -rf -- "$outgoing_env_stage"
    outgoing_env_stage=''
  fi
}
trap cleanup_staged_file EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

sync_verified_file() {
  local source=$1
  local target=$2
  local mode=$3
  local label=$4
  local next local_hash remote_hash
  next="$target.$stage_token"
  staged_file="$next"
  local_hash=$(sha256sum "$source" | cut -d' ' -f1)
  ssh -o BatchMode=yes "$HOGWILD_HOST" "mkdir -p '$(dirname "$target")'"
  scp -q "$source" "$HOGWILD_HOST:$next"
  remote_hash=$(ssh -o BatchMode=yes "$HOGWILD_HOST" "sha256sum '$next'" | cut -d' ' -f1)
  if [ "$local_hash" != "$remote_hash" ]; then
    echo "Hogwild received a different $label." >&2
    exit 1
  fi
  ssh -o BatchMode=yes "$HOGWILD_HOST" "chmod '$mode' '$next' && mv '$next' '$target'"
  # Activation moved the staged file to its final name, so there is nothing
  # left for the EXIT trap to reclaim.
  staged_file=''
}

sync_context() {
  WOLFSTAR_AGENT_CONTEXT_HOGWILD_HOST="$HOGWILD_HOST" \
    WOLFSTAR_AGENT_CONTEXT_HOGWILD_HOME="$REMOTE_HOME" \
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
  suffix=${REMOTE_REPOSITORY_ENV_STAGE#"$REMOTE_HOME/.cache/wolfstar-repository-env."}
  if [ "$suffix" = "$REMOTE_REPOSITORY_ENV_STAGE" ] || [[ ! "$suffix" =~ ^[A-Za-z0-9]+$ ]]; then
    echo "The Hogwild repository environment stage is unsafe: $REMOTE_REPOSITORY_ENV_STAGE" >&2
    return 1
  fi
  ssh -o BatchMode=yes "$HOGWILD_HOST" "rm -rf -- '$REMOTE_REPOSITORY_ENV_STAGE'"
  REMOTE_REPOSITORY_ENV_STAGE=''
}

require_safe_repository_environment_stage() {
  local suffix
  suffix=${REMOTE_REPOSITORY_ENV_STAGE#"$REMOTE_HOME/.cache/wolfstar-repository-env."}
  if [ "$suffix" = "$REMOTE_REPOSITORY_ENV_STAGE" ] || [[ ! "$suffix" =~ ^[A-Za-z0-9]+$ ]]; then
    echo "Hogwild returned an unsafe repository environment stage: $REMOTE_REPOSITORY_ENV_STAGE" >&2
    REMOTE_REPOSITORY_ENV_STAGE=''
    exit 1
  fi
}

sync_repository_environment() {
  outgoing_env_stage=$(umask 077 && mktemp -d)
  WOLFSTAR_REPOSITORY_ENV_HOME="$REPOSITORY_ENV_HOME" \
  WOLFSTAR_REPOSITORY_ENV_MANIFEST="$REPOSITORY_ENV_MANIFEST_FILE" \
    bash "$REPOSITORY_ENV_TOOL_FILE" stage-outgoing "$outgoing_env_stage/stage" "$HOGWILD_ENV_OVERRIDES_FILE" >/dev/null

  if ! REMOTE_REPOSITORY_ENV_STAGE=$(ssh -o BatchMode=yes "$HOGWILD_HOST" \
    "umask 077; mkdir -p '$REMOTE_HOME/.cache'; mktemp -d '$REMOTE_HOME/.cache/wolfstar-repository-env.XXXXXX'"); then
    echo "Hogwild could not create the repository environment stage." >&2
    exit 1
  fi
  require_safe_repository_environment_stage
  if ! rsync --archive --relative --checksum --chmod=F600,D700 \
    --files-from=<(WOLFSTAR_REPOSITORY_ENV_HOME="$REPOSITORY_ENV_HOME" \
      WOLFSTAR_REPOSITORY_ENV_MANIFEST="$REPOSITORY_ENV_MANIFEST_FILE" \
      bash "$REPOSITORY_ENV_TOOL_FILE" list-paths) \
    "$outgoing_env_stage/stage/" "$HOGWILD_HOST:$REMOTE_REPOSITORY_ENV_STAGE/"; then
    cleanup_repository_environment_stage || true
    echo "Hogwild could not receive the repository environment." >&2
    exit 1
  fi
  if ! ssh -o BatchMode=yes "$HOGWILD_HOST" \
    "WOLFSTAR_REPOSITORY_ENV_HOME='$REMOTE_HOME' WOLFSTAR_REPOSITORY_ENV_MANIFEST='$REMOTE_REPOSITORY_ENV_MANIFEST' '$REMOTE_REPOSITORY_ENV_TOOL' install-staged '$REMOTE_REPOSITORY_ENV_STAGE'"; then
    cleanup_repository_environment_stage || true
    echo "Hogwild could not install the repository environment." >&2
    exit 1
  fi
  cleanup_repository_environment_stage
}

# The desktop runs the other half of every offloaded turn, from its own checkout
# on this machine. Left behind, it reads a turn shape it was never taught, so it
# moves with Hogwild or not at all.
DESKTOP_UNIT="${WOLFSTAR_GITHUB_AGENT_DESKTOP_UNIT:-wolfstar-desktop-agent}"
# This step moves a checkout and restarts a unit on the machine running the
# deploy, so both are named here rather than hardcoded. Without that the script
# reached past its own boundaries, and running its tests updated the real
# desktop client.
DESKTOP_SERVICE_SCRIPT="${WOLFSTAR_GITHUB_AGENT_SERVICE_SCRIPT:-$SCRIPT_DIR/service.sh}"
DESKTOP_UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

wait_for_desktop() {
  local attempt state seen remaining request_timeout
  local started=$SECONDS baseline='' reason='The Service did not answer.'
  echo "Waiting for a fresh desktop report with the current protocol."
  for attempt in $(seq 1 60); do
    remaining=$((120 - SECONDS + started))
    if [ "$remaining" -le 0 ]; then break; fi
    request_timeout=$((remaining < 10 ? remaining : 10))
    if ! systemctl --user is-active --quiet "$DESKTOP_UNIT"; then
      echo "Desktop client stopped after restart. Inspect its user unit." >&2
      return 1
    fi
    state=$(controller_request --connect-timeout "$request_timeout" --max-time "$request_timeout" "$HOGWILD_ORIGIN/api/state" 2>/dev/null || true)
    if [ -z "$state" ]; then
      reason='The Service did not answer.'
    elif ! seen=$(jq --exit-status --raw-output '
      .desktop | if type == "object" and has("seenAt") then
        if .seenAt == null then 0
        elif (.seenAt | type) == "number" and .seenAt >= 0 then .seenAt
        else error("Invalid report time.") end
      else error("Missing report time.") end' <<< "$state" 2>/dev/null); then
      reason='The Service returned no valid desktop report time.'
    else
      # Capture the controller clock after systemd has stopped the previous client.
      # A later report proves the replacement can communicate, without host clock comparisons.
      if [ -z "$baseline" ]; then baseline=$seen; fi
      if jq --exit-status --argjson baseline "$baseline" \
        '.desktop.connected == true and .desktop.current == true and .desktop.seenAt > $baseline' \
        <<< "$state" >/dev/null && systemctl --user is-active --quiet "$DESKTOP_UNIT"; then
        echo "Desktop client connected with the current protocol."
        return 0
      fi
      reason=$(jq --raw-output '
        if .desktop.connected != true then "The desktop is disconnected."
        elif .desktop.current != true then "The desktop protocol does not match the Service."
        else "The desktop sent no fresh report." end' <<< "$state")
    fi
    remaining=$((120 - SECONDS + started))
    if [ "$remaining" -le 0 ]; then break; fi
    if [ "$attempt" -lt 60 ]; then sleep "$((remaining < 2 ? remaining : 2))"; fi
  done
  echo "Desktop client connection check failed: $reason" >&2
  return 1
}

update_desktop_client() {
  local ref=$1
  if ! systemctl --user list-unit-files "$DESKTOP_UNIT.service" >/dev/null 2>&1 \
    || [ -z "$(systemctl --user list-unit-files --no-legend "$DESKTOP_UNIT.service" 2>/dev/null)" ]; then
    echo "No $DESKTOP_UNIT on this machine. Skipping the desktop client."
    return 0
  fi
  echo "Updating the desktop client"
  bash "$DESKTOP_SERVICE_SCRIPT" prepare-update "$ref"
  # The unit carries the PATH the Worktrunk hooks run under, so a checkout that
  # moves without it runs new code in the old environment. That gap put every
  # desktop turn into `pnpm: exit status: 127` until PR #289.
  install -Dm644 "$SCRIPT_DIR/desktop-agent.service" "$DESKTOP_UNIT_DIR/$DESKTOP_UNIT.service"
  systemctl --user daemon-reload
  systemctl --user restart "$DESKTOP_UNIT"
  wait_for_desktop
  echo "Desktop client: $(git -C "${WOLFSTAR_GITHUB_AGENT_CHECKOUT:-$HOME/.local/share/wolfstar-github-agent/service}" log --oneline -1)"
}

remote_service() {
  local command=$1
  local ref=${2:-}
  ssh -o BatchMode=yes "$HOGWILD_HOST" \
    "export PATH=\"\$HOME/.local/bin:\$PATH\" WOLFSTAR_GITHUB_AGENT_CHECKOUT='$REMOTE_CHECKOUT'; bash -s -- '$command'${ref:+ '$ref'}" \
    < "$SCRIPT_DIR/service.sh"
}

require_inputs

command="${1:-update}"
case "$command" in
  update|restart) acquire_service_lock ;;
esac
case "$command" in
  update)
    ref="${2:-origin/main}"
    if [[ ! "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ ]]; then
      echo "The Git ref contains unsupported characters." >&2
      exit 1
    fi
    refuse_while_restart_pending
    if ! controller_request "$HOGWILD_ORIGIN/api/service/update/preparation" | jq --exit-status '.supported == true' >/dev/null; then
      echo "The Service cannot hold Update preparation. Update it with its installed helper first." >&2
      exit 1
    fi
    deployed_revision=$(remote_service resolve-update "$ref" | tr -d '[:space:]')
    if [[ ! "$deployed_revision" =~ ^[0-9a-f]{40}$ ]]; then
      echo "Hogwild did not resolve a full commit SHA." >&2
      exit 1
    fi
    pending_update_id=$(request_update "$deployed_revision")
    restart_id=$pending_update_id
    sync_context
    sync_service_override
    sync_worktrunk
    sync_repository_environment
    # The durable Update blocks claims, drains work, then prepares this commit.
    # Preparing first lets fresh Tasks start during dependency and build work.
    finish_update_preparation "$pending_update_id" Ready
    pending_update_id=''
    wait_for_restart "$restart_id"
    actual_revision=$(remote_service revision | tr -d '[:space:]')
    if [ "$actual_revision" != "$deployed_revision" ]; then
      echo "Hogwild started a different commit. Inspect the Update request." >&2
      exit 1
    fi
    remote_service status
    # After Hogwild, because a desktop ahead of the controller stands itself
    # down and the work simply stays on Hogwild until this finishes.
    update_desktop_client "$deployed_revision"
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
