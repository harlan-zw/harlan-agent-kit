<p align="center">
  <a href="https://github.com/harlan-zw/harlan-agent-kit">
    <img src=".github/banner.png" alt="harlan-agent-kit banner" width="100%">
  </a>
</p>

<h1>harlan-agent-kit</h1>

> 🤖 My agent kit for Nuxt and TypeScript work. 24 Skills, 8 hooks, and a service that works my [GitHub](https://github.com) repos on its own.

It installs as a [Claude Code](https://claude.com/code) plugin. Codex reads the
same directory and picks up the Skills.

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
> These are my defaults, not general advice. Fork it and change what you disagree with.

## Features

- 🎨 **Nuxt frontends**: Build on Nuxt UI v4+, then review the result by running it, not by reading it
- 🧠 **Architecture review**: Separate rubrics for a Nuxt app and a plain TypeScript package
- 📦 **Package conformance**: One pass over workspace catalogs, [ESLint](https://eslint.org), [Vitest](https://vitest.dev), CI, and playgrounds
- ✍️ **Writing**: PRs, changelogs, tweets. Plus a pass that strips the AI tells back out
- 📋 **Triage**: Issues, the PR backlog, [Sentry](https://sentry.io), and the inbox
- 🪝 **Hooks**: [pnpm](https://pnpm.io) only. Lint on save. Checks before every push
- 🤖 **GitHub agent**: A local service that opens the work on issues and PRs while I do something else

## How I use it

My main checkout stays clean, I never work in it. Every task gets its own worktree with [worktrunk](https://github.com/max-sixty/worktrunk). The agent works in there and it can't commit or push until [`check`](./bin/check) passes, so lint, typecheck and tests. Then the [`pr` Skill](./harlan-agent-kit/skills/pr/SKILL.md) opens the PR. The [hooks](./harlan-agent-kit/hooks) block the command if any of that gets skipped, which is good, because I skip things when I'm tired.

The other part runs on its own. I've got [a service](./packages/harlan-github-agent/README.md) on my machine that checks my repos, finds an issue or a PR that's been sitting there, and gives it to [Codex](https://developers.openai.com/codex/sdk/) or [opencode](https://opencode.ai). It reviews the thing but [can't touch the code](./harlan-agent-kit/skills/adversarial-review/SKILL.md). If it finds something real, a second agent does the fix, then the whole thing gets reviewed again. I don't want the same agent marking its own homework.

The bit I still have to do is read all of it. That's the slow part, not the agents. So I make them show me something first: a test that was failing and now passes, a typecheck, or for frontend work [the page running in a browser](./harlan-agent-kit/skills/nuxt-frontend-review/SKILL.md). [Small stuff like dependency bumps](./harlan-agent-kit/references/auto-merge.md) merges without me. If there's a real decision in it, it waits.

## Get Started

### Claude Code

```bash
/plugin marketplace add harlan-zw/harlan-agent-kit
/plugin install harlan-agent-kit
```

Install a local checkout instead when you are changing the plugin:

```bash
/plugin install /path/to/harlan-agent-kit
```

### Codex

Codex installs the nested plugin directory, [`harlan-agent-kit/`](./harlan-agent-kit).

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

Start a new Codex thread after a reinstall, otherwise the new Skills stay unloaded.
</details>

## Skills

Every Skill lives in [`harlan-agent-kit/skills/`](./harlan-agent-kit/skills).

| Skill | Description |
|-------|-------------|
| [`artifact`](./harlan-agent-kit/skills/artifact/SKILL.md) | Publish one self-contained HTML Artifact from Claude Code or Codex |
| [`adversarial-review`](./harlan-agent-kit/skills/adversarial-review/SKILL.md) | Review one PR adversarially, hand defects to Repair, publish the bot status |
| [`agent-feedback`](./harlan-agent-kit/skills/agent-feedback/SKILL.md) | Improve one Agent Skill from explicit Review feedback |
| [`close-off`](./harlan-agent-kit/skills/close-off/SKILL.md) | Finish loose ends, verify delivery, clean task-owned Git state |
| [`email-triage`](./harlan-agent-kit/skills/email-triage/SKILL.md) | Triage inbox email with [Himalaya](https://github.com/pimalaya/himalaya) |
| [`glossary`](./harlan-agent-kit/skills/glossary/SKILL.md) | Create or audit `GLOSSARY.md` and catch vocabulary drift |
| [`harlan-github-agent`](./harlan-agent-kit/skills/harlan-github-agent/SKILL.md) | Drive or diagnose the local GitHub service |
| [`humanize-writing`](./harlan-agent-kit/skills/humanize-writing/SKILL.md) | Strip AI tells from prose before it goes out |
| [`improve-ts-pkg-architecture`](./harlan-agent-kit/skills/improve-ts-pkg-architecture/SKILL.md) | Find architecture improvements in a TypeScript package |
| [`issue-triage`](./harlan-agent-kit/skills/issue-triage/SKILL.md) | Rank open issues by impact and difficulty |
| [`nuxt-frontend-design`](./harlan-agent-kit/skills/nuxt-frontend-design/SKILL.md) | Build and polish Nuxt UI v4+ pages and design systems |
| [`nuxt-frontend-review`](./harlan-agent-kit/skills/nuxt-frontend-review/SKILL.md) | Run a Nuxt frontend and check it against its contract |
| [`nuxt-improve-codebase-architecture`](./harlan-agent-kit/skills/nuxt-improve-codebase-architecture/SKILL.md) | Find Nuxt-native architecture improvements |
| [`pkg-conform`](./harlan-agent-kit/skills/pkg-conform/SKILL.md) | Conform or scaffold a TypeScript package or Nuxt module |
| [`plan-ceo`](./harlan-agent-kit/skills/plan-ceo/SKILL.md) | Challenge scope and strategy before anyone writes code |
| [`pr`](./harlan-agent-kit/skills/pr/SKILL.md) | Create or update a pull request from current work |
| [`pr-triage`](./harlan-agent-kit/skills/pr-triage/SKILL.md) | Repair, rank, and order the owned PR backlog |
| [`release-notes`](./harlan-agent-kit/skills/release-notes/SKILL.md) | Draft changelogs, release notes, and upgrade guides |
| [`ripast`](./harlan-agent-kit/skills/ripast/SKILL.md) | Run AST-aware refactors with [Ripast](https://github.com/harlan-zw/ripast) |
| [`sentry-checkin`](./harlan-agent-kit/skills/sentry-checkin/SKILL.md) | Triage open Sentry issues and repair them with verified PRs |
| [`social-presence`](./harlan-agent-kit/skills/social-presence/SKILL.md) | Plan social content and launch posts |
| [`take-ownership`](./harlan-agent-kit/skills/take-ownership/SKILL.md) | Own current work through merge, CI, deploy, and smoke checks |
| [`ts-design-patterns`](./harlan-agent-kit/skills/ts-design-patterns/SKILL.md) | Apply the Effect-inspired TypeScript design principles |
| [`tweet`](./harlan-agent-kit/skills/tweet/SKILL.md) | Draft and polish tweets with visual direction |
| [`unit-tests`](./harlan-agent-kit/skills/unit-tests/SKILL.md) | Write or review unit tests through exported behavior |

## Hooks

Claude Code reads the hooks from [`.claude-plugin/plugin.json`](./harlan-agent-kit/.claude-plugin/plugin.json).
Codex reads [`hooks/codex.json`](./harlan-agent-kit/hooks/codex.json) through
[`.codex-plugin/plugin.json`](./harlan-agent-kit/.codex-plugin/plugin.json).

| Event | Hook | Description |
|-------|------|-------------|
| SessionStart | [`session-start.sh`](./harlan-agent-kit/hooks/session-start.sh) | Detect the project type, print the Git state |
| PreToolUse (Bash) | [`pnpm-only.sh`](./harlan-agent-kit/hooks/pnpm-only.sh) | Block [npm](https://npmjs.com), yarn, and npx |
| PreToolUse (Bash) | [`wt-only.sh`](./harlan-agent-kit/hooks/wt-only.sh) | Keep every worktree owned by `wt` |
| PreToolUse (Bash) | [`pr-skill-only.sh`](./harlan-agent-kit/hooks/pr-skill-only.sh) | Require the `pr` Skill to open a PR or edit its description |
| PreToolUse (Bash) | [`merged-branch-guard.sh`](./harlan-agent-kit/hooks/merged-branch-guard.sh) | Block commits on an already merged branch |
| PreToolUse (Bash) | [`pre-commit-push.sh`](./harlan-agent-kit/hooks/pre-commit-push.sh) | Run `check` before a commit, push, or PR |
| PostToolUse (Write, Edit) | [`eslint.sh`](./harlan-agent-kit/hooks/eslint.sh) | Autofix lint on the file that changed |
| PostToolUse (Bash) | [`command-not-found.sh`](./harlan-agent-kit/hooks/command-not-found.sh) | Recover from a missing shell command |

Two more scripts run outside the hook events:
[`check.sh`](./harlan-agent-kit/hooks/check.sh) runs the configured project
checks, and [`check-config.sh`](./harlan-agent-kit/hooks/check-config.sh) reads
the per-project config the others source.

Turn a hook off for one project with `.claude/hooks.json`:

```json
{
  "disabled": ["eslint", "pre-commit-push"]
}
```

## GitHub Agent

[`packages/harlan-github-agent`](./packages/harlan-github-agent/README.md) is a
local service. It watches my repositories, runs Agents on the issues and pull
requests it finds, and shows the result on a dashboard. Reviews are read only,
and every material finding goes to a fresh Repair Agent, so nothing merges on
the reviewer's own word.

```bash
pnpm service:status    # Show the service state
pnpm service:update    # Rebuild and restart
```

## Reference

The Skills defer to these when the rules get long:

- [Worktree isolation](./harlan-agent-kit/references/worktree-isolation.md), how `wt` owns every worktree
- [Auto-merge](./harlan-agent-kit/references/auto-merge.md), what the agent may merge without me
- [Code comments](./harlan-agent-kit/references/code-comments.md), when a comment earns its line

Design notes for the service live in [`docs/plans/`](./docs/plans).

## Development

No build step for the plugin itself: [bash hooks](./harlan-agent-kit/hooks) plus
[markdown Skills](./harlan-agent-kit/skills). The service in `packages/` does
build.

```bash
pnpm install
check                 # Parallel lint, typecheck, and test
pnpm lint:fix         # ESLint autofix
pnpm check:context    # Check the shared agent context for drift
pnpm release patch    # Bump the version, tag it, push it
```

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg'/>
  </a>
</p>

## License

Licensed under the [MIT license](./LICENSE.md).
