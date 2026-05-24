# Deepening (Nuxt)

How to deepen a cluster of shallow modules safely in a Nuxt codebase. Assumes the vocabulary in [LANGUAGE.md](LANGUAGE.md) — **module**, **interface**, **seam**, **adapter** — and the seam catalogue in [NUXT-SEAMS.md](NUXT-SEAMS.md).

## Dependency categories

When assessing a candidate for deepening, classify its dependencies. The category determines how the deepened module is tested across its seam.

### 1. In-process

Pure computation, in-memory state, no I/O. Always deepenable — merge the modules and test through the new interface directly. No adapter needed.

In Nuxt: pure helpers, formatters, validators, reducers used inside composables or server utils. Lift into a plain TS module imported by both sides.

### 2. Local-substitutable

Dependencies that have local test stand-ins (PGLite for Postgres, in-memory filesystem, MSW for HTTP). Deepenable if the stand-in exists. The deepened module is tested with the stand-in running in the test suite. The seam is internal; no port at the module's external interface.

In Nuxt: nitro storage drivers (swap `redis` for `memory` in tests), `$fetch` mocked at the network layer with MSW, DB drivers swapped via `runtimeConfig`. Test through `@nuxt/test-utils` with the stand-in wired in via the test fixture's `nuxt.config.ts`.

### 3. Remote but owned (Ports & Adapters)

Your own services across a network boundary. Define a **port** at the seam; transport is injected as an **adapter**. Tests use in-memory; production uses HTTP/gRPC/queue.

In Nuxt: a Nuxt module exposing a composable-shaped port (`useFoo()` returns a typed client). Production calls `$fetch`; test adapter is in-memory. Wire via `runtimeConfig` or module option.

### 4. True external (Mock)

Third-party services (Stripe, Twilio, OpenAI, etc.) you don't control. The deepened module takes the external dependency as an injected port; tests provide a mock adapter.

In Nuxt: typically a Nuxt module that takes the SDK client as a factory in its options, defaults to the real client, and accepts a fake in tests. Hooks (`billing:charge`) let other modules/layers observe without coupling to the SDK.

## Nuxt-specific seam discipline

- **One adapter means a hypothetical seam. Two adapters means a real one.** A Nuxt hook with one listener is hypothetical; with a core + a layer override, it's real. A `.client` plugin alone is hypothetical; pair with `.server` and the seam is justified.
- **Internal seams vs external seams.** A deep Nuxt module can have internal seams (private composables, internal hooks used by its own tests) as well as the external seam at its module options + public hooks. Don't expose internal seams through the module's options just because tests use them.
- **Build-time vs runtime is itself a seam.** Decide once, per module, which side of the line each piece of work lives on. Mixing them (a runtime plugin doing what `addImports` should do) is a shallowness signal.
- **SSR vs client is a seam.** If the module behaves differently in SSR vs client, that split *is* part of the interface — document it.

## Choosing the Nuxt seam

Match the dependency category and the scope of the feature to the seam from [NUXT-SEAMS.md](NUXT-SEAMS.md):

| Feature scope                                       | Seam to reach for                                    |
| --------------------------------------------------- | ---------------------------------------------------- |
| Pure helpers used app-wide                          | Plain TS module + `addImports`                       |
| Cross-scope types/utilities (IO-free)               | `shared/` directory                                  |
| Standalone domain logic, multi-consumer / heavy test infra | `packages/*` (workspace package)              |
| Component-side state and behaviour                  | Composable                                           |
| Cross-cutting runtime singleton                     | Plugin (`.client`/`.server` if asymmetric)           |
| Cross-cutting per-request server work               | Server middleware                                    |
| Server-wide setup                                   | Nitro plugin                                         |
| Reactive lifecycle extension point                  | Nuxt or nitro hook                                   |
| HTTP entry point                                    | Server route + a deep server module behind it        |
| Feature spanning app + server + config              | Nuxt module                                          |
| Whole vertical (UI + composables + server)          | Layer                                                |
| Env-injectable runtime values                       | `runtimeConfig`                                      |
| Build-frozen typed constants                        | `appConfig`                                          |

### The seam ladder for non-framework code

For logic that doesn't need Nuxt at all, three seams sit in increasing strength:

1. **`shared/`** — types, schemas, IO-free utilities. No toolchain, no version. Importable from both runtime graphs (see [NUXT-SEAMS.md](NUXT-SEAMS.md)).
2. **`packages/*`** — workspace package with its own `package.json`, tsconfig, vitest config, and `exports` map. Imported via a workspace alias (e.g. `@org/pricing`). The package's `exports` *is* the interface; nothing inside leaks.
3. **Nuxt module / layer** — framework-coupled, integrates via `addImports`, `addServerHandler`, hooks, etc.

Each step up accepts more coupling for more leverage. The default is the lowest one that works.

### When `packages/*` earns its keep

- **Multi-consumer**: the same logic is used by two or more consumers in the monorepo (apps, a CLI, tests, a worker).
- **Zero Nuxt dependencies**: no `defineNuxtModule`, no `useState`, no `$fetch`, no `~/` aliases — the package compiles and tests with vanilla Node + vitest.
- **Distinct test infrastructure**: property-based tests, benchmarks, cross-runtime checks, or a test matrix that would clutter the Nuxt app.
- **Cross-team ownership**: the package boundary mirrors a team boundary, with its own release cadence (private versioning is fine).

It's the **deepest** seam you can place: by construction, the implementation is fully encapsulated and the two-adapter test passes (multiple consumers = multiple adapters at the package boundary).

### Anti-patterns

- **Package with `defineNuxtModule` inside.** That's a Nuxt module — put it in `modules/` (or publish it as a public Nuxt module). Packaging it locally just adds toolchain weight.
- **Package importing from `~/` or `~~/`.** Nuxt-coupled — doesn't belong in a package. Move the Nuxt-coupled bits out, leave the pure logic.
- **Single-consumer "future reuse" package.** Premature; pay the toolchain cost when the second consumer arrives. Until then, `shared/` or a server module suffices.
- **Auto-import-flavoured package**: a package that assumes Nuxt's auto-imports (`ref`, `computed` without explicit imports). Packages live outside Nuxt's auto-import scope; explicit imports only.

## Testing strategy: replace, don't layer

Old unit tests on shallow composables/plugins/handlers become waste once tests at the deepened module's interface exist — delete them. Write new tests at the interface:

- **Nuxt modules/layers**: `@nuxt/test-utils` against a fixture consuming representative options.
- **Composables**: mounted component when SSR/client behaviour matters; plain function call when it doesn't.
- **Server modules behind handlers**: test the module directly; the handler is a thin adapter.
