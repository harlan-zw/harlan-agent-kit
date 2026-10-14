---
name: hogwild
description: 'Operate the Hogwild home server: which SSH host to use, which account holds sudo, what runs there, where each repo, service, route, and config lives, and how to install tools for the Agent. Use for any task that touches Hogwild over SSH.'
argument-hint: '[task on Hogwild]'
license: MIT
---

# Hogwild

Hogwild is one Ubuntu host on the LAN and the tailnet. It runs the Wolfstar GitHub Agent, the GitHub runner supervisor, three public sites behind one Cloudflare tunnel, AdGuard DNS, and Jellyfin.

## The `hw` CLI

Context sync installs `hw` in `~/.local/bin` for noninteractive shells.
It runs the installed planner and picks the correct account.
Run `pnpm sync:context` if the command is missing.
If sync is unavailable, run `node --experimental-strip-types scripts/hw.ts` from this Skill directory.

```bash
hw status                                  # host, services, containers, Agent unit
hw logs agent -n 100                       # or runner, caddy, tunnel, adguard, jellyfin, docker, status, dragon
hw install fd-find --link fd=fdfind        # apt as admin, link as the Agent
hw caddy check                             # or reload: validate first, then reload
hw runners                                 # live runners.conf against the repo copy, job containers
hw pending                                 # open host items from hogwild/README.md
hw run admin 'sudo iptables -S DOCKER-USER'
hw run agent 'ls ~/.local/bin'
```

`hw --help` lists every command. Reach for `ssh` directly only when `hw run` does not fit.

## Pick the SSH host first

| Command             | Account          | Use it for                                                                                                                        |
| ------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ssh hogwild`       | `wolfstar`       | Agent state, config, checkouts under `~/pkg` and `~/sites`, `systemctl --user`, tool links in `~/.local/bin`. No sudo, no docker. |
| `ssh hogwild-admin` | `wolfstar-admin` | `sudo`, `apt`, `docker`, system `systemctl`, `/etc`, `/opt`, `/var/lib`. Cannot read `/home/wolfstar`.                            |

If the task needs both, run two commands. Never grant `wolfstar` sudo or docker. Never SSH as root. The Agent runs public issue text under `wolfstar`; root there is the attack path the split closed on 2026-09-11.

The desktop zsh aliases `hogwild`, `hogwild-lan`, `hogwild-admin`, `hogwild-admin-lan` use the same key `~/.ssh/id_ed25519_hogwild`.

## What runs there

| Service                  | Unit                                                | Account          | Listens                                                                                                  | Source                                                                            |
| ------------------------ | --------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Wolfstar GitHub Agent    | `wolfstar-github-agent.service` (user unit, linger) | `wolfstar`       | `127.0.0.1:3210` dashboard, `:3211` webhook                                                              | `~/.local/share/wolfstar-github-agent/service`                                    |
| GitHub runner supervisor | `hogwild-github-runner.service`                     | `github-runner`  | none; one Docker container per job                                                                       | `/var/lib/github-runner`                                                          |
| Status site              | `hogwild-status.service`                            | `hogwild-status` | `127.0.0.1:9100`                                                                                         | `/opt/hogwild-status/current`                                                     |
| Dragon deck              | `chasing-the-ai-dragon.service`                     | `dragon-deck`    | `127.0.0.1:3031`                                                                                         | `/opt/chasing-the-ai-dragon/current`                                              |
| Caddy                    | `caddy.service`                                     | `caddy`          | `127.0.0.1:8080`                                                                                         | `/etc/caddy/Caddyfile`, routes in `/etc/caddy/routes/*.caddy`                     |
| Cloudflare tunnel        | `cloudflared.service`                               | `cloudflared`    | outbound only                                                                                            | `/etc/cloudflared/config.yml`                                                     |
| AdGuard Home             | `adguardhome.service`                               | `adguardhome`    | DNS `:53` on the LAN and tailnet addresses, admin `:5380` on every interface, ufw blocks it from the LAN | `/opt/AdGuardHome`, config in `/var/lib/adguardhome`                              |
| Jellyfin                 | `jellyfin.service`                                  | `jellyfin`       | `:8096`, ufw allows the LAN and the tailnet                                                              | `/srv/jellyfin`                                                                   |
| Docker                   | `docker.service`                                    | root             | published ports bind loopback                                                                            | `/etc/docker/daemon.json`, `DOCKER-USER` rules from `hogwild-docker-user.service` |

Public routes go internet, Cloudflare tunnel, Caddy `:8080`, then the loopback port above:

- `hogwild.harlanzw.com`, the status site
- `dragon.harlanzw.com`, the deck
- `agent.harlanzw.com`, the Agent dashboard behind Basic auth; `/webhook` reaches the signed webhook listener

## Repos and config that own each part

| Part                                                        | Repo                                                                       | Local checkout                                                                              | Deploy                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Agent service code                                          | `wolfstar-project/wolfstar-agent-kit` `packages/wolfstar-github-agent`     | `~/pkg/wolfstar-agent-kit`                                                                  | `pnpm service:hogwild:update` from the repo root                                                    |
| Agent context, worktrunk, env files                         | same repo, `scripts/`                                                      | same                                                                                        | `pnpm sync:context:hogwild`, `pnpm service:hogwild:sync-env`, `pnpm service:hogwild:sync-worktrunk` |
| Agent config                                                | not in git                                                                 | `hogwild:~/.config/wolfstar-github-agent/config.yml`                                        | edit, then request durable Restart                                                                  |
| Agent state                                                 | not in git                                                                 | `hogwild:~/.local/share/wolfstar-github-agent/state.sqlite`, `journal.sqlite`, `worktrees/` | back up before a migration                                                                          |
| Runner supervisor, runners.conf, Dockerfile, host hardening | `harlan-zw/hogwild-gh-runner` (private) `github-runner/`                   | `~/pkg/hogwild-gh-runner`                                                                   | install steps in its README                                                                         |
| Host security layout, Docker rules, pending items           | same repo, `hogwild/`                                                      | same                                                                                        | `hogwild/README.md`                                                                                 |
| Status site                                                 | `harlan-zw/hogwild.harlanzw.com`                                           | `~/pkg/hogwild.harlanzw.com`                                                                | GitHub Actions deploy job to `hogwild-deploy`                                                       |
| Caddy routes                                                | `scripts/30-agent.caddy` for the agent route; others live only on the host |                                                                                             | `sudo systemctl reload caddy`                                                                       |

A deploy reads `~/.config/wolfstar-github-agent/config.yml` with the new revision before it restarts anything. If the new revision rejects the file, the deploy stops and the running revision keeps serving. Run the same check by hand with `wolfstar-github-agent check-config --config <path>`.

The live `runners.conf` is `/var/lib/github-runner/config/runners.conf`. Change it in the repo first, then install it.

## Agent checkouts on the host

`wolfstar` holds a primary checkout for every repository the Agent works on. They live under `/home/wolfstar/pkg` and `/home/wolfstar/sites` and must stay clean on `main`. The Agent creates its worktrees under `~/.local/share/wolfstar-github-agent/worktrees/`.

Not every checkout is mapped. `config.yml` lists the active `repositories` and the observe-only `external_repositories`. Read the file for the current list: `ssh hogwild 'rg -n "^  - github:" ~/.config/wolfstar-github-agent/config.yml'`.

If a new repository joins, clone it as `wolfstar` into the matching directory, then add a `repositories` entry and request durable Restart.

## Email and browser identities

Before email work, read [email-usage](../email-usage/SKILL.md).
Before browser work, read [browser](../browser/SKILL.md).
Discover accounts on Hogwild. Its Himalaya configuration intentionally has no send backend.
Desktop Chrome profiles do not imply signed-in sessions on Hogwild.
Never copy desktop credentials or browser sessions to the server.

## Install a tool for the Agent

1. Install as admin: `ssh hogwild-admin 'sudo apt-get install -y <package>'`.
2. If the Agent needs it under a different name, link it as wolfstar: `ssh hogwild 'ln -sf "$(command -v fdfind)" ~/.local/bin/fd'`.
3. Record it in the tools table in `hogwild-gh-runner/hogwild/README.md`.

Tools in `hogwild:~/.local/bin` today: `node`, `pnpm`, `bun`, `uv`, `gh`, `wt`, `rg`, `fd`, `ripast`, `opencode`, `codex`, `wrangler`, `cf`, `sentry-cli`, `nuxtseo`, `himalaya`, `dev-browser`. No `claude`; the Agent uses `opencode`.

## Control the Agent

Prefer the control CLI from the desktop over raw `systemctl`:

```bash
wolfstar-github-agent control status
wolfstar-github-agent control pause
wolfstar-github-agent control restart
```

If a change needs the process to pick up new groups or a new Node, restart the user manager as admin. That kills in-flight Agent work, so pause first and get Wolfstar's say so:

```bash
ssh hogwild-admin 'sudo systemctl restart user@1000.service'
```

Use `hw logs agent -n 200` for unit logs.

The launcher reads the default configuration and password file.
Desktop reads `~/.config/wolfstar-github-agent/control-url`.
Context sync creates it with the Hogwild URL if missing.
It preserves an existing target. Hogwild uses loopback.
Explicit connection arguments win.
Use the Service Skill for [connection recovery and Review reads](../wolfstar-github-agent/SKILL.md).
For routine configuration changes, request durable Restart.
Never restart the user unit directly while Agents run.

## Docker and firewall

`ufw` allows SSH, DNS, and Jellyfin from the LAN, and everything on `tailscale0`. Docker bypasses ufw, so `hogwild-docker-user.service` fills `DOCKER-USER`: containers cannot reach the LAN, the tailnet, or link-local; the LAN cannot open published ports. `daemon.json` binds published ports to loopback. After `ufw reload`, restart Docker. Verify with `sudo iptables -S DOCKER-USER`.

## Do not

- Do not add `wolfstar` to `sudo` or `docker`.
- Do not edit a primary checkout under `~/pkg` or `~/sites` on the host. The Agent owns them.
- Do not reboot without draining the runner: `sudo systemctl stop hogwild-github-runner.service`, then `sudo reboot`.
