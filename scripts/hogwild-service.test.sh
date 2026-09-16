#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

test_home="$test_root/home"
rendered_home="$test_root/rendered"
export HOGWILD_SERVICE_TEST_RENDERED_HOME="$rendered_home"
export HARLAN_AGENT_CONTEXT_MEMORY_ROOT="$test_home/.claude/projects"
export HARLAN_AGENT_CONTEXT_CHECKOUT_ROOTS="$test_home/sites"
export HARLAN_GITHUB_AGENT_PASSWORD_FILE="$test_home/.config/harlan-github-agent/dashboard-password"
export HOGWILD_SERVICE_TEST_CALLS="$test_root/calls"
export HOGWILD_SERVICE_TEST_CLAUDE_HASH=''
export HOGWILD_SERVICE_TEST_CODEX_HASH=''
export HOGWILD_SERVICE_TEST_OVERRIDE_HASH=''
export HOGWILD_SERVICE_TEST_WORKTRUNK_HASH=''
export HOGWILD_SERVICE_TEST_ENV_TOOL_HASH=''
export HOGWILD_SERVICE_TEST_ENV_MANIFEST_HASH=''
export HOGWILD_SERVICE_TEST_ENV_STAGE=/home/harlan/.cache/harlan-repository-env.fixture
export HOGWILD_SERVICE_TEST_RESTART_AFTER=1
export HOGWILD_SERVICE_TEST_STATE_POLLS="$test_root/state-polls"
export HOGWILD_SERVICE_TEST_LEGACY=false
export HOGWILD_SERVICE_TEST_LEGACY_SAFE_AFTER=1
export HOGWILD_SERVICE_TEST_LEGACY_STATE="$test_root/legacy-state"
export HARLAN_REPOSITORY_ENV_HOME="$test_home"
export HARLAN_REPOSITORY_ENV_MANIFEST="$test_root/repository-env-files"
# Without this the script reads the real ~/sites/SITES.md. A machine that has
# one failed, and CI passed only because it has none, so the sites sync was
# never covered anywhere.
export HARLAN_AGENT_CONTEXT_SITES_FILE="$test_root/SITES.md"
# The desktop step moves a checkout and restarts a unit on the machine running
# the deploy. Point all three at fixtures, or the tests update the real client.
export HARLAN_GITHUB_AGENT_DESKTOP_UNIT=harlan-desktop-agent-fixture
export HARLAN_GITHUB_AGENT_SERVICE_SCRIPT="$test_root/bin/service-fixture.sh"
export XDG_CONFIG_HOME="$test_home/.config"

mkdir -p "$test_home/.config/harlan-github-agent" "$test_home/sites/example" "$test_root/bin"
printf '%s\n' 'password' > "$HARLAN_GITHUB_AGENT_PASSWORD_FILE"
git init --quiet --initial-branch=main "$test_home/sites/example"
printf '%s\n' '.env' > "$test_home/sites/example/.gitignore"
printf '%s\n' 'SECRET=fixture' > "$test_home/sites/example/.env"
git -C "$test_home/sites/example" add .gitignore
git -C "$test_home/sites/example" -c user.name=Fixture -c user.email=fixture@example.com commit --quiet -m fixture
git -C "$test_home/sites/example" remote add origin git@github.com:fixture/example.git
printf '%s\n' 'fixture/example sites/example/.env' > "$HARLAN_REPOSITORY_ENV_MANIFEST"
printf '%s\n' '# Sites' 'fixture/example' > "$HARLAN_AGENT_CONTEXT_SITES_FILE"
HARLAN_AGENT_CONTEXT_HOME="$rendered_home" bash "$script_dir/sync-agent-context.sh" local >/dev/null
expected_claude_hash=$(/usr/bin/sha256sum "$rendered_home/.claude/CLAUDE.md" | cut -d' ' -f1)
expected_codex_hash=$(/usr/bin/sha256sum "$rendered_home/.codex/AGENTS.md" | cut -d' ' -f1)
expected_override_hash=$(/usr/bin/sha256sum "$script_dir/hogwild-service.conf" | cut -d' ' -f1)
expected_worktrunk_hash=$(/usr/bin/sha256sum "$script_dir/worktrunk.toml" | cut -d' ' -f1)
expected_env_tool_hash=$(/usr/bin/sha256sum "$script_dir/repository-env.sh" | cut -d' ' -f1)
expected_env_manifest_hash=$(/usr/bin/sha256sum "$HARLAN_REPOSITORY_ENV_MANIFEST" | cut -d' ' -f1)
expected_sites_hash=$(/usr/bin/sha256sum "$HARLAN_AGENT_CONTEXT_SITES_FILE" | cut -d' ' -f1)
export HOGWILD_SERVICE_TEST_CLAUDE_HASH="$expected_claude_hash"
export HOGWILD_SERVICE_TEST_CODEX_HASH="$expected_codex_hash"
export HOGWILD_SERVICE_TEST_OVERRIDE_HASH="$expected_override_hash"
export HOGWILD_SERVICE_TEST_WORKTRUNK_HASH="$expected_worktrunk_hash"
export HOGWILD_SERVICE_TEST_ENV_TOOL_HASH="$expected_env_tool_hash"
export HOGWILD_SERVICE_TEST_ENV_MANIFEST_HASH="$expected_env_manifest_hash"
export HOGWILD_SERVICE_TEST_SITES_HASH="$expected_sites_hash"
printf '%s\n' '0' > "$HOGWILD_SERVICE_TEST_STATE_POLLS"
printf '%s\n' 'Running' > "$HOGWILD_SERVICE_TEST_LEGACY_STATE"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''ssh %s\n'\'' "$*" >> "$HOGWILD_SERVICE_TEST_CALLS"' \
  'if [[ "$*" == *mktemp*-d* ]]; then printf '\''%s\n'\'' "$HOGWILD_SERVICE_TEST_ENV_STAGE"; exit; fi' \
  'if [[ "$*" == *sha256sum*hogwild.conf.next* ]]; then printf '\''%s  hogwild.conf.next\n'\'' "$HOGWILD_SERVICE_TEST_OVERRIDE_HASH"; elif [[ "$*" == *sha256sum*harlan-repository-env.next* ]]; then printf '\''%s  harlan-repository-env.next\n'\'' "$HOGWILD_SERVICE_TEST_ENV_TOOL_HASH"; elif [[ "$*" == *sha256sum*repository-env-files.next* ]]; then printf '\''%s  repository-env-files.next\n'\'' "$HOGWILD_SERVICE_TEST_ENV_MANIFEST_HASH"; elif [[ "$*" == *sha256sum*worktrunk/config.toml.next* ]]; then printf '\''%s  config.toml.next\n'\'' "$HOGWILD_SERVICE_TEST_WORKTRUNK_HASH"; elif [[ "$*" == *sha256sum*CLAUDE.md.next* ]]; then printf '\''%s  CLAUDE.md.next\n'\'' "$HOGWILD_SERVICE_TEST_CLAUDE_HASH"; elif [[ "$*" == *sha256sum*AGENTS.md.next* ]]; then printf '\''%s  AGENTS.md.next\n'\'' "$HOGWILD_SERVICE_TEST_CODEX_HASH"; elif [[ "$*" == *sha256sum*SITES.md.next* ]]; then printf '\''%s  SITES.md.next\n'\'' "$HOGWILD_SERVICE_TEST_SITES_HASH"; fi' \
  > "$test_root/bin/ssh"
cat >> "$test_root/bin/ssh" <<'FAKE_SSH'
# Context sync also verifies the commit hook and the installed opencode files.
if [[ "$*" == *sha256sum* && ( "$*" == *commit-msg.next* || "$*" == *harlan-hooks.ts.next* ) ]]; then
  for token in $*; do
    if [[ "$token" == *.next* ]]; then
      remote_path=${token//\'/}
      local_path="$HOGWILD_SERVICE_TEST_RENDERED_HOME${remote_path#/home/harlan}"
      /usr/bin/sha256sum "${local_path%%.next*}"
    fi
  done
fi
FAKE_SSH
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''scp %s\n'\'' "$*" >> "$HOGWILD_SERVICE_TEST_CALLS"' \
  > "$test_root/bin/scp"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''rsync %s\n'\'' "$*" >> "$HOGWILD_SERVICE_TEST_CALLS"' \
  > "$test_root/bin/rsync"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''curl %s\n'\'' "$*" >> "$HOGWILD_SERVICE_TEST_CALLS"' \
  'if [ "$HOGWILD_SERVICE_TEST_LEGACY" = true ]; then' \
  '  if [[ "$*" == *api/agents/pause* ]]; then printf '\''Paused\n'\'' > "$HOGWILD_SERVICE_TEST_LEGACY_STATE"; printf '\''{"_tag":"Paused"}\n'\''; exit; fi' \
  '  if [[ "$*" == *api/agents/resume* ]]; then printf '\''Running\n'\'' > "$HOGWILD_SERVICE_TEST_LEGACY_STATE"; printf '\''{"_tag":"Running"}\n'\''; exit; fi' \
  '  if [[ "$*" == *api/state* ]]; then' \
  '    control=$(cat "$HOGWILD_SERVICE_TEST_LEGACY_STATE")' \
  '    safe=false' \
  '    if [ "$control" = Paused ]; then' \
  '      polls=$(($(cat "$HOGWILD_SERVICE_TEST_STATE_POLLS") + 1))' \
  '      printf '\''%s\n'\'' "$polls" > "$HOGWILD_SERVICE_TEST_STATE_POLLS"' \
  '      if ((polls >= HOGWILD_SERVICE_TEST_LEGACY_SAFE_AFTER)); then safe=true; fi' \
  '    fi' \
  '    printf '\''{"agentControl":{"_tag":"%s","safeToRestart":%s}}\n'\'' "$control" "$safe"' \
  '    exit' \
  '  fi' \
  'fi' \
  'if [[ "$*" == *api/service/restart* ]]; then printf '\''{"_tag":"Requested","id":"restart-1","source":"helper","requestedAt":"2026-08-29T01:00:00.000Z"}\n'\''; exit; fi' \
  'if [[ "$*" == *api/state* ]]; then' \
  '  polls=$(($(cat "$HOGWILD_SERVICE_TEST_STATE_POLLS") + 1))' \
  '  printf '\''%s\n'\'' "$polls" > "$HOGWILD_SERVICE_TEST_STATE_POLLS"' \
  '  status=Requested' \
  '  if ((polls >= HOGWILD_SERVICE_TEST_RESTART_AFTER)); then status=Completed; fi' \
  '  printf '\''{"agentControl":{"_tag":"Running"},"restartRequest":{"_tag":"%s","id":"restart-1","source":"helper","requestedAt":"2026-08-29T01:00:00.000Z"}}\n'\'' "$status"' \
  'fi' \
  > "$test_root/bin/curl"
printf '%s\n' '#!/usr/bin/env bash' 'exit 0' > "$test_root/bin/sleep"
cat > "$test_root/bin/systemctl" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$HOGWILD_SERVICE_TEST_CALLS"
if [[ "$*" == *list-unit-files* ]]; then
  printf '%s.service enabled enabled\n' "$HARLAN_GITHUB_AGENT_DESKTOP_UNIT"
fi
FAKE_SYSTEMCTL
cat > "$test_root/bin/service-fixture.sh" <<'FAKE_SERVICE'
#!/usr/bin/env bash
printf 'service %s\n' "$*" >> "$HOGWILD_SERVICE_TEST_CALLS"
FAKE_SERVICE
chmod +x "$test_root/bin/systemctl" "$test_root/bin/service-fixture.sh"
chmod +x "$test_root/bin/ssh" "$test_root/bin/scp" "$test_root/bin/rsync" "$test_root/bin/curl" "$test_root/bin/sleep"

PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/hogwild-service.sh" update >/dev/null

claude_copy_line=$(grep -n '^scp .*CLAUDE.md hogwild:/home/harlan/.claude/CLAUDE.md.next\.[0-9.]*$' "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
codex_copy_line=$(grep -n '^scp .*AGENTS.md hogwild:/home/harlan/.codex/AGENTS.md.next\.[0-9.]*$' "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
install_line=$(grep -nE "mv '/home/harlan/.codex/AGENTS.md.next\.[0-9.]+' '/home/harlan/.codex/AGENTS.md'" "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
limits_copy_line=$(grep -n '^scp .*hogwild-service.conf .*hogwild:/home/harlan/.config/systemd/user/harlan-github-agent.service.d/hogwild.conf.next\.[0-9.]*$' "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
limits_install_line=$(grep -nE "mv '/home/harlan/.config/systemd/user/harlan-github-agent.service.d/hogwild.conf.next\.[0-9.]+' '/home/harlan/.config/systemd/user/harlan-github-agent.service.d/hogwild.conf'" "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
env_tool_install_line=$(grep -nE "mv '/home/harlan/.local/bin/harlan-repository-env.next\.[0-9.]+' '/home/harlan/.local/bin/harlan-repository-env'" "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
env_manifest_install_line=$(grep -nE "mv '/home/harlan/.config/harlan-agent-kit/repository-env-files.next\.[0-9.]+' '/home/harlan/.config/harlan-agent-kit/repository-env-files'" "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
worktrunk_install_line=$(grep -nE "mv '/home/harlan/.config/worktrunk/config.toml.next\.[0-9.]+' '/home/harlan/.config/worktrunk/config.toml'" "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
env_copy_line=$(grep -n '^rsync ' "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
env_install_line=$(grep -nF "install-staged '/home/harlan/.cache/harlan-repository-env.fixture'" "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
prepare_line=$(grep -nF "bash -s -- 'prepare-update' 'origin/main'" "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
restart_line=$(grep -n '/api/service/restart' "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)

# An empty capture reads as 0 inside (( )), so a pattern that matched nothing
# would still satisfy the ordering below. Refuse that before comparing.
for step in claude_copy_line codex_copy_line install_line limits_copy_line limits_install_line \
  env_tool_install_line env_manifest_install_line worktrunk_install_line env_copy_line \
  env_install_line prepare_line restart_line; do
  if [ -z "${!step}" ]; then
    printf '%s\n' "Hogwild update never logged the step this test orders: $step." >&2
    exit 1
  fi
done
if ! ((claude_copy_line < codex_copy_line && codex_copy_line < install_line && install_line < limits_copy_line && limits_copy_line < limits_install_line && limits_install_line < env_tool_install_line && env_tool_install_line < env_manifest_install_line && env_manifest_install_line < worktrunk_install_line && worktrunk_install_line < env_copy_line && env_copy_line < env_install_line && env_install_line < prepare_line && prepare_line < restart_line)); then
  printf '%s\n' 'Hogwild update did not prepare files before its Restart request.' >&2
  exit 1
fi
if grep -E '/api/agents/(pause|resume)' "$HOGWILD_SERVICE_TEST_CALLS" >/dev/null; then
  printf '%s\n' 'Hogwild update changed manual Pause.' >&2
  exit 1
fi
if grep -F "bash -s -- 'restart'" "$HOGWILD_SERVICE_TEST_CALLS" >/dev/null; then
  printf '%s\n' 'Hogwild update used a client-owned restart.' >&2
  exit 1
fi

if ! grep -q "sites/SITES.md" "$HOGWILD_SERVICE_TEST_CALLS"; then
  printf '%s\n' 'The site inventory never reached Hogwild.' >&2
  exit 1
fi

# The desktop client moves with Hogwild, and its unit moves with the client, or
# the new code runs in the old environment.
if ! grep -q "^service prepare-update" "$HOGWILD_SERVICE_TEST_CALLS" \
  || ! grep -q "^systemctl --user restart" "$HOGWILD_SERVICE_TEST_CALLS"; then
  printf '%s\n' 'The deploy did not update the desktop client.' >&2
  exit 1
fi
if [ ! -f "$XDG_CONFIG_HOME/systemd/user/$HARLAN_GITHUB_AGENT_DESKTOP_UNIT.service" ]; then
  printf '%s\n' 'The deploy did not install the desktop unit.' >&2
  exit 1
fi

: > "$HOGWILD_SERVICE_TEST_CALLS"
PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/hogwild-service.sh" sync-env >/dev/null
if ! grep -q '^rsync ' "$HOGWILD_SERVICE_TEST_CALLS" \
  || ! grep -q 'install-staged' "$HOGWILD_SERVICE_TEST_CALLS"; then
  printf '%s\n' 'Manual repository environment sync did not install the files.' >&2
  exit 1
fi
if grep -E "prepare-update|api/service/restart" "$HOGWILD_SERVICE_TEST_CALLS" >/dev/null; then
  printf '%s\n' 'Manual repository environment sync changed the service.' >&2
  exit 1
fi

: > "$HOGWILD_SERVICE_TEST_CALLS"
export HOGWILD_SERVICE_TEST_ENV_STAGE=/tmp/unsafe
if PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/hogwild-service.sh" sync-env >/dev/null 2>&1; then
  printf '%s\n' 'Repository environment sync accepted an unsafe Hogwild stage.' >&2
  exit 1
fi
if grep -q '^rsync ' "$HOGWILD_SERVICE_TEST_CALLS"; then
  printf '%s\n' 'Repository environment sync copied files to an unsafe Hogwild stage.' >&2
  exit 1
fi
export HOGWILD_SERVICE_TEST_ENV_STAGE=/home/harlan/.cache/harlan-repository-env.fixture

: > "$HOGWILD_SERVICE_TEST_CALLS"
export HOGWILD_SERVICE_TEST_CODEX_HASH='different'
if PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/hogwild-service.sh" update >/dev/null 2>&1; then
  printf '%s\n' 'Hogwild update accepted a context hash mismatch.' >&2
  exit 1
fi
if grep -E "prepare-update|api/service/restart" "$HOGWILD_SERVICE_TEST_CALLS" >/dev/null; then
  printf '%s\n' 'Hogwild updated or restarted after a context hash mismatch.' >&2
  exit 1
fi

: > "$HOGWILD_SERVICE_TEST_CALLS"
printf '%s\n' '0' > "$HOGWILD_SERVICE_TEST_STATE_POLLS"
export HOGWILD_SERVICE_TEST_CODEX_HASH="$expected_codex_hash"
export HOGWILD_SERVICE_TEST_RESTART_AFTER=61
PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/hogwild-service.sh" restart >/dev/null
if [ "$(cat "$HOGWILD_SERVICE_TEST_STATE_POLLS")" -lt 61 ]; then
  printf '%s\n' 'Hogwild stopped observing before the Restart request completed.' >&2
  exit 1
fi
if grep -E '/api/agents/(pause|resume)' "$HOGWILD_SERVICE_TEST_CALLS" >/dev/null; then
  printf '%s\n' 'Hogwild restart changed manual Pause.' >&2
  exit 1
fi

: > "$HOGWILD_SERVICE_TEST_CALLS"
printf '%s\n' '0' > "$HOGWILD_SERVICE_TEST_STATE_POLLS"
printf '%s\n' 'Running' > "$HOGWILD_SERVICE_TEST_LEGACY_STATE"
export HOGWILD_SERVICE_TEST_LEGACY=true
export HOGWILD_SERVICE_TEST_LEGACY_SAFE_AFTER=3
PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/hogwild-service.sh" restart >/dev/null
legacy_pause_line=$(grep -n '/api/agents/pause' "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
legacy_restart_line=$(grep -nF "bash -s -- 'restart'" "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
legacy_resume_line=$(grep -n '/api/agents/resume' "$HOGWILD_SERVICE_TEST_CALLS" | cut -d: -f1)
if ! ((legacy_pause_line < legacy_restart_line && legacy_restart_line < legacy_resume_line)); then
  printf '%s\n' 'The compatibility restart did not drain, restart, and restore Agent control.' >&2
  exit 1
fi
if [ "$(cat "$HOGWILD_SERVICE_TEST_LEGACY_STATE")" != Running ]; then
  printf '%s\n' 'The compatibility restart did not restore Running Agent control.' >&2
  exit 1
fi
if grep -F '/api/service/restart' "$HOGWILD_SERVICE_TEST_CALLS" >/dev/null; then
  printf '%s\n' 'The compatibility restart called an unavailable endpoint.' >&2
  exit 1
fi

: > "$HOGWILD_SERVICE_TEST_CALLS"
printf '%s\n' '0' > "$HOGWILD_SERVICE_TEST_STATE_POLLS"
printf '%s\n' 'Paused' > "$HOGWILD_SERVICE_TEST_LEGACY_STATE"
export HOGWILD_SERVICE_TEST_LEGACY_SAFE_AFTER=1
PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/hogwild-service.sh" restart >/dev/null
if grep -E '/api/agents/(pause|resume)' "$HOGWILD_SERVICE_TEST_CALLS" >/dev/null; then
  printf '%s\n' 'The compatibility restart changed an existing manual Pause.' >&2
  exit 1
fi
if [ "$(cat "$HOGWILD_SERVICE_TEST_LEGACY_STATE")" != Paused ]; then
  printf '%s\n' 'The compatibility restart did not preserve manual Pause.' >&2
  exit 1
fi

printf '%s\n' 'Hogwild service tests passed'
