# TS Package Seams

Catalogue of the seams a TypeScript package already gives you. When proposing a deepening, reach for one of these before inventing a parallel mechanism. Uses the vocabulary in [LANGUAGE.md](LANGUAGE.md).

Each seam below has: **Shape** (what it looks like), **Use when** (the condition that justifies it), **Anti-pattern** (the hand-rolled equivalent to reject), and any gotchas.

---

## `exports` map (single subpath)

**Shape**: a single entry in `package.json` `exports`, e.g. `"./pipeline": "./dist/pipeline.js"`. With types: `{ "types": "./dist/pipeline.d.ts", "default": "./dist/pipeline.js" }`.

**Use when**: a cluster of files in `src/` forms a public concept distinct from the package root. The subpath becomes the seam; the files behind it become private.

**Anti-pattern**: a single `src/index.ts` re-exporting from 30 internal files, no subpaths. The whole implementation is reachable as one flat namespace and consumers tab-complete into private internals.

**Gotcha**: every declared subpath is contract — adding/removing/renaming one is a SemVer-visible event. Don't add a subpath for a single internal concept that isn't ready to be public.

## Conditional exports (runtime adapters)

**Shape**: `exports["."]` is a conditions map, e.g. `{ types, node, browser, workerd, default }` each pointing at a runtime-specific built file.

**Use when**: the same logical module needs runtime-specific implementations (filesystem in node, IndexedDB in browser, KV in workerd). The condition keys are real adapters; the seam is the import specifier.

**Anti-pattern**: a top-level `if (typeof window !== 'undefined')` branching inside one file. Both branches are loaded into every consumer, breaks treeshaking, breaks edge consumers that have neither `window` nor `process`.

**Gotcha**: one adapter = hypothetical seam. Don't ship conditional exports until at least two runtimes are real consumers (production + tests count if the test runtime differs meaningfully).

## Workspace packages (`packages/*`)

**Shape**: pnpm monorepo with `pnpm-workspace.yaml` listing `packages/*`. Each package has its own `package.json` (with its own `exports`), `tsconfig.json`, `vitest.config.ts`, and version. Consumed via the package name (`@org/pricing`), never via a relative path.

**Use when**:
- Multi-consumer: ≥2 consumers in the monorepo (app + CLI, two apps, app + worker, public dual-publish).
- Zero coupling back to the host: the package compiles and tests with vanilla node + vitest, no app aliases (`~/`, `#imports`).
- Distinct test or release cadence: property-based tests, benchmarks, a different SemVer story.

**Anti-pattern**: a workspace package with a single consumer "for future reuse" — pay the toolchain cost (tsconfig, vitest, build, version, release) when the second consumer arrives, not before. Until then, a subpath export suffices.

**Anti-pattern 2**: workspace packages importing from each other via relative paths (`../../core/src/foo`). The other package's `exports` map IS its interface; reaching past it is a leak. Confirm with `npx -y @ripast/cli scan <symbol> --graph mermaid`.

## Catalogs (`pnpm-workspace.yaml` `catalogs:`)

**Shape**: `catalog:` versions in `pnpm-workspace.yaml`, referenced as `"vue": "catalog:"` in package dependencies.

**Use when**: a dep version must stay in lockstep across ≥2 workspace packages (vue, vitest, typescript, eslint). The catalog entry IS the version seam — one place to bump.

**Anti-pattern**: duplicating versions across packages and relying on lockfile dedup. Versions drift, peer-dep warnings appear, and the bump fans out across N package.jsons.

**Gotcha**: a single `catalog:` shared across packages with conflicting requirements will break. Catalogs are for *compatible* deps that must move together.

## `bin` (CLI entry)

**Shape**: `"bin": { "mycli": "./bin/mycli.mjs" }` with a thin bin file that imports the CLI from `src/cli.ts`. The CLI itself is built around `citty`'s `defineCommand` + subcommands.

**Use when**: the package ships a command-line entry alongside its programmatic API.

**Anti-pattern**: business logic inside `bin/mycli.mjs`. The bin file should be a 5-line shim — `#!/usr/bin/env node` + `import('../dist/cli.js')`. The actual CLI factory lives in `src/`, importable and testable as a function (`defineCommand` returns a value).

## Hook bus (`hookable`)

**Shape**: factory creates `hooks = createHooks<HookMap>()`, calls `hooks.addHooks(opts.hooks)` if provided, returns `{ hooks, run }`. The typed hook map is the extension interface.

**Use when**:
- The factory exposes ≥2 extension points (or one extension point with ≥2 listener candidates). The typed hook map IS the extension interface.
- **Two or more internal modules need to coordinate without importing each other.** The hook map IS the contract; each module emits/listens; nothing in `src/` reaches across feature boundaries. This is the load-bearing use of `hookable` for architecture — different seams talking to each other through one typed map rather than through an import graph.

**Anti-pattern**: a hand-rolled `register(fn)` / global plugin registry / module-level `Set<Listener>`. Reject — use `hookable`. The hook map gets you typed events, async ordering, and `addHooks(obj)` for free.

**Anti-pattern 2**: a single hook with one listener. That's a parameter, not a hook. Pass the function directly in options.

## Plugin shape (`unplugin` or factory-returns-plugin)

**Shape**: a factory returning the plugin object expected by the host (rollup, vite, webpack via `unplugin`, or eslint via the rule loader). The factory is the public seam; the plugin object is an adapter at the host's seam.

**Use when**: shipping integration with a build tool or linter. The factory accepts options and produces the plugin.

**Anti-pattern**: exporting the plugin object directly with options baked in via top-level config reads. The factory is the seam — without it, every consumer needs a different build of the package.

## Config loader (`c12`)

**Shape**: one call to `loadConfig({ name: 'mypkg', defaults })` produces the merged config. The defaults + the layered file/env resolution is one seam.

**Use when**: the package consumes configuration from a file (`mypkg.config.ts`), env, and runtime options.

**Anti-pattern**: `process.env.X` reads scattered across modules + ad-hoc `JSON.parse(fs.readFileSync(...))` for the config file + a custom defu chain. Reject — one `c12` call replaces all of it.

## Factory + options + return (`createX(opts) → { ... }`)

**Shape**: a single factory function taking an options object, returning a small object of callable members (and a `hooks` field if extension is real).

**Use when**: the deepening introduces stateful behaviour with a clear lifecycle. The options are the build-time interface; the return is the run-time interface; the hook bus (if any) is the extension interface.

**Anti-pattern**: a `class` with one public method (use a function); a `class` with multiple methods sharing no mutable state (use several functions); a factory whose options surface mirrors private internals 1:1 (it's not deep — the interface is as complex as the implementation).

## File-level (`src/<feature>/index.ts`)

**Shape**: a directory under `src/` with an `index.ts` that exports only what's public; sibling files are private.

**Use when**: an internal concept has ≥3 files of implementation but isn't ready for a public subpath. The directory IS the internal seam; `index.ts` IS the internal interface.

**Anti-pattern**: a flat `src/` where every file is a peer and `src/index.ts` re-exports the union. Nothing is private; nothing is grouped; refactors ripple.

---

## Choosing the seam

Match the dependency category (from [DEEPENING.md](DEEPENING.md)) and the scope of the feature:

| Scope                                            | Seam to reach for                                        |
| ------------------------------------------------ | -------------------------------------------------------- |
| Pure helpers, single consumer                    | Plain function in `src/utils/`                           |
| Private internal cluster (≥3 files)              | `src/<feature>/index.ts`                                 |
| Stateful behaviour with lifecycle                | Factory (`createX(opts)`)                                |
| ≥2 extension points                              | Factory + `hookable` hook bus                            |
| Public concept distinct from root                | Subpath in `exports` map                                 |
| Same logic, different runtimes                   | Conditional exports                                      |
| Multi-consumer (≥2), zero host coupling          | Workspace `packages/*`                                   |
| Shared dep version across workspace              | `catalog:`                                               |
| Command-line entry                               | `bin` + `citty` `defineCommand`                          |
| Build-tool integration                           | Factory returning `unplugin` shape                       |
| Config from file + env + options                 | `c12` `loadConfig`                                       |
| ESLint rule pack                                 | A factory exporting `{ rules, configs }`                 |

The default is the lowest one that works. Step up only when the lower seam is provably too small.
