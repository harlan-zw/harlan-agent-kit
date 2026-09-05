#!/usr/bin/env bash

set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
sweep_source="$script_dir/worktree-sweep.sh"
service_source="$script_dir/worktree-sweep.service"
timer_source="$script_dir/worktree-sweep.timer"
sweep_target="$HOME/.local/bin/git-worktree-sweep"
unit_root="$HOME/.config/systemd/user"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

install_asset() {
  local source=$1 target=$2 mode=$3 next
  next="$target.next.$$"
  mkdir -p "$(dirname "$target")"
  install -m "$mode" -- "$source" "$next"
  mv -fT -- "$next" "$target"
}

update() {
  [[ -f $sweep_source ]] || fail "The worktree sweep source does not exist: $sweep_source"
  [[ -f $service_source ]] || fail "The service source does not exist: $service_source"
  [[ -f $timer_source ]] || fail "The timer source does not exist: $timer_source"

  install_asset "$sweep_source" "$sweep_target" 755
  install_asset "$service_source" "$unit_root/git-worktree-sweep.service" 644
  install_asset "$timer_source" "$unit_root/git-worktree-sweep.timer" 644
  systemctl --user daemon-reload
  systemctl --user enable --now git-worktree-sweep.timer
  printf '%s\n' 'Installed the worktree sweep service.'
}

case "${1:-update}" in
  update)
    update
    ;;
  status)
    systemctl --user status git-worktree-sweep.timer git-worktree-sweep.service --no-pager --full
    ;;
  *)
    fail 'Use update or status.'
    ;;
esac
