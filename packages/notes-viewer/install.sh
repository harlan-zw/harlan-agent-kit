#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
install_dir="$HOME/.local/share/harlan-agent-kit/notes-viewer"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$install_dir/.vitepress" "$unit_dir" "$HOME/notes"
node "$source_dir/stage-install.mjs" "$source_dir" "$install_dir"
pnpm --dir "$install_dir" install --ignore-scripts
portless_bin=$(command -v portless)
node_bin=$(command -v node)
cat > "$unit_dir/harlan-notes-viewer.service" <<UNIT
[Unit]
Description=Local notes viewer
After=network.target

[Service]
Type=simple
WorkingDirectory=$install_dir
Environment="PATH=$PATH"
ExecStart=$portless_bin notes $node_bin $install_dir/start.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now harlan-notes-viewer.service
systemctl --user restart harlan-notes-viewer.service
printf '%s\n' 'Notes: https://notes.localhost/'
