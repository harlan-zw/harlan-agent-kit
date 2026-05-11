---
name: ripast
description: AST-aware rename, move, extract, find-usages, and tailwind/CSS class migration across TS/JS/Vue SFCs (incl. `<template>`). Use for any multi-file rename, move, import update, or refactor mechanical step. Prefer over Edit/grep whenever a change spans more than one file.
user_invocable: true
---

`ripast` is published on npm as `@ripast/cli`. Repo: <https://github.com/harlan-zw/ripast>

## Invocation

```bash
npx -y @ripast/cli <command> ...
```

Or install once:

```bash
npm i -g @ripast/cli
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

Run `npx -y @ripast/cli <cmd> --help` for full flags.
