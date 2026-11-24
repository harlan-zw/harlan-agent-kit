# AGENTS.md

Agent plugin for Nuxt/Vue/TypeScript workflows. No build step: bash hooks plus markdown skills.

## Commands

```bash
check              # Parallel lint + typecheck + test (installed to ~/.local/bin)
pnpm lint:fix      # ESLint autofix
pnpm check:context # Verify installed Agent instructions match agent-context/
pnpm sync:skills   # Sync declared portable Skills through skilld
pnpm check:skills  # Check installed Skills against .skills/skilld.json
pnpm sync:context # Install tracked Claude and Codex instructions, the commit-msg hook, the opencode plugin, and the kit plugin for Claude Code and Codex
pnpm sync:context:hogwild # Install the same on Hogwild; fast-forward its clean ~/pkg checkout first, because Claude Code reads it in place
pnpm test:opencode-hooks # Run the opencode plugin against the real hook scripts
pnpm release patch|minor|major  # Bump version, tag, push (syncs plugin.json, marketplace.json, skill frontmatter)
```

## Architecture

**Dual-directory layout**: the repo root holds workspace tooling (eslint, release script). The actual plugin lives in `harlan-agent-kit/`, nested so workspace tooling doesn't collide with the plugin manifest.

**Git hook** (`agent-context/git-hooks/commit-msg`): refuses a commit subject that is not Conventional Commits, under `~/pkg` and `~/sites` only. It also refuses a scope the repository's `GLOSSARY.md` retires in its `## Scopes` table, naming the replacement. That table lists retired spellings only, so a repository without one keeps every scope. `pnpm sync:context` installs it to `~/.config/git/hooks/` and points global `core.hooksPath` at that directory. It runs for every provider, because the GitHub agent workers use opencode or codex and never load a Claude Code plugin. A repository that sets `core.hooksPath` locally, through husky for example, overrides it.

**opencode parity** (`harlan-agent-kit/plugins/opencode/harlan-hooks.ts`): the same provider gap reaches the tool hooks below. This plugin runs the same bash scripts over the same stdin and stdout contract. It denies a tool call by throwing, which opencode turns into a tool error the model reads. It rewrites a command by mutating `output.args` in place, because opencode hands that same object to the tool. A hook that fails, times out, or is missing logs to stderr and allows the call. It reads its hook list, its order, and its timeouts from the installed `plugin.json`, so it needs no list of its own. Timeouts are seconds, as Claude Code reads them. `pnpm sync:context` installs the scripts to `~/.local/share/harlan-agent-kit/hooks/`, the manifest to `~/.local/share/harlan-agent-kit/.claude-plugin/plugin.json`, and the plugin to `~/.config/opencode/plugins/harlan-hooks.ts`, locally and on Hogwild.

**Hook lifecycle** (`harlan-agent-kit/hooks/`, wired in `.claude-plugin/plugin.json`):
- `SessionStart`: detect project type (Nuxt module/app, UnJS, Vue, Node), show git info, warn if not pnpm
- `PreToolUse` (Bash): block npm/yarn/npx (`pnpm-only.sh`); block raw `git worktree` mutation and `.claude/worktrees` paths (`wt-only.sh`); keep email read only (`himalaya-read-only.sh`); require the PR skill (`pr-skill-only.sh`); send `wrangler d1 execute --remote --command` to `cf d1 query`, naming no database id (`cf-d1-routing.sh`); on `git commit` inject the commit-format rule (`pre-commit-push.sh`)
- `PostToolUse` (Write|Edit): eslint autofix on the edited file
- `WorktreeCreate` and `WorktreeRemove`: create and remove harness worktrees with `wt` (`wt-worktree-create.sh`, `wt-worktree-remove.sh`), so subagent, background, and Remote Control worktrees never land in `.claude/worktrees`. Create prints only the path on stdout. Remove never forces, so uncommitted work keeps the worktree.
- `PostToolUse` (Bash): append a `command-not-found.sh` install or BSD/GNU flag suggestion to the shell output, once per session per command

`plugin.json` is the only place a hook is registered, except for Codex. `pnpm sync:context` renders `hooks/codex.json` into `~/.codex/hooks.json`, pointing at the installed scripts, and `pnpm test:codex-hooks` keeps its Bash guards equal to the PreToolUse Bash chain here. Keep them out of the Codex plugin: Codex trusts a plugin hook against the whole plugin, so every kit change would switch the guards off until reviewed. `scripts/agent-context-hooks.sh` derives the hook list from it, in manifest order, and the sync script, the drift check, and the opencode plugin all read that derivation. So adding or renaming a hook is one edit to `plugin.json`, plus `hooks/codex.json` for a PreToolUse Bash guard. The opencode plugin maps the events itself: a PreToolUse Bash hook runs before the shell tool, a PostToolUse Write or Edit hook runs after a write, and a PostToolUse Bash hook has its `additionalContext` appended to the shell tool output, because opencode has no context contract. opencode ignores PostToolUseFailure, since its PostToolUse output already carries failures. Files the hooks source, such as `check-config.sh`, are not hooks; the derivation finds them by reading the `source` lines.

**Email access** (`hooks/himalaya-read-only.sh`): the hook grants read access and blocks mail changes, including draft saves and sending. A global setting cannot prove approval of a specific draft. The [email usage skill](harlan-agent-kit/skills/email-usage/SKILL.md) documents how to hand an authorized save to Harlan. Hogwild also runs Himalaya without a send backend.

**Hook hit log** (`hooks/hit-log.sh`): a Hook that denies or rewrites calls `log_hook_hit` once. It appends one JSON line to `${XDG_STATE_HOME:-$HOME/.local/state}/harlan-agent-kit/hook-hits.jsonl`, without the command. A failed write never changes the decision. `pnpm hook-hits` counts hits per Hook, surface, and ISO week. A test that runs a Hook sets `XDG_STATE_HOME` to a temporary directory.

**Disable hooks per-project**: `.claude/hooks.json` with `{"disabled": ["eslint", "pre-commit-push"]}`

**Workflow** (`.github/workflows/test.yml`): select jobs from changed paths with `scripts/ci-changes.ts`. Executable Markdown runs tests. Code runs lint, typecheck, build, and tests. README, changelog, license, and plan prose skip these jobs. Keep path selection at the job level so required checks report. Use GitHub hosted runners. The test job installs a pinned `wt` for real worktree workflows.

**Two service checkouts**: Hogwild runs the controller from its own clone, and the desktop runs `harlan-desktop-agent` from a clone of the same path on the desktop. Both halves of an offloaded turn must speak the same shape, so `pnpm service:hogwild:update` moves both and `DESKTOP_PROTOCOL` in `desktop-protocol.ts` guards the gap. A desktop reporting an older protocol is stood down, and the work stays on Hogwild. Raise that constant whenever the turn or report shape changes. Merged changes ship at the nightly scheduled Update; run the helper only when Harlan asks or a merged fix must ship sooner, because every update drains Agents and drops control connections.

**Worktrees**: `wt` (worktrunk) owns every worktree, at `<parent>/<repo>.<branch-slug>`. Full rules in `harlan-agent-kit/references/worktree-isolation.md`.

## Adding Components

**Hook**: `hooks/[name].sh`, registered in `plugin.json`. Source `check-config.sh` for disable support. Input arrives as stdin JSON (`tool_input.*`). Deny a PreToolUse call with `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`. Add context with `{"hookSpecificOutput":{"hookEventName":"<event>","additionalContext":"..."}}`; Claude Code ignores a top-level `additionalContext`. A failed Bash call fires PostToolUseFailure with an `error` field, not PostToolUse. Test hooks with `pnpm test:hook-output`, and check the contract at https://code.claude.com/docs/en/hooks.

**Skill**: `skills/[name]/SKILL.md` with required `name` and `description` frontmatter. Use standard Agent Skills fields and documented Claude Code settings. Omit default invocation settings. Keep SKILL.md to the decision-making core and push procedures, long bash blocks, and rubrics into `references/`. Add `templates/` for files the skill scaffolds, and only reference files that exist: dangling reference links cost a wasted turn mid-task.

**Root docs**: every repository Harlan owns carries the same root set and `docs/` lifecycle. The contract is `harlan-agent-kit/references/root-docs.md`; `pkg-conform` applies it by checklist, and nothing enforces it automatically yet.

Install locally with `/plugin install /path/to/harlan-agent-kit`.
