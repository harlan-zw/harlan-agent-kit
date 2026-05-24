# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Agent plugin for Nuxt/Vue/TypeScript workflows. No build step - pure bash hooks and markdown skills.

## Commands

```bash
check              # Parallel lint + typecheck + test (installed to ~/.local/bin)
pnpm lint          # ESLint check
pnpm lint:fix      # ESLint autofix
pnpm release patch|minor|major  # Bump version, tag, push
```

## Structure

```
harlan-agent-kit/             # Plugin root (nested to allow workspace tooling)
  .claude-plugin/plugin.json  # Manifest with hook config
  hooks/                      # Bash scripts (8 hooks)
  skills/                     # Skills (SKILL.md + optional templates/)
.claude-plugin/marketplace.json  # Marketplace metadata (version synced on release)
scripts/release.ts            # Version bump script (syncs plugin.json, marketplace.json, skill frontmatter)
```

## Architecture

**Dual-directory layout**: Root has workspace tooling (eslint, release script). Actual plugin lives in `harlan-agent-kit/` subdirectory.

**Hook lifecycle**:
- `SessionStart`: Detect project type (Nuxt Module/App, UnJS, Vue, Node), show git info, warn if not pnpm
- `PreToolUse` (Bash): Block npm/yarn/npx (`pnpm-only.sh`), run parallel lint+typecheck+test on commit/push (`pre-commit-push.sh`)
- `PostToolUse` (Write|Edit): Auto-fix eslint on edited file
- `PreToolUse` (Bash): On push/PR, runs `check` (parallel lint+typecheck+test) and blocks on failure

**Disable hooks per-project**: Create `.claude/hooks.json` with `{"disabled": ["eslint", "pre-commit-push"]}`

**Skills**: `pkg-conform` (conform/scaffold packages), `issue-triage` (batch analyze GitHub issues), `pr` (conventional commit PRs), `tweet` (draft + screenshot wrapper), `social-presence` (content strategy, find tweetable moments from recent work, craft launch tweets), `nuxt-frontend-design` (full lifecycle: design system setup, page building, polish), `nuxt-frontend-review` (independent evaluator agent, runs as `context: fork` after frontend design)

## Adding Components

**Hook**: Create `hooks/[name].sh`, add to `plugin.json`. Source `check-config.sh` for disable support. Input via stdin JSON (`tool_input.*`). Block with `{"decision":"block","reason":"..."}`. Continue (Stop only) with `{"decision":"followup_message","message":"..."}`.

**Skill**: Create `skills/[name]/SKILL.md` with frontmatter (`description`, `user_invocable: true`). Add `templates/` subdir for scaffolding files.

## Testing

No build needed. Install locally:
```bash
/plugin install /path/to/harlan-agent-kit
```
