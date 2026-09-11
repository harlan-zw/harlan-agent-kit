---
name: hogwild
description: "Operate the Hogwild home server: which SSH host to use, which account holds sudo, what runs there, where each repo, service, route, and config lives, and how to install tools for the Agent. Use for any task that touches Hogwild over SSH."
user_invocable: true
argument-hint: "[task on Hogwild]"
---

# Hogwild

Hogwild is one Ubuntu host on the LAN and the tailnet. It runs the Harlan GitHub Agent, the GitHub runner supervisor, three public sites behind one Cloudflare tunnel, AdGuard DNS, and Jellyfin.

## Pick the SSH host first

| Command | Account | Use it for |
| --- | --- | --- |
| `ssh hogwild` | `harlan` | Agent state, config, checkouts under `~/pkg` and `~/sites`, `systemctl --user`, tool links in `~/.local/bin`. No sudo, no docker. |
| `ssh hogwild-admin` | `harlan-admin` | `sudo`, `apt`, `docker`, system `systemctl`, `/etc`, `/opt`, `/var/lib`. Cannot read `/home/harlan`. |

If the task needs both, run two commands. Never grant `harlan` sudo or docker. Never SSH as root. The Agent runs public issue text under `harlan`; root there is the attack path the split closed on 2026-09-11.

The desktop zsh aliases `hogwild`, `hogwild-lan`, `hogwild-admin`, `hogwild-admin-lan` use the same key `~/.ssh/id_ed25519_hogwild`.

## What runs there

| Service | Unit | Account | Listens | Source |
| --- | --- | --- | --- | --- |
| Harlan GitHub Agent | `harlan-github-agent.service` (user unit, linger) | `harlan` | `127.0.0.1:3210` dashboard, `:3211` webhook | `~/.local/share/harlan-github-agent/service` |
| GitHub runner supervisor | `hogwild-github-runner.service` | `github-runner` | none; one Docker container per job | `/var/lib/github-runner` |
| Status site | `hogwild-status.service` | `hogwild-status` | `127.0.0.1:9100` | `/opt/hogwild-status/current` |
| Dragon deck | `chasing-the-ai-dragon.service` | `dragon-deck` | `127.0.0.1:3031` | `/opt/chasing-the-ai-dragon/current` |
| Caddy | `caddy.service` | `caddy` | `127.0.0.1:8080` | `/etc/caddy/Caddyfile`, routes in `/etc/caddy/routes/*.caddy` |
| Cloudflare tunnel | `cloudflared.service` | root | outbound only | `/etc/cloudflared/config.yml` |
| AdGuard Home | `adguardhome.service` | root | DNS `:53`, admin `:5380` | `/opt/AdGuardHome` |
| Jellyfin | `jellyfin.service` | `jellyfin` | `:8096` tailnet | `/srv/jellyfin` |
| Docker | `docker.service` | root | published ports bind loopback | `/etc/docker/daemon.json`, `DOCKER-USER` rules from `hogwild-docker-user.service` |

Public routes go internet, Cloudflare tunnel, Caddy `:8080`, then the loopback port above:

- `hogwild.harlanzw.com`, the status site
- `dragon.harlanzw.com`, the deck
- `agent.harlanzw.com`, the Agent dashboard behind Basic auth; `/webhook` reaches the signed webhook listener

## Repos and config that own each part

| Part | Repo | Local checkout | Deploy |
| --- | --- | --- | --- |
| Agent service code | `harlan-zw/harlan-agent-kit` `packages/harlan-github-agent` | `~/pkg/harlan-agent-kit` | `pnpm service:hogwild:update` from the repo root |
| Agent context, worktrunk, env files | same repo, `scripts/` | same | `pnpm sync:context:hogwild`, `pnpm service:hogwild:sync-env`, `pnpm service:hogwild:sync-worktrunk` |
| Agent config | not in git | `hogwild:~/.config/harlan-github-agent/config.yml` | edit, then restart the user unit |
| Agent state | not in git | `hogwild:~/.local/share/harlan-github-agent/state.sqlite`, `journal.sqlite`, `worktrees/` | back up before a migration |
| Runner supervisor, runners.conf, Dockerfile, host hardening | `harlan-zw/hogwild-gh-runner` (private) `github-runner/` | `~/pkg/hogwild-gh-runner` | install steps in its README |
| Host security layout, Docker rules, pending items | same repo, `hogwild/` | same | `hogwild/README.md` |
| Status site | `harlan-zw/hogwild.harlanzw.com` | `~/pkg/hogwild.harlanzw.com` | GitHub Actions deploy job to `hogwild-deploy` |
| Caddy routes | `harlan-agent-kit/scripts/30-agent.caddy` for the agent route; others live only on the host | | `sudo systemctl reload caddy` |

The live `runners.conf` is `/var/lib/github-runner/config/runners.conf`. Change it in the repo first, then install it.

## Agent checkouts on the host

`harlan` holds a primary checkout for every repository the Agent works on. They live under `/home/harlan/pkg` and `/home/harlan/sites` and must stay clean on `main`. The Agent creates its worktrees under `~/.local/share/harlan-github-agent/worktrees/`.

Mapped in `config.yml` today: `nuxt-modules/robots`, `nuxt-modules/og-image`, `nuxt-modules/sitemap`, `nuxt/scripts`, `harlan-zw/nuxt-seo-utils`, `harlan-zw/nuxt-site-config`, `harlan-zw/nuxt-seo`, and the sites under `~/sites`. Read the file for the current list; do not trust this paragraph.

If a new repository joins, clone it as `harlan` into the matching directory, then add a `repositories` entry and restart the Agent.

## Install a tool for the Agent

1. Install as admin: `ssh hogwild-admin 'sudo apt-get install -y <package>'`.
2. If the Agent needs it under a different name, link it as harlan: `ssh hogwild 'ln -sf "$(command -v fdfind)" ~/.local/bin/fd'`.
3. Record it in the tools table in `hogwild-gh-runner/hogwild/README.md`.

Tools in `hogwild:~/.local/bin` today: `node`, `pnpm`, `bun`, `uv`, `gh`, `wt`, `rg`, `fd`, `ripast`, `opencode`, `codex`, `wrangler`, `sentry-cli`, `nuxtseo`, `himalaya`, `dev-browser`. No `claude`; the Agent uses `opencode`.

## Control the Agent

Prefer the control CLI from the desktop over raw `systemctl`:

```bash
harlan-github-agent control status
harlan-github-agent control pause
harlan-github-agent control restart --source helper
```

If a change needs the process to pick up new groups or a new Node, restart the user manager as admin. That kills in-flight Agent work, so pause first and get Harlan's say so:

```bash
ssh hogwild-admin 'sudo systemctl restart user@1000.service'
```

Logs: `ssh hogwild 'journalctl --user -u harlan-github-agent -n 200'`.

## Docker and firewall

`ufw` allows SSH, DNS, and the tailnet. Docker bypasses ufw, so `hogwild-docker-user.service` fills `DOCKER-USER`: containers cannot reach the LAN, the tailnet, or link-local; the LAN cannot open published ports. `daemon.json` binds published ports to loopback. After `ufw reload`, restart Docker. Verify with `sudo iptables -S DOCKER-USER`.

## Do not

- Do not start `harlan-desktop-github-runner.service` on the desktop. Hogwild is the only runner host.
- Do not add `harlan` to `sudo` or `docker`.
- Do not edit a primary checkout under `~/pkg` or `~/sites` on the host. The Agent owns them.
- Do not reboot without draining the runner: `sudo systemctl stop hogwild-github-runner.service`, then `sudo reboot`.
