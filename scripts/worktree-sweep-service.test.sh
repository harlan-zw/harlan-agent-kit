#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

export HOME="$test_root/home"
export WORKTREE_SWEEP_SYSTEMCTL_CALLS="$test_root/systemctl.calls"
mkdir -p "$HOME" "$test_root/bin"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'printf '\''%s\n'\'' "$*" >> "$WORKTREE_SWEEP_SYSTEMCTL_CALLS"' \
  > "$test_root/bin/systemctl"
chmod +x "$test_root/bin/systemctl"

PATH="$test_root/bin:/usr/bin:/bin" bash "$script_dir/worktree-sweep-service.sh" update >/dev/null

cmp --silent "$script_dir/worktree-sweep.sh" "$HOME/.local/bin/git-worktree-sweep"
cmp --silent "$script_dir/worktree-sweep.service" "$HOME/.config/systemd/user/git-worktree-sweep.service"
cmp --silent "$script_dir/worktree-sweep.timer" "$HOME/.config/systemd/user/git-worktree-sweep.timer"
test "$(stat -c %a "$HOME/.local/bin/git-worktree-sweep")" = 755
test "$(stat -c %a "$HOME/.config/systemd/user/git-worktree-sweep.service")" = 644
test "$(stat -c %a "$HOME/.config/systemd/user/git-worktree-sweep.timer")" = 644
grep -Fx -- '--user daemon-reload' "$WORKTREE_SWEEP_SYSTEMCTL_CALLS" >/dev/null
grep -Fx -- '--user enable --now git-worktree-sweep.timer' "$WORKTREE_SWEEP_SYSTEMCTL_CALLS" >/dev/null

printf '%s\n' 'Worktree sweep service tests passed'
