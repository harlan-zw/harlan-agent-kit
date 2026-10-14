<p align="center">
  <a href="https://github.com/wolfstar-project/wolfstar-agent-kit">
    <img src=".github/banner.png" alt="wolfstar-agent-kit banner" width="100%">
  </a>
</p>

<h1>wolfstar-agent-kit</h1>

> 🤖 Wolfstar Project's agent kit for Nuxt and TypeScript work. 38 Skills, 8 hooks, and a service that works on [GitHub](https://github.com) repositories autonomously.

It installs as a [Claude Code](https://claude.com/code) plugin. Codex reads the
same directory and picks up the Skills.

Maintained by [Wolfstar Project](https://github.com/wolfstar-project). Contact: [contact@wolfstar.rocks](mailto:contact@wolfstar.rocks).

> [!IMPORTANT]
> These are Wolfstar Project's defaults, not general advice. Fork the project and adapt them to your needs.

## Features

- 🎨 **Nuxt frontends**: Build on Nuxt UI v4+, then review the result by running it, not by reading it
- 🧠 **Architecture review**: Separate rubrics for a Nuxt app and a plain TypeScript package
- 📦 **Package conformance**: One pass over workspace catalogs, [Oxlint](https://oxc.rs/docs/guide/usage/linter.html), [Oxfmt](https://oxc.rs/docs/guide/usage/formatter.html), [Vitest](https://vitest.dev), CI, and playgrounds
- ✍️ **Writing**: PRs, changelogs, tweets. Plus a pass that strips the AI tells back out
- 📋 **Triage**: Issues, the PR backlog, [Sentry](https://sentry.io), and the inbox
- 🪝 **Hooks**: [pnpm](https://pnpm.io) only. Lint on save. Checks before every push
- 🤖 **GitHub agent**: A local service that opens the work on issues and PRs while I do something else

## How I use it

My main checkout stays clean, I never work in it. Every task gets its own worktree with [worktrunk](https://github.com/max-sixty/worktrunk). The agent works in there and it can't commit or push until [`check`](./bin/check) passes, so lint, typecheck and tests. Then the [`pr` Skill](./wolfstar-agent-kit/skills/pr/SKILL.md) opens the PR. The [hooks](./wolfstar-agent-kit/hooks) block the command if any of that gets skipped, which is good, because I skip things when I'm tired.

The other part runs on its own. [The service](./packages/wolfstar-github-agent/README.md) checks configured repositories, finds an issue or pull request that has been waiting, and gives it to [Claude](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://developers.openai.com/codex/sdk/), or [opencode](https://opencode.ai). It reviews the change but [can't touch the code](./wolfstar-agent-kit/skills/adversarial-review/SKILL.md). If it finds something real, a second agent does the fix, then the whole thing gets reviewed again.

The bit I still have to do is read all of it. That's the slow part, not the agents. So I make them show me something first: a test that was failing and now passes, a typecheck, or for frontend work [the page running in a browser](./wolfstar-agent-kit/skills/nuxt-frontend-review/SKILL.md). [Small stuff like dependency bumps](./wolfstar-agent-kit/references/auto-merge.md) merges without me. If there's a real decision in it, it waits.

## Get Started

### Claude Code

```bash
/plugin marketplace add wolfstar-project/wolfstar-agent-kit
/plugin install wolfstar-agent-kit
```

Install a local checkout instead when you are changing the plugin:

```bash
/plugin install /path/to/wolfstar-agent-kit
```

### Codex

Codex installs the nested plugin directory, [`wolfstar-agent-kit/`](./wolfstar-agent-kit).

```bash
mkdir -p ~/.agents/plugins ~/plugins
ln -sfnT "$PWD/wolfstar-agent-kit" ~/plugins/wolfstar-agent-kit
codex plugin add wolfstar-agent-kit@personal
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
      "name": "wolfstar-agent-kit",
      "source": {
        "source": "local",
        "path": "./plugins/wolfstar-agent-kit"
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
claude plugin validate ~/plugins/wolfstar-agent-kit
jq empty ~/plugins/wolfstar-agent-kit/hooks/codex.json
codex plugin add wolfstar-agent-kit@personal
```

Start a new Codex thread after a reinstall, otherwise the new Skills stay unloaded.
</details>

## Skills

Every Skill lives in [`wolfstar-agent-kit/skills/`](./wolfstar-agent-kit/skills).

| Skill                                                                                                           | Description                                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [`adversarial-review`](./wolfstar-agent-kit/skills/adversarial-review/SKILL.md)                                 | Review one PR adversarially, hand defects to Repair, publish the bot status                                    |
| [`agent-feedback`](./wolfstar-agent-kit/skills/agent-feedback/SKILL.md)                                         | Improve one Agent Skill from explicit Review feedback                                                          |
| [`brand-lab`](./wolfstar-agent-kit/skills/brand-lab/SKILL.md)                                                   | Compare brand directions for a logo and UI motifs on one private page                                          |
| [`browser`](./wolfstar-agent-kit/skills/browser/SKILL.md)                                                       | Select Chrome identities, use prompt-free debugging, and clean up task tabs                                    |
| [`ci-review`](./wolfstar-agent-kit/skills/ci-review/SKILL.md)                                                   | Review CI warnings and errors, then propose verified repairs                                                   |
| [`close-off`](./wolfstar-agent-kit/skills/close-off/SKILL.md)                                                   | Finish loose ends, verify delivery, clean task-owned Git state                                                 |
| [`content-refresh`](./wolfstar-agent-kit/skills/content-refresh/SKILL.md)                                       | Refresh articles through verified sources, reviewed briefs, screenshots, and publication checks                |
| [`copywriting`](./wolfstar-agent-kit/skills/copywriting/SKILL.md)                                               | Create or audit `COPY.md` for voice and canonical wording                                                      |
| [`daily-checkin`](./wolfstar-agent-kit/skills/daily-checkin/SKILL.md)                                           | Run nuxt-checkin and interpret site prompt items                                                               |
| [`dependency-updates`](./wolfstar-agent-kit/skills/dependency-updates/SKILL.md)                                 | Attempt weekly dependency updates, including majors, in one pull request                                       |
| [`email-triage`](./wolfstar-agent-kit/skills/email-triage/SKILL.md)                                             | Review inbox email with [Himalaya](https://github.com/pimalaya/himalaya) and propose actions                   |
| [`email-usage`](./wolfstar-agent-kit/skills/email-usage/SKILL.md)                                               | Choose email addresses, Himalaya accounts, and mail permissions                                                |
| [`glossary`](./wolfstar-agent-kit/skills/glossary/SKILL.md)                                                     | Create or audit `GLOSSARY.md` and catch vocabulary drift                                                       |
| [`humanize-writing`](./wolfstar-agent-kit/skills/humanize-writing/SKILL.md)                                     | Strip AI tells from prose before it goes out                                                                   |
| [`i-dont-know-just-keep-working`](./wolfstar-agent-kit/skills/i-dont-know-just-keep-working/SKILL.md)           | Find related gaps, bugs, and improvements, then rank next steps by impact, effort, and confidence              |
| [`improve-ts-pkg-architecture`](./wolfstar-agent-kit/skills/improve-ts-pkg-architecture/SKILL.md)               | Find architecture improvements in a TypeScript package                                                         |
| [`issue-triage`](./wolfstar-agent-kit/skills/issue-triage/SKILL.md)                                             | Rank open issues by impact and difficulty                                                                      |
| [`nuxt-4-minors-migration`](./wolfstar-agent-kit/skills/nuxt-4-minors-migration/SKILL.md)                       | Move a Nuxt 4 site to the latest 4.x release with compatibility version 5, and migrate what the minors changed |
| [`nuxt-frontend-design`](./wolfstar-agent-kit/skills/nuxt-frontend-design/SKILL.md)                             | Build and polish Nuxt UI v4+ pages and design systems                                                          |
| [`nuxt-frontend-review`](./wolfstar-agent-kit/skills/nuxt-frontend-review/SKILL.md)                             | Run a Nuxt frontend and check it against its contract                                                          |
| [`nuxt-improve-codebase-architecture`](./wolfstar-agent-kit/skills/nuxt-improve-codebase-architecture/SKILL.md) | Find Nuxt-native architecture improvements                                                                     |
| [`pkg-conform`](./wolfstar-agent-kit/skills/pkg-conform/SKILL.md)                                               | Conform or scaffold a TypeScript package or Nuxt module                                                        |
| [`plan-ceo`](./wolfstar-agent-kit/skills/plan-ceo/SKILL.md)                                                     | Challenge scope and strategy before anyone writes code                                                         |
| [`pr`](./wolfstar-agent-kit/skills/pr/SKILL.md)                                                                 | Create or update a pull request from current work                                                              |
| [`pr-lens`](./wolfstar-agent-kit/skills/pr-lens/SKILL.md)                                                       | Draw a change as animated architecture and data-flow diagrams with [PR Lens](https://prlens.dev)               |
| [`pr-triage`](./wolfstar-agent-kit/skills/pr-triage/SKILL.md)                                                   | Repair, rank, and order the owned PR backlog                                                                   |
| [`release-notes`](./wolfstar-agent-kit/skills/release-notes/SKILL.md)                                           | Draft changelogs, release notes, and upgrade guides                                                            |
| [`ripast`](./wolfstar-agent-kit/skills/ripast/SKILL.md)                                                         | Run AST-aware refactors with [Ripast](https://github.com/wolfstar-project/ripast)                              |
| [`sentry-checkin`](./wolfstar-agent-kit/skills/sentry-checkin/SKILL.md)                                         | Triage open Sentry issues and repair them with verified PRs                                                    |
| [`seo-review`](./wolfstar-agent-kit/skills/seo-review/SKILL.md)                                                 | Triage a Site's NuxtSEO actions and repair the ones the code owns                                              |
| [`social-presence`](./wolfstar-agent-kit/skills/social-presence/SKILL.md)                                       | Plan social content and launch posts                                                                           |
| [`take-ownership`](./wolfstar-agent-kit/skills/take-ownership/SKILL.md)                                         | Finish delivery, reconcile loose ends, and clean task-owned Git state                                          |
| [`ts-design-patterns`](./wolfstar-agent-kit/skills/ts-design-patterns/SKILL.md)                                 | Apply the Effect-inspired TypeScript design principles                                                         |
| [`tweet`](./wolfstar-agent-kit/skills/tweet/SKILL.md)                                                           | Find tweet ideas, plan launch posts, and draft tweets with visuals                                             |
| [`unit-tests`](./wolfstar-agent-kit/skills/unit-tests/SKILL.md)                                                 | Write or review unit tests through exported behavior                                                           |
| [`vitals-review`](./wolfstar-agent-kit/skills/vitals-review/SKILL.md)                                           | File a Site's poor field vitals and persistent lab drops from NuxtSEO, then repair them                        |
| [`wolfstar-announcements`](./wolfstar-agent-kit/skills/wolfstar-announcements/SKILL.md)                         | Write release, stage, and hotfix announcements for Discord and the website                                     |
| [`wolfstar-github-agent`](./wolfstar-agent-kit/skills/wolfstar-github-agent/SKILL.md)                           | Drive or diagnose the local GitHub service                                                                     |

## Hooks

Claude Code reads the hooks from [`.claude-plugin/plugin.json`](./wolfstar-agent-kit/.claude-plugin/plugin.json).
That manifest is the only place a hook is registered. The install script, the drift
check, and the opencode plugin all derive their lists from it.
Codex reads [`hooks/codex.json`](./wolfstar-agent-kit/hooks/codex.json) through
[`.codex-plugin/plugin.json`](./wolfstar-agent-kit/.codex-plugin/plugin.json).

| Event                     | Hook                                                                          | Description                                                 |
| ------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| SessionStart              | [`session-start.sh`](./wolfstar-agent-kit/hooks/session-start.sh)             | Detect the project type, print the Git state                |
| PreToolUse (Bash)         | [`pnpm-only.sh`](./wolfstar-agent-kit/hooks/pnpm-only.sh)                     | Block [npm](https://npmjs.com), yarn, and npx               |
| PreToolUse (Bash)         | [`wt-only.sh`](./wolfstar-agent-kit/hooks/wt-only.sh)                         | Keep every worktree owned by `wt`                           |
| PreToolUse (Bash)         | [`himalaya-read-only.sh`](./wolfstar-agent-kit/hooks/himalaya-read-only.sh)   | Keep every agent's email access read only                   |
| PreToolUse (Bash)         | [`pr-skill-only.sh`](./wolfstar-agent-kit/hooks/pr-skill-only.sh)             | Require the `pr` Skill to open a PR or edit its description |
| PreToolUse (Bash)         | [`merged-branch-guard.sh`](./wolfstar-agent-kit/hooks/merged-branch-guard.sh) | Block commits on an already merged branch                   |
| PreToolUse (Bash)         | [`pre-commit-push.sh`](./wolfstar-agent-kit/hooks/pre-commit-push.sh)         | Run `check` before a commit, push, or PR                    |
| PostToolUse (Write, Edit) | [`oxlint.sh`](./wolfstar-agent-kit/hooks/oxlint.sh)                           | Autofix lint and format the file that changed               |
| PostToolUse (Bash)        | [`command-not-found.sh`](./wolfstar-agent-kit/hooks/command-not-found.sh)     | Recover from a missing shell command                        |

Two more scripts run outside the hook events:
[`check.sh`](./wolfstar-agent-kit/hooks/check.sh) runs the configured project
checks, and [`check-config.sh`](./wolfstar-agent-kit/hooks/check-config.sh) reads
the per-project config the others source.

Turn a hook off for one project with `.claude/hooks.json`:

```json
{
  "disabled": ["oxlint", "oxfmt", "pre-commit-push"]
}
```

## GitHub Agent

[`packages/wolfstar-github-agent`](./packages/wolfstar-github-agent/README.md) is a
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

- [Worktree isolation](./wolfstar-agent-kit/references/worktree-isolation.md), how `wt` owns every worktree
- [Auto-merge](./wolfstar-agent-kit/references/auto-merge.md), what the agent may merge without me
- [Code comments](./wolfstar-agent-kit/references/code-comments.md), when a comment earns its line

Design notes for the service live in [`docs/plans/`](./docs/plans).

## Development

No build step for the plugin itself: [bash hooks](./wolfstar-agent-kit/hooks) plus
[markdown Skills](./wolfstar-agent-kit/skills). The service in `packages/` does
build.

```bash
pnpm install
check                 # Parallel lint, typecheck, and test
pnpm lint:fix         # Oxlint autofix + Oxfmt
pnpm check:context    # Check the shared agent context for drift
pnpm release patch    # Bump the version, tag it, push it
```

## License

Licensed under the [MIT license](./LICENSE.md).
