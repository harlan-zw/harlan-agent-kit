# CLAUDE.md

Agent plugin for Nuxt/Vue/TypeScript workflows. No build step: bash hooks plus markdown skills.

## Commands

```bash
check              # Parallel lint + typecheck + test (installed to ~/.local/bin)
pnpm lint:fix      # ESLint autofix
pnpm check:context # Verify installed Agent instructions match agent-context/
pnpm sync:context # Install tracked Claude and Codex instructions, plus the commit-msg hook
pnpm sync:context:hogwild # Install tracked instructions on Hogwild
pnpm release patch|minor|major  # Bump version, tag, push (syncs plugin.json, marketplace.json, skill frontmatter)
```

## Architecture

**Dual-directory layout**: the repo root holds workspace tooling (eslint, release script). The actual plugin lives in `harlan-agent-kit/`, nested so workspace tooling doesn't collide with the plugin manifest.

**Git hook** (`agent-context/git-hooks/commit-msg`): refuses a commit subject that is not Conventional Commits, under `~/pkg` and `~/sites` only. `pnpm sync:context` installs it to `~/.config/git/hooks/` and points global `core.hooksPath` at that directory. It runs for every provider, because the GitHub agent workers use opencode or codex and never load a Claude Code plugin. A repository that sets `core.hooksPath` locally, through husky for example, overrides it.

**Hook lifecycle** (`harlan-agent-kit/hooks/`, wired in `.claude-plugin/plugin.json`):
- `SessionStart`: detect project type (Nuxt module/app, UnJS, Vue, Node), show git info, warn if not pnpm
- `PreToolUse` (Bash): block npm/yarn/npx (`pnpm-only.sh`); block raw `git worktree` mutation and `.claude/worktrees` paths (`wt-only.sh`); on `git commit` inject the commit-format rule (`pre-commit-push.sh`)
- `PostToolUse` (Write|Edit): eslint autofix on the edited file

**Disable hooks per-project**: `.claude/hooks.json` with `{"disabled": ["eslint", "pre-commit-push"]}`

**Worktrees**: `wt` (worktrunk) owns every worktree, at `<parent>/<repo>.<branch-slug>`. Full rules in `harlan-agent-kit/references/worktree-isolation.md`.

## Adding Components

**Hook**: `hooks/[name].sh`, registered in `plugin.json`. Source `check-config.sh` for disable support. Input arrives as stdin JSON (`tool_input.*`). Block with `{"decision":"block","reason":"..."}`. Continue (Stop only) with `{"decision":"followup_message","message":"..."}`.

**Skill**: `skills/[name]/SKILL.md` with frontmatter (`description`, `user_invocable: true`). Keep SKILL.md to the decision-making core and push procedures, long bash blocks, and rubrics into `references/`. Add `templates/` for files the skill scaffolds, and only reference files that exist: dangling reference links cost a wasted turn mid-task.

Install locally with `/plugin install /path/to/harlan-agent-kit`.
