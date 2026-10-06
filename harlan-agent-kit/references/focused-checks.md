# Focused checks

Keep the role's Check budget. Select one command that proves the changed behavior.
Read package scripts and the failing workflow before choosing its prerequisites.

## Complete logs and original exits

Use `agent-check.ts <plan.json>` when output is long.
Context sync installs this command locally and on Hogwild's Agent PATH.
Keep plans and logs in scratch. Use absolute paths for `logDirectory`.

```json
{
  "prerequisites": [],
  "check": ["pnpm", "exec", "vitest", "run", "test/regression.test.ts"],
  "logDirectory": "/home/harlan/scratch/focused-check"
}
```

Replace the example test path with the actual regression test.
Each command is an argv array. The command does not use a shell.
The result names each complete log and its original exit code or signal.
The first failed prerequisite stops execution. A signal makes the command fail.
If spawning fails, the command reports that failure and exits nonzero.
Read or filter the saved log after execution. Report the original outcome.
A filtered diagnostic list cannot establish success.

## Missing generated inputs

If Nuxt types or a workspace export are missing, inspect the declaring package once.
Use its existing prepare script, export target, and workflow ordering as evidence.
Add only that declaration's required preparation to `prerequisites`, in dependency order.
Do not guess SDK names, prepare unrelated packages, or repeat the unchanged failing command.
If no declaration establishes preparation, report the missing input and verification limit.
Preparation generates inputs for the focused check. It does not authorize a full validation build.
Read-only Review cannot generate inputs. Use existing evidence or report that limit.

## Search

`rg` searches directories recursively by default.
Use `rg -n 'pattern' path` for lines. Use `rg -l 'pattern' path` for paths.
`rg -r` replaces matches in output. It does not enable recursion.

## pnpm lockfile

Change the owning manifest or catalog first. Preserve `catalog:` and `workspace:` references.
Use the repository's pinned pnpm version and registry configuration.
Run `pnpm install --lockfile-only --ignore-scripts` to regenerate the dependency graph.
Review the resulting diff for unrelated changes. Never patch lockfile YAML manually.
If verification needs installed dependencies, run `pnpm install --frozen-lockfile --ignore-scripts` first.
Run declared preparation explicitly when the focused check requires it.
Keep repository trust policy, overrides, patches, and dependency constraints intact.
