# Deepening (TS Package)

How to deepen a cluster of shallow modules safely in a TypeScript package. Assumes the vocabulary in [LANGUAGE.md](LANGUAGE.md) — **module**, **interface**, **seam**, **adapter** — and the seam catalogue in [TS-PKG-SEAMS.md](TS-PKG-SEAMS.md).

## Dependency categories

When assessing a candidate for deepening, classify its dependencies. The category determines how the deepened module is tested across its seam.

### 1. In-process

Pure computation, in-memory state, no I/O. Always deepenable — merge the modules and test through the new factory's interface directly. No adapter needed.

In a TS package: parsers, formatters, validators, reducers, AST walkers, schema transforms. Lift into a plain factory or pure function; tests instantiate and assert.

### 2. Local-substitutable

Dependencies that have local test stand-ins (PGLite for Postgres, `memfs` or `unstorage` `memory` driver for filesystem, MSW for HTTP). Deepenable if the stand-in exists. The deepened module is tested with the stand-in wired via options.

In a TS package: filesystem access through `unstorage` (swap `fs` driver for `memory`), HTTP through `ofetch` mocked with MSW, DB via a port that defaults to the real driver and accepts an in-memory adapter in tests.

### 3. Remote but owned (Ports & Adapters)

Your own services across a network boundary (a public API your package calls, a worker queue). Define a **port** (interface) in the package. The deep factory owns the logic; the transport is injected as an **adapter** via options. Tests use an in-memory adapter; production uses the HTTP/queue adapter.

Recommendation shape: *"Define a port as the factory's `transport` option (typed `interface Transport { send(msg: Msg): Promise<Ack> }`), implement an `ofetch` adapter for production and an in-memory adapter for testing, so the logic sits in one deep factory even though the transport crosses the network."*

### 4. True external (Mock)

Third-party SDKs (Stripe, Twilio, OpenAI, AWS clients) you don't control. The deepened factory takes the SDK client as an option (with a sensible default constructing the real one). Tests pass a fake.

In a TS package: `createBillingClient({ stripe = new Stripe(secret), hooks })` — production uses the default, tests pass a stub. Hooks let consumers observe (`'charge:before'`, `'charge:after'`) without coupling to the SDK.

## TS-pkg seam discipline

- **Internal seams vs external seams.** A deep factory can have internal seams (private modules under `src/<feature>/`, internal hooks used by its own tests) as well as the external seam at its options + return type + public hooks + subpath. Don't expose internal seams through options just because tests use them.
- **Build-time vs runtime is itself a seam.** Decide once per concept. Mixing them (runtime code reading `package.json` for its own config; build script importing the runtime factory) is a shallowness signal.
- **Runtime portability is part of the interface.** If a deep file imports `node:fs` and breaks workerd, that split *is* part of the interface — document via conditional exports or fix the import.

## The seam ladder

Three seams in increasing strength (default to the lowest that works); see the full catalogue and selection table in [TS-PKG-SEAMS.md](TS-PKG-SEAMS.md):

1. **`src/<feature>/index.ts`** — private internal module. No publishable change.
2. **Subpath in `exports` map** — SemVer-visible public concept.
3. **Workspace `packages/*`** — separate published unit. Earns its keep with ≥2 independent consumers, zero host coupling (no `~/`, `#imports`, host config), and a distinct test or release story.

## Testing strategy

- Test at the deepened module's interface (factory return, subpath import, `defineCommand` value via `main.run({ rawArgs })`). The interface is the test surface.
- Delete old unit tests on now-shallow modules once interface tests exist.
- A test that reaches into `src/internal/` is testing past the seam.
