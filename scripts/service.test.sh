#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

export HOME="$test_root/home"
export HARLAN_GITHUB_AGENT_CHECKOUT="$test_root/service"
export SERVICE_TEST_CALLS="$test_root/curl.calls"

mkdir -p "$HARLAN_GITHUB_AGENT_CHECKOUT/.git" "$HOME/.config/harlan-github-agent"
printf '%s\n' 'server:' '  allowed_origin: https://hogwild.tailcad325.ts.net' > "$HOME/.config/harlan-github-agent/config.yml"
printf '%s\n' 'password' > "$HOME/.config/harlan-github-agent/dashboard-password"

git() {
  printf '%s\n' 'deployed revision'
}

systemctl() {
  return 0
}

curl() {
  printf '%s\n' "$*" > "$SERVICE_TEST_CALLS"
}

export -f git systemctl curl

bash "$script_dir/service.sh" status >/dev/null

if ! grep -F -- 'Host: hogwild.tailcad325.ts.net' "$SERVICE_TEST_CALLS" >/dev/null; then
  printf '%s\n' 'service health check did not use the configured dashboard Host' >&2
  exit 1
fi

printf '%s\n' 'service tests passed'
