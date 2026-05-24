<p align="center">
  <a href="https://github.com/harlan-zw/harlan-agent-kit">
    <img src=".github/banner.png" alt="harlan-agent-kit banner" width="100%">
  </a>
</p>

# harlan-agent-kit

Personal agent plugin for Nuxt/Vue/TypeScript workflows. It ships as a
[Claude Code](https://claude.com/code) plugin and can also be installed locally
as a Codex plugin for its skills.

> [!IMPORTANT]
> This is a personal plugin with opinionated defaults. Use as inspiration or fork for your own setup.

## Features

- **Nuxt/Vue workflows** - Design, review, and improve frontend implementation
- **Architecture review** - Find deeper seams in Nuxt apps and TypeScript packages
- **Package conformance** - Sync package, module, test, and release conventions
- **PR and release writing** - Draft PRs, release notes, tweets, and launch copy
- **Issue and email triage** - Rank GitHub issues and process inboxes
- **Claude hooks** - Enforce pnpm, lint changed files, block risky git actions, and show session context

## Quick Start

### Claude Code

```bash
/plugin marketplace add harlan-zw/harlan-agent-kit
/plugin install harlan-agent-kit
```

### Codex

Codex support uses the nested plugin directory at `harlan-agent-kit/`.

For local development, expose that directory under `~/plugins` and install from
the personal marketplace:

```bash
mkdir -p ~/.agents/plugins ~/plugins
ln -sfnT /home/harlan/pkg/harlan-agent-kit/harlan-agent-kit ~/plugins/harlan-agent-kit
```

Create `~/.agents/plugins/marketplace.json` if it does not already exist:

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

Then install:

```bash
codex plugin add harlan-agent-kit@personal
```

Validate before reinstalling:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py ~/plugins/harlan-agent-kit
codex plugin add harlan-agent-kit@personal
```

Start a new Codex thread after reinstalling so newly installed skills are loaded.

## Hooks

Claude Code loads hooks from `.claude-plugin/plugin.json`. Codex currently uses
the skills only; the Claude hook config is not portable to Codex as-is.

| Event | Hook | Description |
|-------|------|-------------|
| SessionStart | `session-start.sh` | Detect project type, show git status |
| PreToolUse | `merged-branch-guard.sh` | Block commits on merged branches |
| PreToolUse | `pnpm-only.sh` | Block npm/yarn commands |
| PreToolUse | `pre-commit-push.sh` | Run lint/typecheck/test before commit/push |
| PostToolUse | `eslint.sh` | Auto-lint + fix after file changes |
| PostToolUse | `command-not-found.sh` | Help recover from missing shell commands |
| Manual | `check.sh` | Run configured project checks |
| Manual | `check-config.sh` | Inspect hook/check configuration |

## Skills

| Skill | Description |
|-------|-------------|
| `email-triage` | Triage inbox email with himalaya |
| `improve-ts-pkg-architecture` | Find architecture improvements in TS packages and monorepos |
| `issue-triage` | Rank open issues by difficulty and impact |
| `nuxt-frontend-design` | Build and polish Nuxt UI v4+ frontend work |
| `nuxt-frontend-review` | Adversarially review frontend work against a build contract |
| `nuxt-improve-codebase-architecture` | Find Nuxt-native architecture improvements |
| `pkg-conform` | Conform or scaffold npm package and Nuxt module architecture |
| `plan-ceo` | Produce CEO-level planning artifacts |
| `pr` | Create, update, or sync pull requests |
| `release-notes` | Draft changelogs, release notes, and upgrade guidance |
| `ripast` | Perform AST-aware TS/JS/Vue refactors |
| `social-presence` | Plan social content and launch posts |
| `tweet` | Draft and polish tweets with visual direction |

## Configuration

Disable specific hooks per-project by creating `.claude/hooks.json`:

```json
{
  "disabled": ["eslint", "pre-commit-push"]
}
```

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-agent-kit/blob/main/LICENSE).
