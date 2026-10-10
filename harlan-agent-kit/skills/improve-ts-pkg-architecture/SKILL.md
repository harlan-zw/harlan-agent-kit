---
name: improve-ts-pkg-architecture
description: "Review architecture for a TypeScript package without nuxt.config.ts. Use for package-native refactors, exports, workspaces, module boundaries, and testability."
effort: high
license: MIT
compatibility: "Designed for Harlan Agent Kit workflows. Requires repository access and the tools named in this Skill."
---

# Improve TS Package Architecture

Surface architectural friction in a TypeScript package (library, CLI, or pnpm monorepo) and propose **deepening opportunities** — refactors that turn shallow modules into deep ones, using the package's own publishable surface as the seam. The aim is testability and AI-navigability.

Vocabulary, principles, and forbidden patterns live in their canonical files; this file references them. Use the terms in [LANGUAGE.md](LANGUAGE.md) exactly. This skill is _informed_ by the project's domain model (`GLOSSARY.md`, `docs/arch/`, `docs/adr/`).

## Worktree isolation

Before any edit, read and follow the [worktree isolation contract](../../references/worktree-isolation.md).
Keep mutation in a task-owned `wt` worktree with a live claim. Keep the primary checkout read only.

## Companion files

- [LANGUAGE.md](LANGUAGE.md) — full vocabulary and principles.
- [DEEPENING.md](DEEPENING.md) — dependency categories, seam ladder (file → subpath export → `packages/*`), testing strategy.
- [TS-PKG-SEAMS.md](TS-PKG-SEAMS.md) — catalogue of TS-package-native seams (`exports`, conditional exports, `packages/*`, catalogs, `bin`, hookable, unplugin, citty).
- [PKG-CONVENTIONS.md](PKG-CONVENTIONS.md) — package conventions (factory shape, options + hooks, error modes, CLI shape, treeshake invariants, fixture layout, runtime portability).
- [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md) — design-it-twice with parallel sub-agents for chosen candidates.
- [code-comments.md](../../references/code-comments.md) — the comment contract for any code this skill writes.

## Process

### 1. Explore

Read the published surface and the requested boundary first. Use scoped inspection to resolve a specific uncertainty.
Read the installed `ripast` Skill before using RipIDE. Prefer a supplied launcher and preserve its version.
Use RipIDE for supported mechanical operations. Design new contracts with direct edits.
Before a cross-package move, check destination dependencies and exported entry points.

Support architectural claims with the relevant exports, imports, call sites, or semantic tool evidence.
Text matches and classified `scan` occurrences do not establish unique semantic consumers.
State the evidence's scope and limits. Do not run every discovery command merely to establish tool usage.

In examples, `ripide` means the supplied or prepared launcher.
Pass `--tsconfig` only to commands that accept it. `scan`, `tree`, and `unused` do not accept it.
Scope discovery with a relevant `--glob`, such as `'packages/core/src/**'`. Expand only when needed.

Choose an inspection only when it can change the next decision:

| Command | What it surfaces |
| --- | --- |
| `ripide unused --glob 'packages/core/src/**' --exports local` | Top-level declarations with zero project references → deletion-test slam-dunks |
| `ripide tree --glob 'packages/core/src/**' --exports exported` | Public surface per file → shallow modules + leaks (anything exported that isn't in the `exports` map is a confessed private leak) |
| `ripide tree --glob 'packages/core/src/**' --exports local` | Internals per file → locality opportunities |

Per-candidate, before listing (`scan` is rg-driven — use `--glob` here):

| Command | What it surfaces |
| --- | --- |
| `ripide scan <symbol> --glob ...` | Caller count + kind classification → drives deletion test + §2 thresholds |
| `ripide scan <symbol> --kind identifier-reference,import-specifier --glob ...` | Same, minus string-literal noise |
| `ripide scan <symbol> --graph mermaid --glob ...` | Importer graph → cross-package leaks (graph spanning `packages/a/src/` + `packages/b/src/` via deep import) |

Cite supported numbers when presenting. Otherwise describe the verified relationship without an invented count.
Save full output as an artifact. Read relevant names, locations, and short context into the model.
Batch independent reads. Keep dependent mutations and checks sequential.

Read `package.json` `exports`, `bin`, `peerDependencies`, `sideEffects`, and `engines`. The `exports` map is the contract.
Then read `GLOSSARY.md`, `docs/arch/`, and `docs/adr/` when present.

Orient on the package shape:

- Is this a **single-repo library**, a **CLI** (`bin` field), a **plugin** (peer-dep on rollup/vite/eslint/etc.), or a **pnpm monorepo** with `packages/*`?
- Which TS-package-native seams are already used: subpath exports, conditional exports (`types`/`import`/`node`/`browser`/`workerd`), `packages/*`, `catalog:` versions, `hookable` hooks, `unplugin`/factory shape, `citty` subcommands, `c12` config loading?
- Where does the package hand-roll its own seam (a singleton in a top-level file, a global `EventEmitter`, a custom plugin registry, ad-hoc env reads) instead of using one the ecosystem provides?

Then use the Agent tool with `subagent_type=Explore` to walk the codebase. Note friction signals:

- **Shallow modules** — files re-exporting one function, factories that just `new` a class, utils that wrap one-liners. Spot via `tree --exports exported`.
- **Bouncing** — understanding one feature requires five files with no central seam. `scan <symbol> --graph mermaid` spanning 10+ directories.
- **Pure-function extraction without locality** — bugs hide in how the pieces compose (orchestration order, error recovery, cache invalidation).
- **Cross-cutting leak** — logging/config/error-mapping/telemetry scattered across 10+ files instead of one factory or hook bus.
- **Hard-to-test interface** — modules reading `process.env` deep inside, singletons at import, side effects on import.
- Walk [PKG-CONVENTIONS.md](PKG-CONVENTIONS.md); each section's "Gap" entry is a friction signal — if present in the codebase, that's a candidate.
- **Cross-package leaks** (monorepo) — relative or deep imports across workspace packages bypass the `exports` map. Detect with `scan <symbol> --graph mermaid` straddling two `packages/*`. See [TS-PKG-SEAMS.md](TS-PKG-SEAMS.md) `Workspace packages`.
- **`exports` map leaks** — deep paths (`pkg/dist/internal/foo`) instead of declared subpaths. Either expose a subpath or stop the leak.
- **Cross-module coupling that should flow through a hook bus** — two modules importing each other to coordinate, or fan-in to a coordinator module. `hookable` is the answer. Detect via two-way edges in `scan --graph mermaid`.
- **Treeshake / bundle-size signals** — heavy SDK statically imported at module top when only one path uses it. Move the import inside the function, or behind a conditional export. Run `pnpm dlx publint && pnpm dlx @arethetypeswrong/cli --pack .` plus `du -sh dist/`.
- **Repeated import-time work** (regex/schema/table compilation) running whether the module is used or not. Move into a memoised getter inside the factory.

### 2. Present candidates

Present a numbered list of deepening opportunities. For each candidate:

- **Files** — which files/modules are involved (include flavour paths: `src/index.ts`, `src/cli.ts`, `packages/core/src/foo.ts`, `package.json` `exports`, `pnpm-workspace.yaml`)
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change, named in TS-pkg terms (e.g. *"collapse these five files into a single `createPipeline(opts)` factory exported from a new `./pipeline` subpath; the existing files become private implementation under `src/pipeline/`, and the factory exposes a `hookable` hook bus for the three current extension points"*)
- **Benefits** — explained in terms of locality and leverage, and also in how tests would improve (e.g. *"the factory can be tested directly with vitest; today the three hooks fire from three different files and the only way to observe them is to import each privately"*)

**Use GLOSSARY.md for the domain, [LANGUAGE.md](LANGUAGE.md) for the architecture, [TS-PKG-SEAMS.md](TS-PKG-SEAMS.md) for the framework seam, and the relevant convention section from [PKG-CONVENTIONS.md](PKG-CONVENTIONS.md) when the candidate is a convention gap.** Example phrasings: *"the Order intake module exposed as a `./intake` subpath"*, *"establish PKG-CONVENTIONS.md §Hook bus for the build pipeline"* — not *"the FooBarHandler"*, not *"the Order service"*.

**Reject before listing.** Validate consumer relationships from resolved imports and call sites; no guesswork.
Use `scan <symbol> --kind identifier-reference,import-specifier` to locate candidates, then inspect their identity.

- **Deletion test fails.** Thresholds: subpath export ≥3 consumers or a distinct public concept; workspace `packages/*` ≥2 independent consumers AND zero coupling back to the host; factory ≥2 callers OR real branching/options; pure value/type mapping ≥4 callers.
- **No locality win.** Pure-function extraction with no consolidation, speculative seams, defensive re-validation of invariants the caller's types already enforce.
- **Renames dressed up as architecture.** Note separately or skip.
- **Already conventional** — matches a PKG-CONVENTIONS.md section.
- **Subpath read in exactly one place.** Confirm with `scan <import-specifier> --kind import-specifier`.
- **Config threaded through ≥3 layers unchanged** — consume at the creation layer or place an adapter at the deepest meaningful seam.
- **Contradicts a current ADR without a load-bearing reason.** See ADR conflicts below.

**Forbidden patterns** (always flag, never propose) — full list in [PKG-CONVENTIONS.md](PKG-CONVENTIONS.md) §"Forbidden patterns".

**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real enough to warrant revisiting the ADR. Mark it clearly (e.g. _"contradicts ADR-0007 — but worth reopening because…"_). Don't list every theoretical refactor an ADR forbids.

Do NOT propose interfaces yet. Ask the user: "Which of these would you like to explore?"

### 3. Grilling loop

Once the user picks a candidate, drop into a grilling conversation. Walk the design tree with them — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive. For TS-pkg candidates, also walk: which runtimes it must work in (node / browser / workerd / edge / bun), whether it appears in the `exports` map (and at which subpath / conditional), whether it lives in `src/` or a workspace `packages/*`, what the treeshake / `sideEffects` story is.

Side effects happen inline as decisions crystallize:

- **Naming a deepened module after a concept not in `GLOSSARY.md`?** Read the installed Brundlefly `glossary` Skill and add the term there: the term, one sentence of meaning in this codebase, and where it lives.
- **Sharpening a fuzzy term during the conversation?** Update `GLOSSARY.md` right there.
- **User rejects the candidate with a load-bearing reason?** Offer an ADR, framed as: _"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"_ Only offer when the reason would actually be needed by a future explorer to avoid re-suggesting the same thing — skip ephemeral reasons ("not worth it right now") and self-evident ones. Write it to `docs/adr/NNNN-slug.md` with context, decision, and consequences.
- **Want to explore alternative interfaces for the deepened module?** See [INTERFACE-DESIGN.md](INTERFACE-DESIGN.md). Sub-agents are pre-seeded with TS-pkg-native shapes (single factory, factory + hook bus, subpath-exposed surface, ports & adapters) so the design space is grounded in what the ecosystem already offers.
- **Need to know the true blast radius of a rename/move before committing?** `ripide scan <symbol>` (counts) or `ripide scan <symbol> --graph mermaid` (importer graph). Quote numbers before promising scope.
- **Decision crystallized into a concrete refactor?** Execute through ripast, not Edit. Pick the primitive:

  Pass `--tsconfig tsconfig.json` (or the per-package one) on `rename`, `move`, and `rename-file` so all callers are rewritten.

  | Refactor | Command |
  | --- | --- |
  | Rename a symbol across files | `ripide rename <from> <to> --tsconfig tsconfig.json --apply` (add `--scope <file>` if multi-declared) |
  | Move an exported declaration | `ripide move <symbol> --from <a> --to <b> --tsconfig tsconfig.json --apply` |
  | Move a file (e.g. `src/utils/foo.ts` → `src/pipeline/foo.ts` to close a leak) | `ripide rename-file <old> <new> --tsconfig tsconfig.json --apply` |

  Use the installed `ripast` Skill's operation and verification guidance.
  Keep verification enabled. Recover complete diagnostics before classifying an apparent false positive.
  Design new APIs and behavior with direct edits. Use supported semantic commands for their mechanical changes.
  If public types or exports change, rebuild affected declarations before downstream typechecks.
  Repair a failed check, then run the focused proving check before broad verification.
  Keep meaningful failing-first tests. Do not repeat unchanged failing lint commands.
  Repeat passed checks only after relevant edits or new evidence. Run required final checks on the submitted tree.

- **The refactor changes the `exports` map?** Update `package.json` `exports` in the same pass. If a subpath is added or removed, the change is a SemVer-visible event — note it for the next release.
