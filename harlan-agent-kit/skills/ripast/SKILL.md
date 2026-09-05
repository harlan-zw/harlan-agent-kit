---
name: ripast
description: "Use Ripast for AST-aware renames, moves, extracts, usages, imports, and CSS class migrations across TS, JS, and Vue. Trigger for mechanical changes spanning files."
user_invocable: true
---

`ripast` is published on npm as `@ripast/cli`. Repo: <https://github.com/harlan-zw/ripast>

## Worktree isolation

Before a mutating `--apply`, follow the [worktree isolation contract](../../references/worktree-isolation.md). It provides the atomic live-agent claim used below.

An existing worktree alone does not prove another agent is active.

`wt` is the only worktree tool. Never run `git worktree add`, and never use a harness worktree option such as `EnterWorktree` or `isolation: "worktree"`. Those write to `.claude/worktrees/`, which is banned. `wt` places every worktree at `<parent>/<repo>.<branch-slug>`.

Keep the primary checkout read only. Before a mutating `--apply`, run `wt list --format=json`. Reuse the task's worktree with `wt switch <branch>`, or create one with `wt switch --create <branch> --base <base>`. Read its absolute `path` from the JSON, then pass that path as `workdir` to every later command. Never share a mutation worktree between tasks.

## Invocation

```bash
pnpm dlx @ripast/cli <command> ...
```

Or install once:

```bash
pnpm add -g @ripast/cli
ripast <command> ...
```

Requires `rg` (ripgrep) on PATH and Node 20.11+.

## Commands

| Command | Use |
| --- | --- |
| `ripast scan <pattern>` | Classify every occurrence (identifier vs string vs property vs JSX). First call before any rename. |
| `ripast tree` | Project declaration tree. |
| `ripast unused` | Top-level declarations with zero project references. |
| `ripast rename <from> <to>` | Scope-aware symbol rename via ts-morph. |
| `ripast move <symbol> --from <a> --to <b>` | Move an export; rewrite all import sites. |
| `ripast rename-file <old> <new>` | Rename file + every importer (incl. `.vue`). |
| `ripast css-class-rename <from> <to> \| --map <file.json>` | Tailwind/CSS token migration. |
| `ripast css-class-scan` | List class tokens (seeds a rename map). |

For Nuxt projects, pass `--tsconfig .nuxt/tsconfig.json` on `tree`/`unused`/`rename`/`move`/`rename-file` so auto-imported composables, utils, and components resolve. Run `nuxi prepare` first if `.nuxt/` is missing.

Mutating commands default to **dry-run** (unified diff). Pass `--apply` to write. `--verify` (default on for `rename`/`move`) blocks `--apply` if new typecheck diagnostics appear; pass `--no-verify` to skip, or `--verify-mode touched|project|none` for explicit control. Pass `--json` for machine-readable output. `--profile auto|agent|full` controls verbosity (auto-detects agent envs via `std-env`).

## When to use vs Edit

| Situation | Tool |
| --- | --- |
| Single site, or <5 matches in one file | Edit |
| "Where is X used?" | `ripast scan` |
| Rename a symbol across the repo | `ripast rename` |
| Move a declaration to another file | `ripast move` |
| Rename a file and update every importer | `ripast rename-file` |
| Migrate a tailwind/CSS class | `ripast css-class-rename` |
| Pattern only meaningful in strings/comments | plain `rg` + Edit |

When in doubt, start with `scan` — its output tells you which of rename/move/Edit fits.

Run `pnpm dlx @ripast/cli <cmd> --help` for full flags.
