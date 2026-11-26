# AGENTS.md

Agent plugin and maintenance service (`packages/harlan-github-agent`) for Nuxt/Vue/TypeScript workflows. The plugin itself has no build step: bash hooks plus Markdown skills under `harlan-agent-kit/`.

## Commands

```bash
check                            # Parallel lint + typecheck + test (installed to ~/.local/bin)
pnpm lint:fix                    # ESLint autofix
pnpm check:context               # Verify installed Agent instructions match agent-context/
pnpm sync:skills                 # Sync declared portable Skills through skilld
pnpm check:skills                # Check installed Skills against .skills/skilld.json
pnpm sync:context                # Install instructions, git hook, hooks, and plugins locally
pnpm sync:context:hogwild        # Install the same on Hogwild (updates clean ~/pkg checkout)
pnpm test:opencode-hooks         # Run the opencode plugin against the real hook scripts
pnpm release patch|minor|major   # Bump version, tag, push (syncs plugin, marketplace, skills)
```

## Layout and Instructions

- **Dual-directory layout**: repo root holds workspace tooling and `packages/`; the installable plugin lives in `harlan-agent-kit/` so workspace tooling does not collide with the plugin manifest.
- **Agent instructions**: `agent-context/context.md` renders to `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, and `~/.gemini/GEMINI.md`. `agent-context/worker.md` installs to `~/.local/share/harlan-agent-kit/worker.md` for headless `harlan-github-agent` workers. Both mirror the six TypeScript design principles from `harlan-agent-kit/skills/ts-design-patterns/SKILL.md` (verified by `pnpm check:context`).
- **Root docs contract**: `harlan-agent-kit/references/root-docs.md` (`pkg-conform` applies it by checklist; nothing enforces it automatically yet).

## Traps

- **Hook registration parity**: `harlan-agent-kit/.claude-plugin/plugin.json` is the single source of truth for Claude, OpenCode, and Antigravity hooks (`scripts/agent-context-hooks.sh` derives the list and sourced helpers). For any `PreToolUse` Bash guard, also update `harlan-agent-kit/hooks/codex.json` and run `pnpm test:codex-hooks` (kept out of the Codex plugin so kit updates do not reset trust).
- **Hook output contract**: deny `PreToolUse` with `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`; add context via `hookSpecificOutput.additionalContext` (Claude Code ignores top-level `additionalContext`). Failed Bash calls fire `PostToolUseFailure` with `error`, not `PostToolUse`. Test with `pnpm test:hook-output`.
- **Hook tests and hit log**: hooks that deny or rewrite call `log_hook_hit` (`hooks/hit-log.sh`). Any test running a hook must point `XDG_STATE_HOME` at a temporary directory.
- **Per-project hook disable**: `.claude/hooks.json` with `{"disabled": ["eslint", "pre-commit-push"]}`.
- **Two service checkouts**: Hogwild and desktop both run from `~/.local/share/harlan-github-agent/service`. Bump `DESKTOP_PROTOCOL` in `packages/harlan-github-agent/src/desktop-protocol.ts` whenever the offloaded turn or report shape changes. Nightly updates move Hogwild only; run `pnpm service:hogwild:update` after merges touching paired files (`scripts/hogwild-update-gate.ts` lists them), or pass `--reason 'WHY'`.
- **Skills**: keep `skills/[name]/SKILL.md` to the decision-making core; put procedures, long bash blocks, and rubrics in `references/`. Only link files that exist (`scripts/skill-doc-paths.test.ts` checks paths).
- **CI path selection**: `.github/workflows/test.yml` filters at the job level via `scripts/ci-changes.ts` so required checks report on prose-only PRs.

Install locally with `/plugin install /path/to/harlan-agent-kit`.
