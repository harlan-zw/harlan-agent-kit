---
name: wolfstar-github-agent
description: "Manage or diagnose Wolfstar's local GitHub maintenance service. Use for repository monitoring, automated issue or PR work, agent activity, conflicts, and its dashboard."
license: MIT
---

# Wolfstar GitHub Agent

Use the installed CLI to inspect and control the durable Service.
Keep scheduling in the Service.

## Connect

Context sync installs the CLI for noninteractive shells on both hosts.
Run `pnpm sync:context` locally and `pnpm sync:context:hogwild` for Hogwild.
Service updates also install it.

Desktop:

```bash
wolfstar-github-agent control status
```

Hogwild from desktop:

```bash
hw run agent 'wolfstar-github-agent control status'
```

The launcher resolves the Service checkout and its pinned Node runtime.
It uses `~/.config/wolfstar-github-agent/config.yml` by default.
It reads `dashboard-password` beside that file.
Desktop reads `~/.config/wolfstar-github-agent/control-url`.
Context sync creates it with the Hogwild URL if missing.
It preserves an existing target.
Hogwild uses `http://127.0.0.1:3210`.
Explicit `--config`, `--url`, and `--password-file` arguments win.
A desktop `--config` override reads that file's Service URL unless `--url` is also set.
Use `WOLFSTAR_GITHUB_AGENT_URL` to override the installed desktop target.
Never print credentials or place their values in saved commands.

If the launcher is missing, use this source command once:

```bash
ssh hogwild 'cd ~/.local/share/wolfstar-github-agent/service && ~/.local/lib/wolfstar-github-agent/node --experimental-strip-types packages/wolfstar-github-agent/src/cli.ts control status --config ~/.config/wolfstar-github-agent/config.yml --url http://127.0.0.1:3210'
```

Then restore the launcher through context sync.
Do not guess a built CLI path inside `dist/`.
Installed Plugin caches contain Skills, rather than the Service package.
The Service checkout lives at `~/.local/share/wolfstar-github-agent/service`.
Use `WOLFSTAR_GITHUB_AGENT_CHECKOUT` for an explicit checkout override.

## Read Service state

```bash
wolfstar-github-agent control tasks
wolfstar-github-agent control incidents
wolfstar-github-agent control activity --task TASK_ID
wolfstar-github-agent control events --limit 50
wolfstar-github-agent control reviews --repository OWNER/REPOSITORY --number NUMBER
wolfstar-github-agent control reviews --repository OWNER/REPOSITORY --number NUMBER --head FULL_HEAD_SHA
```

Commands print one JSON value. Tagged errors exit with status 1.
`status` returns `{ health, state }`.
`reviews` returns `{ runs }`, preserving findings and gates.
The head filter requires all 40 characters.
An empty `runs` array means no stored Review matches that query.
It does not mean Review passed.

Use `watch-pr` to wait through authenticated Service events.

```bash
wolfstar-github-agent control watch-pr --repository OWNER/REPOSITORY --number NUMBER --until review --timeout-seconds 600
```

Use `--until merged` to wait through actionable findings.
The default stops for attention after Service Tasks stop owning the head.
Changed states go to stderr. Terminal state goes to stdout.
Reconnect with the same command after a Service restart.
Follow [pull request watching](../pr/references/pull-request-watch.md) for submission completion.

## Control the Service

Use `pause`, `resume`, `restart`, `update`, or `cancel --task TASK_ID` for the matching durable control.
Use `routine-run --routine OWNER/REPOSITORY:NAME` to open a run ahead of its cron.
Use `stop-review --repository OWNER/REPOSITORY --number NUMBER --head HEAD_SHA` to stop that exact Review.

After configuration changes, use a durable Restart request.
It lets active Agents and controller writes finish before systemd starts the next process.
Never use Pause or raw unit restart to coordinate a routine restart.
For paired Service updates, run `pnpm service:hogwild:update`.
The helper holds one local lock through the desktop update.
Another update or restart on that host fails before it reaches the Service.
During drain, the helper reports active Tasks, occupied Agent slots, and elapsed seconds.
It reports changed counts and a heartbeat every 30 seconds.
After desktop restart, it requires a fresh report with the current protocol.
If that check fails, inspect the desktop unit and Service connection.
Its durable Update blocks new Tasks before file sync.
The helper marks preparation Ready after sync, then waits for existing work.
Failed preparation releases its hold without changing manual Pause.
If the Service lacks preparation support, use its installed desktop helper first:
`bash ~/.local/share/wolfstar-github-agent/service/scripts/hogwild-service.sh update`.
After that upgrade, use the current repository helper.
Use `reload-external-watches` only for external watches and their issue cutoff.
Other configuration changes require Restart.

Call the Control API directly only when no matching CLI subcommand exists.
Its Basic-auth username is `agent`.
Read API response contracts before extracting fields.
For the Review endpoint, the array lives at `.runs`.

## Authority and deeper contracts

Read [Hogwild](../hogwild/SKILL.md) before host work.
For daily check-ins, use [daily-checkin](../daily-checkin/SKILL.md).
For Codex or OpenCode session audits, use [agent-retro](../agent-retro/SKILL.md).

Read [the controller contract](references/controller-contract.md) before changing Service policy, dispatch, configuration, or publication.
It owns repository eligibility, Approval, Review, Repair, releases, and conflict resolution.

Workers may edit only their assigned worktrees when authorized.
Workers never change GitHub state or Service-owned SQLite data.
The Controller owns credentials and every GitHub write.
Never approve a pull request.
Keep primary checkouts read only.

Report Service state, active subjects, active Tasks, and exact blockers.
Claim work started only when the Journal records it.
