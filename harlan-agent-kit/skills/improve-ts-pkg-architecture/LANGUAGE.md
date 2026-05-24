# Language

Shared vocabulary for every suggestion this skill makes. Use these terms exactly — don't substitute "component," "service," "API," or "boundary." Consistent language is the whole point.

For TS-package-flavoured seam vocabulary (`exports` map, subpath, conditional export, workspace package, factory, hook bus, plugin), see [TS-PKG-SEAMS.md](TS-PKG-SEAMS.md). The terms below are framework-agnostic and apply equally to a function, a factory, or a published subpath.

## Terms

**Module**
Anything with an interface and an implementation. Deliberately scale-agnostic — applies equally to a function, a file, a factory, a subpath export, or a workspace package.
_Avoid_: unit, component, service.

**Interface**
Everything a caller must know to use the module correctly. Includes the type signature, but also invariants, ordering constraints (hook order, lifecycle, init vs run), error modes, required configuration, runtime conditions (node / browser / edge), and treeshake/side-effect contract.
_Avoid_: API, signature (too narrow — those refer only to the type-level surface).

**Implementation**
What's inside a module — its body of code. Distinct from **Adapter**: a thing can be a small adapter with a large implementation (a Postgres repo behind a port) or a large adapter with a small implementation (an in-memory fake). Reach for "adapter" when the seam is the topic; "implementation" otherwise.

**Depth**
Leverage at the interface — the amount of behaviour a caller (or test) can exercise per unit of interface they have to learn. A module is **deep** when a large amount of behaviour sits behind a small interface (e.g. a `createPipeline(opts)` factory that takes a 4-key options object and exposes a hook bus, returning a pipeline with `run`/`stop`/`hooks`). A module is **shallow** when the interface is nearly as complex as the implementation (e.g. a file that just re-exports one function, or a factory whose options are 1:1 with private internals).

**Seam** _(from Michael Feathers)_
A place where you can alter behaviour without editing in that place. The *location* at which a module's interface lives. Choosing where to put the seam is its own design decision, distinct from what goes behind it. In a TS package, seams often coincide with the publishable surface (subpath/conditional exports, workspace package boundary, factory options, hook bus). See [TS-PKG-SEAMS.md](TS-PKG-SEAMS.md).
_Avoid_: boundary (overloaded with DDD's bounded context).

**Adapter**
A concrete thing that satisfies an interface at a seam. Describes *role* (what slot it fills), not substance (what's inside). In a TS package this is often a hook listener, a runtime-conditional export (`node` vs `browser`), or a plugin variant.

**Leverage**
What callers get from depth. More capability per unit of interface they have to learn. One implementation pays back across N call sites and M tests.

**Locality**
What maintainers get from depth. Change, bugs, knowledge, and verification concentrate at one place rather than spreading across `src/`, `packages/*`, and `package.json`. Fix once, fixed everywhere.

## Principles

- **Depth is a property of the interface, not the implementation.** A deep factory can be internally composed of small, mockable, swappable parts (private modules, internal hooks) — they just aren't part of the interface. A module can have **internal seams** (private to its implementation, used by its own tests) as well as the **external seam** at its interface (its options + the hooks it exposes + the subpath at which it's reachable).
- **The deletion test.** Imagine deleting the module. If complexity vanishes, the module wasn't hiding anything (it was a pass-through). If complexity reappears across N callers, the module was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. If you want to test *past* the interface, the module is probably the wrong shape. For a TS package this often means importing the public subpath in tests and asserting behaviour, not reaching into `src/internal/`.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a seam unless something actually varies across it. A hook with one listener is a hypothetical seam; with two (e.g. an internal default + a consumer extension), it's real. A conditional export with only a `default` is hypothetical; pair it with a `browser` or `workerd` and the seam is justified.
- **No import-time side effects.** A module's top level should declare and export, not *do*. Importing it must not register listeners, mutate globals, kick off network or filesystem work, schedule timers, or read `process.env`. Side effects belong inside exported functions the caller invokes deliberately. This makes modules treeshakable, testable in isolation, safe to import from any runtime (node, browser, edge, workerd, bun), and honest about their `sideEffects: false` claim.
- **Functional over class-based.** Default to factories (`createX(opts)`) and plain functions. Classes only when truly stateful with multiple coordinated methods and a lifecycle the caller can't model as `{ run, stop }`. A class with one public method is a function in disguise; a class with multiple methods sharing no mutable state is several functions in disguise.
- **The `exports` map IS the interface.** Anything reachable through a declared subpath is contract; anything outside it is private and may move. A consumer reaching past the `exports` map (via deep `pkg/dist/internal/foo`) is using something that isn't theirs.
- **Prefer TS-pkg-native seams.** If the ecosystem already gives you a seam — subpath/conditional exports for runtime variation, `hookable` for plugin systems, `citty` for CLIs, `c12` for config, `unplugin` for build plugins — use it before inventing a parallel mechanism.

## Rejected framings

- **Depth as ratio of implementation-lines to interface-lines** (Ousterhout): rewards padding. We use depth-as-leverage.
- **"Service" / "Manager" / "Handler"**: framework-agnostic mush. Name the TS-pkg shape: factory, hook bus, subpath export, workspace package, plugin.
