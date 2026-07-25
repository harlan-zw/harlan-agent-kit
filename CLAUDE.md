# CLAUDE.md

Agent plugin for Nuxt/Vue/TypeScript workflows. No build step: bash hooks plus markdown skills.

## Commands

```bash
check              # Parallel lint + typecheck + test (installed to ~/.local/bin)
pnpm lint:fix      # ESLint autofix
pnpm release patch|minor|major  # Bump version, tag, push (syncs plugin.json, marketplace.json, skill frontmatter)
```

## Architecture

**Dual-directory layout**: the repo root holds workspace tooling (eslint, release script). The actual plugin lives in `harlan-agent-kit/`, nested so workspace tooling doesn't collide with the plugin manifest.

**Hook lifecycle** (`harlan-agent-kit/hooks/`, wired in `.claude-plugin/plugin.json`):
- `SessionStart`: detect project type (Nuxt module/app, UnJS, Vue, Node), show git info, warn if not pnpm
- `PreToolUse` (Bash): block npm/yarn/npx (`pnpm-only.sh`); on commit/push/PR run `check` and block on failure (`pre-commit-push.sh`)
- `PostToolUse` (Write|Edit): eslint autofix on the edited file

**Disable hooks per-project**: `.claude/hooks.json` with `{"disabled": ["eslint", "pre-commit-push"]}`

## Adding Components

**Hook**: `hooks/[name].sh`, registered in `plugin.json`. Source `check-config.sh` for disable support. Input arrives as stdin JSON (`tool_input.*`). Block with `{"decision":"block","reason":"..."}`. Continue (Stop only) with `{"decision":"followup_message","message":"..."}`.

**Skill**: `skills/[name]/SKILL.md` with frontmatter (`description`, `user_invocable: true`). Keep SKILL.md to the decision-making core and push procedures, long bash blocks, and rubrics into `references/`. Add `templates/` for files the skill scaffolds, and only reference files that exist: dangling reference links cost a wasted turn mid-task.

Install locally with `/plugin install /path/to/harlan-agent-kit`.
