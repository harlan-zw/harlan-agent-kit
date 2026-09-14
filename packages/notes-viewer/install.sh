#!/usr/bin/env bash
set -euo pipefail
source_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
install_dir="$HOME/.local/share/harlan-agent-kit/notes-viewer"
unit_dir="$HOME/.config/systemd/user"
mkdir -p "$install_dir/.vitepress" "$unit_dir" "$HOME/notes"
cp "$source_dir/package.json" "$source_dir/start.mjs" "$install_dir/"
cp "$source_dir/.vitepress/config.mjs" "$install_dir/.vitepress/"
# Resolve workspace catalog dependencies to the versions verified in this checkout.
node --input-type=module - "$source_dir" "$install_dir" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [source, target] = process.argv.slice(2)
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
for (const name of Object.keys(manifest.dependencies)) {
  manifest.dependencies[name] = JSON.parse(readFileSync(join(source, 'node_modules', name, 'package.json'), 'utf8')).version
}
writeFileSync(join(target, 'package.json'), JSON.stringify(manifest, null, 2))
JS
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
