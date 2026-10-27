#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
node_bin=$(node -p 'process.execPath')
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

export HOME="$test_root/home"
export HARLAN_GITHUB_AGENT_CHECKOUT="$test_root/service"
export SERVICE_TEST_CALLS="$test_root/curl.calls"
export SERVICE_TEST_PNPM_CALLS="$test_root/pnpm.calls"
export SERVICE_TEST_SYNC_CALLS="$test_root/sync.calls"
export SERVICE_TEST_GIT_CALLS="$test_root/git.calls"
export SERVICE_TEST_SYSTEMCTL_CALLS="$test_root/systemctl.calls"

export HARLAN_GITHUB_AGENT_NODE="$test_root/bin/node"

mkdir -p \
  "$HARLAN_GITHUB_AGENT_CHECKOUT/.git" \
  "$HARLAN_GITHUB_AGENT_CHECKOUT/packages/harlan-github-agent/src" \
  "$HARLAN_GITHUB_AGENT_CHECKOUT/scripts" \
  "$HOME/.config/harlan-github-agent" \
  "$HOME/.local/bin" \
  "$test_root/bin"
ln -s "$node_bin" "$test_root/bin/node"
printf '%s\n' 'server:' '  allowed_origin: https://hogwild.tailcad325.ts.net' > "$HOME/.config/harlan-github-agent/config.yml"
printf '%s\n' 'password' > "$HOME/.config/harlan-github-agent/dashboard-password"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''%s\n'\'' "$*" >> "$SERVICE_TEST_PNPM_CALLS"' \
  > "$HOME/.local/bin/pnpm"
chmod +x "$HOME/.local/bin/pnpm"
printf '%s\n' '#!/usr/bin/env bash' 'printf '\''context %s\n'\'' "$*" >> "$SERVICE_TEST_SYNC_CALLS"' \
  > "$HARLAN_GITHUB_AGENT_CHECKOUT/scripts/sync-agent-context.sh"
printf '%s\n' '#!/usr/bin/env bash' 'printf '\''worktrunk %s\n'\'' "$*" >> "$SERVICE_TEST_SYNC_CALLS"' \
  > "$HARLAN_GITHUB_AGENT_CHECKOUT/scripts/worktrunk-config.sh"
printf '%s\n' 'process.stdout.write("worker configuration refreshed\n")' \
  > "$HARLAN_GITHUB_AGENT_CHECKOUT/scripts/opencode-v2-migrate.ts"
printf '%s\n' \
  'import { appendFileSync } from "node:fs"' \
  'appendFileSync(process.env.SERVICE_TEST_SYNC_CALLS, "worker-skills refreshed\n")' \
  'process.exit(Number(process.env.SERVICE_TEST_SKILL_EXIT || 0))' \
  > "$HARLAN_GITHUB_AGENT_CHECKOUT/scripts/worker-skills.ts"
# Stands in for the deployed CLI. Its exit code is the configuration verdict.
printf '%s\n' \
  'process.exit(Number(process.env.SERVICE_TEST_CLI_EXIT || 0))' \
  > "$HARLAN_GITHUB_AGENT_CHECKOUT/packages/harlan-github-agent/src/cli.ts"

git() {
  printf '%s\n' "$*" >> "$SERVICE_TEST_GIT_CALLS"
  case "$*" in
    *'rev-parse --verify'*) printf '%s\n' 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
    *'status --porcelain'*) return 0 ;;
    *'log --oneline -1'*) printf '%s\n' 'deployed revision' ;;
    *'rev-parse HEAD'*) printf '%s\n' 'deployed-sha' ;;
  esac
}

systemctl() {
  printf '%s\n' "$*" >> "$SERVICE_TEST_SYSTEMCTL_CALLS"
  if [[ "$*" == *'show '* ]]; then
    printf '%s\n' '0'
  fi
  return 0
}

curl() {
  printf '%s\n' "$*" > "$SERVICE_TEST_CALLS"
  if [[ "$*" == *'-sf'* || "$*" == *'--fail'* ]]; then
    return 22
  fi
}

sleep() {
  return 0
}

export -f git systemctl curl sleep

resolved=$(PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/service.sh" resolve-update origin/main)
if [[ "$resolved" != aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ]] || \
  ! grep -F 'fetch' "$SERVICE_TEST_GIT_CALLS" >/dev/null || \
  grep -E 'reset|checkout' "$SERVICE_TEST_GIT_CALLS" >/dev/null || \
  [[ -e "$SERVICE_TEST_PNPM_CALLS" ]]; then
  printf '%s\n' 'Resolving an Update changed the checkout or failed to fetch its target.' >&2
  exit 1
fi

if ! status_output=$(PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/service.sh" status); then
  printf '%s\n' 'service rejected an answering degraded health endpoint' >&2
  exit 1
fi

if [[ "$status_output" != *'Health: answering'* ]]; then
  printf '%s\n' 'service did not accept an answering degraded health endpoint' >&2
  exit 1
fi

if ! grep -F -- 'Host: hogwild.tailcad325.ts.net' "$SERVICE_TEST_CALLS" >/dev/null; then
  printf '%s\n' 'service health check did not use the configured dashboard Host' >&2
  exit 1
fi

PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/service.sh" update >/dev/null

# Desktop uses Node from PATH when the controller's dedicated runtime is absent.
if ! HARLAN_GITHUB_AGENT_NODE="$test_root/missing-node" PATH="$test_root/bin:/usr/bin:/bin" \
  bash "$script_dir/service.sh" prepare-update >/dev/null 2>&1; then
  printf '%s\n' 'service refused worker migration without a dedicated Node runtime' >&2
  exit 1
fi

if ! grep -Fx -- 'sync:skills' "$SERVICE_TEST_PNPM_CALLS" >/dev/null; then
  printf '%s\n' 'service did not restore Brundlefly Skills before startup' >&2
  exit 1
fi

if ! grep -Fx -- 'worker-skills refreshed' "$SERVICE_TEST_SYNC_CALLS" >/dev/null; then
  printf '%s\n' 'service did not refresh the isolated Agent Skill copies' >&2
  exit 1
fi

if SERVICE_TEST_SKILL_EXIT=1 PATH="$test_root/bin:/usr/bin:/bin" \
  bash "$script_dir/service.sh" prepare-update >/dev/null 2>&1; then
  printf '%s\n' 'service prepared an update after Agent Skill refresh failed' >&2
  exit 1
fi

if ! grep -F -- 'install --frozen-lockfile' "$SERVICE_TEST_PNPM_CALLS" >/dev/null; then
  printf '%s\n' 'service did not use the installed pnpm fallback' >&2
  exit 1
fi

if ! grep -F -- 'dashboard:build' "$SERVICE_TEST_PNPM_CALLS" >/dev/null; then
  printf '%s\n' 'service did not build the dashboard with the installed pnpm fallback' >&2
  exit 1
fi

if ! grep -Fx -- 'context local' "$SERVICE_TEST_SYNC_CALLS" >/dev/null; then
  printf '%s\n' 'service did not sync Agent instructions from the deployed commit' >&2
  exit 1
fi

if ! grep -Fx -- 'worktrunk update' "$SERVICE_TEST_SYNC_CALLS" >/dev/null; then
  printf '%s\n' 'service did not install Worktrunk settings from the deployed commit' >&2
  exit 1
fi

# A configuration the new revision rejects must stop the deploy before the
# restart. Restarting into it leaves systemd retrying a process that cannot
# start, which is an outage until a person edits the configuration.
if SERVICE_TEST_CLI_EXIT=1 PATH="$test_root/bin:/usr/bin:/bin" \
  bash "$script_dir/service.sh" prepare-update >/dev/null 2>&1; then
  printf '%s\n' 'service prepared an update although the new revision rejects the configuration' >&2
  exit 1
fi

if ! SERVICE_TEST_CLI_EXIT=0 PATH="$test_root/bin:/usr/bin:/bin" \
  bash "$script_dir/service.sh" prepare-update >/dev/null 2>&1; then
  printf '%s\n' 'service refused an update although the new revision accepts the configuration' >&2
  exit 1
fi

# A restart starts the same process as a deploy, and the configuration can move
# between the two. A restart into a configuration this revision rejects is the
# same outage, so it stops the same way.
if SERVICE_TEST_CLI_EXIT=1 PATH="$test_root/bin:/usr/bin:/bin" \
  bash "$script_dir/service.sh" restart >/dev/null 2>&1; then
  printf '%s\n' 'service restarted although the deployed revision rejects the configuration' >&2
  exit 1
fi

if ! SERVICE_TEST_CLI_EXIT=0 PATH="$test_root/bin:/usr/bin:/bin" \
  bash "$script_dir/service.sh" restart >/dev/null 2>&1; then
  printf '%s\n' 'service refused a restart although the deployed revision accepts the configuration' >&2
  exit 1
fi

# A checkout change must run the target's preparation in a fresh shell. The
# loaded shell still holds the old functions after Git replaces its script.
(
  unset -f git
  fixture_origin="$test_root/origin"
  export HARLAN_GITHUB_AGENT_CHECKOUT="$test_root/updating-service"
  export SERVICE_TEST_TARGET_CALLS="$test_root/target.calls"
  mkdir -p "$fixture_origin/scripts"
  git init --quiet "$fixture_origin"
  git -C "$fixture_origin" config user.name Test
  git -C "$fixture_origin" config user.email test@example.invalid
  git -C "$fixture_origin" config core.hooksPath /dev/null
  cp "$script_dir/service.sh" "$fixture_origin/scripts/service.sh"
  git -C "$fixture_origin" add .
  git -C "$fixture_origin" commit --quiet -m 'test: record loaded preparation'
  old_commit=$(git -C "$fixture_origin" rev-parse HEAD)
  cat > "$fixture_origin/scripts/service.sh" <<'TARGET'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" != prepare-update || "${2:-}" != "$(git -C "$HARLAN_GITHUB_AGENT_CHECKOUT" rev-parse HEAD)" ]]; then
  printf '%s\n' 'Target preparation received another command or commit.' >&2
  exit 1
fi
printf '%s\n' target >> "$SERVICE_TEST_TARGET_CALLS"
exit "${SERVICE_TEST_TARGET_EXIT:-0}"
TARGET
  git -C "$fixture_origin" add .
  git -C "$fixture_origin" commit --quiet -m 'test: change target preparation'
  target_commit=$(git -C "$fixture_origin" rev-parse HEAD)
  cp "$script_dir/service.sh" "$fixture_origin/scripts/service.sh"
  git -C "$fixture_origin" add .
  git -C "$fixture_origin" commit --quiet -m 'test: record newer preparation'
  newer_commit=$(git -C "$fixture_origin" rev-parse HEAD)
  git clone --quiet "$fixture_origin" "$HARLAN_GITHUB_AGENT_CHECKOUT"

  for source_commit in "$old_commit" "$newer_commit"; do
    for command in prepare-update update; do
      for target_exit in 0 17; do
        git -C "$HARLAN_GITHUB_AGENT_CHECKOUT" reset --hard --quiet "$source_commit"
        : > "$SERVICE_TEST_TARGET_CALLS"
        : > "$SERVICE_TEST_PNPM_CALLS"
        : > "$SERVICE_TEST_SYSTEMCTL_CALLS"
        status=0
        SERVICE_TEST_TARGET_EXIT="$target_exit" PATH="$test_root/bin:/usr/bin:/bin" \
          bash "$HARLAN_GITHUB_AGENT_CHECKOUT/scripts/service.sh" "$command" "$target_commit" >/dev/null 2>&1 || status=$?
        if [[ "$status" != "$target_exit" || "$(cat "$SERVICE_TEST_TARGET_CALLS")" != target || -s "$SERVICE_TEST_PNPM_CALLS" ]]; then
          printf '%s\n' 'Service update did not run target preparation once or preserve its failure.' >&2
          exit 1
        fi
        restarts=$(grep -Fc -- '--user restart harlan-github-agent' "$SERVICE_TEST_SYSTEMCTL_CALLS" || true)
        expected_restarts=0
        if [[ "$command" == update && "$target_exit" == 0 ]]; then
          expected_restarts=1
        fi
        if [[ "$restarts" != "$expected_restarts" ]]; then
          printf '%s\n' 'Service update restarted before target preparation succeeded.' >&2
          exit 1
        fi
      done
    done
  done
)

printf '%s\n' 'service tests passed'
