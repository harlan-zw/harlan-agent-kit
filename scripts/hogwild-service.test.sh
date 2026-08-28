#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

export HOME="$test_root/home"
export HOGWILD_SERVICE_TEST_CALLS="$test_root/calls"
export HOGWILD_SERVICE_TEST_HASH=''
export HOGWILD_SERVICE_TEST_STATE="$test_root/control-state"

mkdir -p "$HOME/.codex" "$HOME/.config/harlan-github-agent" "$test_root/bin"
printf '%s\n' '# Global Agent instructions' > "$HOME/.codex/AGENTS.md"
printf '%s\n' 'password' > "$HOME/.config/harlan-github-agent/dashboard-password"
expected_hash=$(/usr/bin/sha256sum "$HOME/.codex/AGENTS.md" | cut -d' ' -f1)
export HOGWILD_SERVICE_TEST_HASH="$expected_hash"
printf '%s\n' 'Running' > "$HOGWILD_SERVICE_TEST_STATE"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''ssh %s\n'\'' "$*" >> "$HOGWILD_SERVICE_TEST_CALLS"' \
  'if [[ "$*" == *sha256sum* ]]; then printf '\''%s  /home/harlan/.codex/AGENTS.md\n'\'' "$HOGWILD_SERVICE_TEST_HASH"; fi' \
  > "$test_root/bin/ssh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''scp %s\n'\'' "$*" >> "$HOGWILD_SERVICE_TEST_CALLS"' \
  > "$test_root/bin/scp"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''curl %s\n'\'' "$*" >> "$HOGWILD_SERVICE_TEST_CALLS"' \
  'if [[ "$*" == *api/agents/pause* ]]; then printf '\''Paused\n'\'' > "$HOGWILD_SERVICE_TEST_STATE"; printf '\''{"_tag":"Paused"}\n'\''; exit; fi' \
  'if [[ "$*" == *api/agents/resume* ]]; then printf '\''Running\n'\'' > "$HOGWILD_SERVICE_TEST_STATE"; printf '\''{"_tag":"Running"}\n'\''; exit; fi' \
  'if [[ "$*" == *api/state* ]]; then state=$(cat "$HOGWILD_SERVICE_TEST_STATE"); if [[ "$state" == Paused ]]; then printf '\''{"agentControl":{"_tag":"Paused","safeToRestart":true}}\n'\''; else printf '\''{"agentControl":{"_tag":"Running"}}\n'\''; fi; fi' \
  > "$test_root/bin/curl"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$test_root/bin/sleep"
chmod +x "$test_root/bin/ssh" "$test_root/bin/scp" "$test_root/bin/curl" "$test_root/bin/sleep"

PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/hogwild-service.sh" update >/dev/null

pause_line=$(grep -n '/api/agents/pause' "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
copy_line=$(grep -n '^scp .*AGENTS.md .*hogwild:/home/harlan/.codex/AGENTS.md.next$' "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
install_line=$(grep -nF "mv '/home/harlan/.codex/AGENTS.md.next' '/home/harlan/.codex/AGENTS.md'" "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
update_line=$(grep -nF "bash -s -- 'update' 'origin/main'" "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
resume_line=$(grep -n '/api/agents/resume' "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)

if ! ((pause_line < copy_line && copy_line < install_line && install_line < update_line && update_line < resume_line)); then
  printf '%s\n' 'Hogwild update did not pause, sync, update, and resume in order' >&2
  exit 1
fi

: > "$HOGWILD_SERVICE_TEST_CALLS"
export HOGWILD_SERVICE_TEST_HASH='different'
if PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/hogwild-service.sh" update >/dev/null 2>&1; then
  printf '%s\n' 'Hogwild update accepted a context hash mismatch' >&2
  exit 1
fi
if grep -F "bash -s -- 'update'" "$HOGWILD_SERVICE_TEST_CALLS" >/dev/null; then
  printf '%s\n' 'Hogwild update restarted after a context hash mismatch' >&2
  exit 1
fi
if [ "$(cat "$HOGWILD_SERVICE_TEST_STATE")" != Running ]; then
  printf '%s\n' 'Hogwild remained paused after a context hash mismatch' >&2
  exit 1
fi

: > "$HOGWILD_SERVICE_TEST_CALLS"
printf '%s\n' 'Paused' > "$HOGWILD_SERVICE_TEST_STATE"
export HOGWILD_SERVICE_TEST_HASH="$expected_hash"
PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/hogwild-service.sh" update >/dev/null
if grep -E '/api/agents/(pause|resume)' "$HOGWILD_SERVICE_TEST_CALLS" >/dev/null; then
  printf '%s\n' 'Hogwild update changed an existing Pause' >&2
  exit 1
fi

printf '%s\n' 'Hogwild service tests passed'
