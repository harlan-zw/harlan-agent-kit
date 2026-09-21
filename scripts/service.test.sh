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
# Stands in for the deployed CLI. Its exit code is the configuration verdict.
printf '%s\n' \
  'process.exit(Number(process.env.SERVICE_TEST_CLI_EXIT || 0))' \
  > "$HARLAN_GITHUB_AGENT_CHECKOUT/packages/harlan-github-agent/src/cli.ts"

git() {
  case "$*" in
    *'status --porcelain'*) return 0 ;;
    *'log --oneline -1'*) printf '%s\n' 'deployed revision' ;;
    *'rev-parse HEAD'*) printf '%s\n' 'deployed-sha' ;;
  esac
}

systemctl() {
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

printf '%s\n' 'service tests passed'
