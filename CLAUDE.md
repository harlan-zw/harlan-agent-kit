# CLAUDE.md

Agent plugin for Nuxt/Vue/TypeScript workflows. No build step: bash hooks plus markdown skills.

## Commands

```bash
check              # Parallel lint + typecheck + test (installed to ~/.local/bin)
pnpm lint:fix      # ESLint autofix
pnpm check:context # Verify installed Agent instructions match agent-context/
pnpm sync:context # Install tracked Claude and Codex instructions, the commit-msg hook, and the opencode plugin
pnpm sync:context:hogwild # Install tracked instructions on Hogwild
pnpm test:opencode-hooks # Run the opencode plugin against the real hook scripts
pnpm release patch|minor|major  # Bump version, tag, push (syncs plugin.json, marketplace.json, skill frontmatter)
```

## Architecture

**Dual-directory layout**: the repo root holds workspace tooling (eslint, release script). The actual plugin lives in `harlan-agent-kit/`, nested so workspace tooling doesn't collide with the plugin manifest.

**Git hook** (`agent-context/git-hooks/commit-msg`): refuses a commit subject that is not Conventional Commits, under `~/pkg` and `~/sites` only. It also refuses a scope the repository's `GLOSSARY.md` retires in its `## Scopes` table, naming the replacement. That table lists retired spellings only, so a repository without one keeps every scope. `pnpm sync:context` installs it to `~/.config/git/hooks/` and points global `core.hooksPath` at that directory. It runs for every provider, because the GitHub agent workers use opencode or codex and never load a Claude Code plugin. A repository that sets `core.hooksPath` locally, through husky for example, overrides it.

**opencode parity** (`harlan-agent-kit/plugins/opencode/harlan-hooks.ts`): the same provider gap reaches the tool hooks below. This plugin runs the same bash scripts over the same stdin and stdout contract. It denies a tool call by throwing, which opencode turns into a tool error the model reads. It rewrites a command by mutating `output.args` in place, because opencode hands that same object to the tool. A hook that fails, times out, or is missing logs to stderr and allows the call. `pnpm sync:context` installs the scripts to `~/.local/share/harlan-agent-kit/hooks/` and the plugin to `~/.config/opencode/plugins/harlan-hooks.ts`, locally and on Hogwild.

**Hook lifecycle** (`harlan-agent-kit/hooks/`, wired in `.claude-plugin/plugin.json`):
- `SessionStart`: detect project type (Nuxt module/app, UnJS, Vue, Node), show git info, warn if not pnpm
- `PreToolUse` (Bash): block npm/yarn/npx (`pnpm-only.sh`); block raw `git worktree` mutation and `.claude/worktrees` paths (`wt-only.sh`); keep email read only (`himalaya-read-only.sh`); require the PR skill (`pr-skill-only.sh`); on `git commit` inject the commit-format rule (`pre-commit-push.sh`)
- `PostToolUse` (Write|Edit): eslint autofix on the edited file
- `PostToolUse` (Bash): append a `command-not-found.sh` install or BSD/GNU flag suggestion to the shell output, once per session per command

Adding or renaming a PreToolUse Bash hook means updating `commandHooks` in the opencode plugin and `opencode_hook_files` in `scripts/sync-agent-context.sh`. A PostToolUse Bash hook joins `opencode_hook_files` the same way; the plugin appends its `followup_message` suggestion to the shell tool output, because opencode has no followup-message contract.

**Email is read only** (`hooks/himalaya-read-only.sh`): an agent may read mail and must never change or send it. The hook allows a fixed read set and denies everything else, because a denylist would miss the next subcommand himalaya adds. Hogwild carries a second, stronger guarantee: its `~/.config/himalaya/config.toml` has no send backend at all, so a send fails there whatever the agent does.

**Disable hooks per-project**: `.claude/hooks.json` with `{"disabled": ["eslint", "pre-commit-push"]}`

**Worktrees**: `wt` (worktrunk) owns every worktree, at `<parent>/<repo>.<branch-slug>`. Full rules in `harlan-agent-kit/references/worktree-isolation.md`.

## Adding Components

**Hook**: `hooks/[name].sh`, registered in `plugin.json`. Source `check-config.sh` for disable support. Input arrives as stdin JSON (`tool_input.*`). Block with `{"decision":"block","reason":"..."}`. Continue (Stop only) with `{"decision":"followup_message","message":"..."}`.

**Skill**: `skills/[name]/SKILL.md` with frontmatter (`description`, `user_invocable: true`). Keep SKILL.md to the decision-making core and push procedures, long bash blocks, and rubrics into `references/`. Add `templates/` for files the skill scaffolds, and only reference files that exist: dangling reference links cost a wasted turn mid-task.

Install locally with `/plugin install /path/to/harlan-agent-kit`.
