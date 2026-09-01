<p align="center">
  <a href="https://github.com/harlan-zw/harlan-agent-kit">
    <img src=".github/banner.png" alt="harlan-agent-kit banner" width="100%">
  </a>
</p>

<h1>harlan-agent-kit</h1>

> 🤖 Personal agent plugin for Nuxt, Vue, and TypeScript workflows. Skills, hooks, and a local GitHub maintenance service.

Ships as a [Claude Code](https://claude.com/code) plugin. The nested plugin
directory also installs into Codex for its Skills.

<p align="center">
<table>
<tbody>
<td align="center">
<sub>Made possible by my <a href="https://github.com/sponsors/harlan-zw">Sponsor Program 💖</a><br> Follow me <a href="https://twitter.com/harlan_zw">@harlan_zw</a> 🐦 • Join <a href="https://discord.gg/275MBUBvgP">Discord</a> for help</sub><br>
</td>
</tbody>
</table>
</p>

> [!IMPORTANT]
> This is a personal plugin with opinionated defaults. Use it as inspiration, or fork it for your own setup.

## Features

- 🎨 **Nuxt and Vue workflows**: Design, review, and improve frontend work
- 🧠 **Architecture review**: Find deeper seams in Nuxt apps and TypeScript packages
- 📦 **Package conformance**: Sync package, module, test, and release conventions
- ✍️ **Delivery writing**: Draft PRs, release notes, tweets, and launch copy
- 📋 **Triage**: Rank [GitHub](https://github.com) issues, PRs, [Sentry](https://sentry.io) errors, and inboxes
- 🪝 **Hooks**: Enforce [pnpm](https://pnpm.io), lint changed files, block risky Git actions, show session context
- 🤖 **GitHub agent**: A local service that monitors owned repositories and works them autonomously

## Get Started

### Claude Code

```bash
/plugin marketplace add harlan-zw/harlan-agent-kit
/plugin install harlan-agent-kit
```

For local development:

```bash
/plugin install /path/to/harlan-agent-kit
```

### Codex

Codex installs the nested plugin directory at `harlan-agent-kit/`.

```bash
mkdir -p ~/.agents/plugins ~/plugins
ln -sfnT "$PWD/harlan-agent-kit" ~/plugins/harlan-agent-kit
codex plugin add harlan-agent-kit@personal
```

<details>
<summary><b>Personal marketplace config</b></summary>

Create `~/.agents/plugins/marketplace.json` if it does not exist:

```json
{
  "name": "personal",
  "interface": {
    "displayName": "Personal"
  },
  "plugins": [
    {
      "name": "harlan-agent-kit",
      "source": {
        "source": "local",
        "path": "./plugins/harlan-agent-kit"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

Validate before you reinstall:

```bash
claude plugin validate ~/plugins/harlan-agent-kit
jq empty ~/plugins/harlan-agent-kit/hooks/codex.json
codex plugin add harlan-agent-kit@personal
```

Start a new Codex thread after a reinstall so new Skills load.
</details>

## Skills

| Skill | Description |
|-------|-------------|
| `adversarial-review` | Review one PR adversarially, hand defects to Repair, publish the bot status |
| `agent-feedback` | Improve one Agent Skill from explicit Review feedback |
| `close-off` | Finish loose ends, verify delivery, clean task-owned Git state |
| `email-triage` | Triage inbox email with Himalaya |
| `glossary` | Create or audit `GLOSSARY.md` and catch vocabulary drift |
| `harlan-github-agent` | Manage or diagnose the local GitHub maintenance service |
| `humanize-writing` | Strip AI tells from prose before publishing |
| `improve-ts-pkg-architecture` | Find architecture improvements in TypeScript packages |
| `issue-triage` | Rank open issues by impact and difficulty |
| `nuxt-frontend-design` | Build and polish Nuxt UI v4+ pages and design systems |
| `nuxt-frontend-review` | Review a Nuxt frontend by running it and verifying its contract |
| `nuxt-improve-codebase-architecture` | Find Nuxt-native architecture improvements |
| `pkg-conform` | Conform or scaffold TypeScript packages and Nuxt modules |
| `plan-ceo` | Challenge product scope and strategy before implementation |
| `pr` | Create or update a pull request from current work |
| `pr-triage` | Repair, rank, and order the owned PR backlog |
| `release-notes` | Draft changelogs, release notes, and upgrade guides |
| `ripast` | Run AST-aware TypeScript, JavaScript, and Vue refactors |
| `sentry-checkin` | Triage and repair open Sentry issues with verified PRs |
| `social-presence` | Plan social content and launch posts |
| `take-ownership` | Own current work through merge, CI, deploy, and smoke checks |
| `ts-design-patterns` | Apply the Effect-inspired TypeScript design principles |
| `tweet` | Draft and polish tweets with visual direction |
| `unit-tests` | Write or review unit tests through exported behavior |

## Hooks

Claude Code loads hooks from `.claude-plugin/plugin.json`. Codex loads them from
`hooks/codex.json` through `.codex-plugin/plugin.json`.

| Event | Hook | Description |
|-------|------|-------------|
| SessionStart | `session-start.sh` | Detect project type, show Git status |
| PreToolUse | `merged-branch-guard.sh` | Block commits on merged branches |
| PreToolUse | `pnpm-only.sh` | Block [npm](https://npmjs.com) and yarn commands |
| PreToolUse | `pr-skill-only.sh` | Require the `pr` Skill for PR creation and description edits |
| PreToolUse | `wt-only.sh` | Keep worktrees owned by `wt` |
| PreToolUse | `pre-commit-push.sh` | Run lint, typecheck, and test before commit or push |
| PostToolUse | `eslint.sh` | Autofix lint on changed files |
| PostToolUse | `command-not-found.sh` | Recover from a missing shell command |
| Manual | `check.sh` | Run the configured project checks |
| Manual | `check-config.sh` | Inspect hook and check configuration |

## GitHub Agent

`packages/harlan-github-agent` is a local service. It monitors owned
repositories, runs Agents against issues and pull requests, and reports through
a dashboard. Ask Claude for the `harlan-github-agent` Skill to operate it.

```bash
pnpm service:status    # Show service state
pnpm service:update    # Rebuild and restart
```

## Configuration

Disable hooks for one project with `.claude/hooks.json`:

```json
{
  "disabled": ["eslint", "pre-commit-push"]
}
```

## Development

```bash
pnpm install
check                 # Parallel lint, typecheck, and test
pnpm lint:fix         # ESLint autofix
pnpm check:context    # Verify the shared agent context has not drifted
pnpm release patch    # Bump version, tag, and push
```

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg'/>
  </a>
</p>

## License

MIT License © 2024-PRESENT [Harlan Wilton](https://github.com/harlan-zw)
