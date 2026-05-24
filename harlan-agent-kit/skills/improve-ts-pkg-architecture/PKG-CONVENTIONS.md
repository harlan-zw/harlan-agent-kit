# Package Conventions

Conventions for TypeScript packages that the ecosystem doesn't ship by default but that pay back as soon as the package has more than one feature. Each entry has a **Gap** (the friction signal in the codebase) and a **Seam** (the convention shape that closes it).

Use this file alongside [TS-PKG-SEAMS.md](TS-PKG-SEAMS.md): seams are the *where*, conventions are the *shape*.

---

## §1 Factory + options shape

**Gap**: stateful behaviour exposed as a `class` with one public method, or as several free functions that all take the same five arguments and pretend they aren't related.

**Seam**: a `createX(opts: XOptions): X` factory. Options object captures build-time/init-time concerns. Returned object captures run-time concerns and exposes the hook bus if extension is real. The factory IS the public interface; the returned object's methods are the operational interface.

```ts
export function createPipeline(opts: PipelineOptions = {}): Pipeline { /* … */ }
// → { run(input): Promise<Output>, hooks: Hookable<PipelineHooks> }
```

**Reject**: classes with one public method (`new Foo().run()` → `runFoo()` or `createFoo().run()`); factories whose options surface is 1:1 with private fields (not deep); factories that read `process.env` inside (move env reads to a single config loader, pass the resolved value in).

## §2 Hook bus

**Gap**: extension points implemented as a module-level `Set<Listener>`, a custom `register(fn)`, or call sites that hard-code which extra steps run.

**Seam**: `hookable` `createHooks<HookMap>()`, returned from the factory and accepting `hooks` in options. Typed hook map. Async ordering free.

```ts
interface PipelineHooks {
  'before:run': (ctx: Ctx) => void | Promise<void>
  'after:run': (ctx: Ctx, result: Result) => void | Promise<void>
}
```

**Reject**: hook bus with one hook and one listener — that's a callback parameter. Hook bus where every event fires exactly once with no listener — that's a missing extension story, not a hook bus.

## §3 Error modes

**Gap**: errors thrown as `new Error('something went wrong')` with details encoded in the message string; consumers `try/catch` and `err.message.includes('...')`.

**Seam**: either custom `Error` subclasses with discriminator fields (`class PipelineError extends Error { readonly code: PipelineErrorCode }`) or tagged-union return values for expected failure modes (`type Result<T> = { ok: true; value: T } | { ok: false; code: string; cause?: unknown }`). Pick one per package; don't mix.

**Reject**: re-validating internal invariants the caller's types already enforce. Validate at system boundaries (user input, env, parsed config, network); trust internal types. Let unexpected errors propagate; use `.catch()` over `try/catch` when recovery is small.

## §4 CLI shape

**Gap**: hand-rolled `process.argv` parsing in `bin/mycli.js`; business logic inside the bin file; CLI behaviour unreachable from tests.

**Seam**: `citty` `defineCommand` in `src/cli.ts`; thin `bin/mycli.mjs` shim that imports and runs. Subcommands as separate `defineCommand` exports under `src/commands/`.

```ts
// src/cli.ts — defineCommand({ meta, subCommands: { build, dev, check } })
// bin/mycli.mjs — #!/usr/bin/env node + import('../dist/cli.js').then(m => m.run())
```

**Reject**: CLI factories that take options from `process.argv` directly (the parser is the seam); business logic in command `run` handlers (call into the same factory the programmatic API uses).

## §5 Config loading

**Gap**: `process.env.X` reads scattered across modules; `JSON.parse(fs.readFileSync(...))` for a config file; ad-hoc `Object.assign(defaults, user)` merging.

**Seam**: a single `loadConfig` call (typically `c12`) returning the merged config. Resolved once, at the entry point (CLI handler, factory call site), and passed in. Internals never read env.

**Reject**: `process.env` reads in `src/<anything-deep>/`. Module-level `const FOO = process.env.FOO` — eagerly captures at import, untestable, breaks edge runtimes.

## §6 Treeshake invariants & bundle size

**Gap**: package marks `"sideEffects": false` but top-level code does something — singleton construction, listener registration, env read, `console.log`, top-level `await`, regex/schema compilation. Or: a heavy SDK is statically imported at module top so it lands in every consumer bundle, even ones that never call the code path that uses it.

**Seam**: every module top-level is declarations and exports only. Any work happens inside an exported function the caller invokes. Heavy/optional deps are imported lazily (`await import('heavy-sdk')`) inside the factory method that needs them, or routed behind a separate subpath / conditional export so consumers opt in. Polyfills imported via a named function the caller decides to call, not as a side-effect import.

**Measure, don't guess**: `npx -y publint` (publish-shape checks), `npx -y @arethetypeswrong/cli --pack .` (type-export sanity across module systems), `du -sh dist/` and per-entry sizes. For runtime cost, `node --prof` or `0x` on the import path. Bundle size and import-time are part of the interface — track them.

**Reject**: top-level `await` in published source (breaks CJS interop and lazy import); module-level instantiation of caches, singletons, or hook buses (move into the factory body so each `createX()` gets its own); `import './polyfill'` at top level (export `applyPolyfill()` and let the consumer choose); a heavy dep landing on the package's root entry when only one subpath uses it (move the dep into that subpath's implementation).

## §6a UnJS-first

**Gap**: hand-rolled equivalent of a primitive UnJS already ships — custom event emitter, ad-hoc argv parser, scattered `process.env` reads, `Object.assign` defaults, `node:path` joins (forks node vs browser), `JSON.parse(fs.readFileSync(...))` for the `package.json`.

**Seam**: reach for the UnJS primitive at the dep boundary. They're treeshake-friendly, ESM-only, zero or minimal deps, universal across runtimes.

| Job | UnJS primitive |
|---|---|
| Plugin / hook bus / cross-module coordination | `hookable` (`createHooks`) |
| CLI definition | `citty` (`defineCommand`) |
| Config loading (file + env + defaults) | `c12` (`loadConfig`) |
| Build-tool plugin (rollup/vite/webpack/esbuild) | `unplugin` |
| Build pipeline (library) | `unbuild` / `obuild` |
| Option merging with defaults | `defu` |
| Path manipulation (cross-runtime) | `pathe` |
| HTTP client | `ofetch` |
| Logging | `consola` |
| Storage / KV / fs abstraction | `unstorage` |
| `package.json` / module resolution | `pkg-types`, `mlly` |
| EventEmitter replacement | `hookable` |
| Template / scaffolding download | `giget` |

Each primitive IS the seam (`hookable` for cross-module coordination, `unplugin` for multi-bundler, `c12` for layered config, `unbuild`/`obuild` for truthful `sideEffects: false`). Hand-rolled equivalents are a reject; record a load-bearing reason as an ADR if switching isn't possible.

## §7 Test fixture layout

**Gap**: tests under `__tests__/` next to source; fixtures inlined as strings; integration tests indistinguishable from unit tests; vitest config shared across packages with conflicting needs.

**Seam**:
```
test/
  unit/        # function-level tests, fast
    *.test.ts
  e2e/         # full CLI / full factory cycles
    *.test.ts
  fixtures/    # input files, snapshots, golden outputs
```

In monorepos, each `packages/*` has its own `test/` and `vitest.config.ts`. Cross-package integration tests live in a root `test/e2e/` or a dedicated `packages/__tests__` package.

**Reject**: fixtures duplicated as inline strings across tests (use `test/fixtures` + `readFileSync` once); tests that import from `src/internal/` (test through the public subpath — see [LANGUAGE.md](LANGUAGE.md) "interface is the test surface").

## §8 Runtime portability

**Gap**: package imports `node:path`, `node:fs`, `node:url` deep inside what should be runtime-neutral logic; the package works in node only despite the logic itself being pure.

**Seam**: prefer the UnJS portable equivalent at the dep boundary: `pathe` for `node:path`, `unstorage` for filesystem-style access, `ofetch` for `fetch`, `consola` for `console.*`, `hookable` for `EventEmitter`. Keep node-only imports behind a `node` conditional export if both runtimes matter.

**Reject**: branching on `typeof process` / `typeof window` inside a single module — split via conditional exports so the dead branch is never loaded.

## §9 `exports` map discipline

**Gap**: a `src/index.ts` re-exporting from 30 files; consumers tab-completing into private internals; every refactor in `src/` is a SemVer-visible change because everything is public.

**Seam**: the `exports` map declares the public subpaths. Anything not declared is private. Each subpath corresponds to a `src/<concept>/index.ts`. Internal cross-subpath imports go through `src/<concept>/` paths, not through the published `exports`.

**Reject**: `"./*": "./dist/*"` wildcard exports (gives consumers the whole `dist/` — there is no private); deep imports inside the package (`from './pipeline/internal/foo'` from another concept's directory — go through `./pipeline/index.ts` or move it to `src/shared/`).

## §10 Workspace dependency direction

**Gap** (monorepo): workspace packages form a cycle; `packages/a` imports `packages/b` which imports `packages/a`. Or: a package imports from another via relative path, bypassing the `exports` map.

**Seam**: dependency direction is a DAG, declared in each package's `dependencies` / `peerDependencies`. Cross-package imports go through the package name (`@org/b`), never relative. Shared types/utilities used by ≥2 packages with no logic of their own go in a `packages/shared` or are inlined.

**Reject**: any relative import that crosses a workspace package boundary (confirm with `npx -y @ripast/cli scan <symbol> --graph mermaid`).

---

## Forbidden patterns

Always flag, never propose. Each is a hard reject regardless of context.

- **`default` export from a package entry point.** Named exports only. Tree-shakes cleanly, refactors cleanly, works with `verbatimModuleSyntax`, doesn't lose its name in tools.
- **Top-level `await` in published source.** Breaks CJS interop, breaks lazy import, traps the module in a single async-init story.
- **`process.env` reads outside the config loader.** Eager capture at import, untestable, breaks edge/workerd runtimes.
- **Relative imports across workspace packages.** The other package's `exports` map IS the interface; reaching past is a leak.
- **Singleton constructed at module top level.** Move into a factory body so each call gets its own; or, if truly global, accept that and put it behind an `init()` the consumer drives.
- **`class` with one public method.** Use a function.
- **Hand-rolled plugin registry.** Use `hookable`'s `createHooks`.
- **Hand-rolled CLI argv parsing.** Use `citty`'s `defineCommand`.
- **`try/catch` swallowing errors without recovery.** Let them propagate; use `.catch()` only when recovery is small and local.
- **Inline import** (`await import(...)`) used as a polyfill or codegen seam. Either pay the static-import cost or move the dynamic dep to a conditional export.
- **Backwards-compat shims** (renamed-export re-exports, deprecated stubs) for code paths nobody is on yet. Delete the old name.
