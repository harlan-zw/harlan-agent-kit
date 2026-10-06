---
name: ripast
description: "Use Ripast for AST-aware renames, moves, usages, imports, and CSS class migrations across TS, JS, and Vue. Trigger for mechanical changes spanning files."
---

Ripast ships on npm as `@ripast/cli`. Run commands from the target project's root.
Requires Node 22.13+ and `rg` (ripgrep) on PATH.

## Invocation

```bash
pnpm dlx @ripast/cli <command> ...
```

If the project already installs Ripast, use `pnpm exec ripast <command> ...`.
The CLI installs framework adapters when needed, including `@ripast/vue` for Vue and Nuxt.

## Commands

| Command | Use |
| --- | --- |
| `ripast scan <pattern>` | Classify occurrences before a rename. |
| `ripast tree` | Show top-level declarations and imports. |
| `ripast unused` | Find declarations without project references. |
| `ripast rename <from> <to>` | Rename a symbol through the native TypeScript server. |
| `ripast replace <from> <to>` | Replace an imported symbol with another project export. |
| `ripast move <symbol> --from <a> --to <b>` | Move an export and update imports. |
| `ripast delete <symbol> --from <file>` | Delete a declaration if no references remain. |
| `ripast rename-file <old> <new>` | Rename a file and update importers, including Vue consumers. |
| `ripast css-class-rename <from> <to>` | Rename a CSS class token. Use `--map <file.json>` for bulk changes. |
| `ripast css-class-scan` | List class tokens before a migration. |

Run `pnpm dlx @ripast/cli <command> --help` for each command's full flags.

## Apply changes

Keep unrelated work separate. Follow the target repository's worktree rules before writing.
Start with a scan, then review the dry-run diff:

```bash
pnpm dlx @ripast/cli scan useStore
pnpm dlx @ripast/cli rename useStore useAppStore --profile full
pnpm dlx @ripast/cli rename useStore useAppStore --apply
```

Mutating refactor commands default to dry-run. Pass `--apply` to write.
Rename, replace, move, delete, and rename-file verify types by default.
If new diagnostics appear, verification blocks `--apply`.
Use `--verify-mode touched|project|none` to choose the verification scope.
Keep verification enabled unless you have reviewed the reported diagnostics.
CSS class changes have no typecheck verification.

If several files declare the same name, use `rename --scope <file>`.
If several files export the replacement, use `replace --target-scope <file>`.
Use `--json` for machine-readable results where supported.
Use `--profile full` for full diffs instead of compact agent output.

For Nuxt, prepare the generated configuration before refactoring auto-imports.
Pass `--tsconfig .nuxt/tsconfig.json` to rename, move, or rename-file:

```bash
pnpm exec nuxi prepare
pnpm dlx @ripast/cli rename useCounter useTally --tsconfig .nuxt/tsconfig.json
```

Review the diff and run the target project's checks after applying it.

## When to use vs Edit

Use Ripast for mechanical changes across files.
Use a direct edit for one small change in a file you already understand.
Use `rg` and direct edits for prose or patterns that only occur in strings and comments.
Start with `scan` when the correct operation is unclear.

Vue support covers script references and template expressions through its adapter.
Svelte markup and arbitrary custom codemods are outside the supported refactor surface.
