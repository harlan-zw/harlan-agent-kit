# Language

Shared vocabulary for every suggestion this skill makes. Use these terms exactly — don't substitute "component," "service," "API," or "boundary." Consistent language is the whole point.

For Nuxt-flavoured seam vocabulary (module, layer, plugin, composable, hook, nitro plugin), see [NUXT-SEAMS.md](NUXT-SEAMS.md). The terms below are framework-agnostic and apply equally to a Vue composable, a Nuxt module, or a nitro handler.

## Terms

**Module**
Anything with an interface and an implementation. Deliberately scale-agnostic — applies equally to a function, a Vue composable, a Nuxt plugin, a Nuxt module, a layer, or a tier-spanning slice.
_Avoid_: unit, component, service.

**Interface**
Everything a caller must know to use the module correctly. Includes the type signature, but also invariants, ordering constraints (plugin order, hook timing, SSR vs client), error modes, required configuration (`runtimeConfig`, module options), and performance characteristics.
_Avoid_: API, signature (too narrow — those refer only to the type-level surface).

**Implementation**
What's inside a module — its body of code. Distinct from **Adapter**: a thing can be a small adapter with a large implementation (a Postgres repo behind a port) or a large adapter with a small implementation (an in-memory fake). Reach for "adapter" when the seam is the topic; "implementation" otherwise.

**Depth**
Leverage at the interface — the amount of behaviour a caller (or test) can exercise per unit of interface they have to learn. A module is **deep** when a large amount of behaviour sits behind a small interface (e.g. a Nuxt module that takes a 5-key options object and registers plugins, composables, server handlers, and hooks under the hood). A module is **shallow** when the interface is nearly as complex as the implementation (e.g. a composable that just re-exports a `ref`).

**Seam** _(from Michael Feathers)_
A place where you can alter behaviour without editing in that place. The *location* at which a module's interface lives. Choosing where to put the seam is its own design decision, distinct from what goes behind it. In Nuxt, seams often coincide with framework extension points (hooks, module options, layer overrides) — see [NUXT-SEAMS.md](NUXT-SEAMS.md).
_Avoid_: boundary (overloaded with DDD's bounded context).

**Adapter**
A concrete thing that satisfies an interface at a seam. Describes *role* (what slot it fills), not substance (what's inside). In Nuxt this is often a layer override, a hook implementation, or a plugin variant (`.client`/`.server`).

**Leverage**
What callers get from depth. More capability per unit of interface they have to learn. One implementation pays back across N call sites and M tests.

**Locality**
What maintainers get from depth. Change, bugs, knowledge, and verification concentrate at one place rather than spreading across `plugins/`, `composables/`, `server/`, and `nuxt.config.ts`. Fix once, fixed everywhere.

## Principles

- **Depth is a property of the interface, not the implementation.** A deep Nuxt module can be internally composed of small, mockable, swappable parts (private composables, internal hooks) — they just aren't part of the interface. A module can have **internal seams** (private to its implementation, used by its own tests) as well as the **external seam** at its interface (its options + the hooks it exposes).
- **The deletion test.** Imagine deleting the module. If complexity vanishes, the module wasn't hiding anything (it was a pass-through). If complexity reappears across N callers, the module was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. If you want to test *past* the interface, the module is probably the wrong shape. For Nuxt, this often means testing through `@nuxt/test-utils` against the module's options + hooks, not poking at internal composables.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a seam unless something actually varies across it. A Nuxt hook with one listener is a hypothetical seam; with two (e.g. core + a layer override), it's real.
- **Prefer Nuxt-native seams.** If Nuxt already gives you a seam (a hook, a layer, a module option, `runtimeConfig`), use it before inventing a parallel mechanism.

## Rejected framings

- **Depth as ratio of impl-lines to interface-lines** (Ousterhout): rewards padding the implementation. Use depth-as-leverage.
- **"Interface" as just a TS `interface` or class methods**: too narrow.
- **"Boundary"**: collides with DDD's bounded context. Say **seam**.
- **"Service" / "Manager" / "Handler"**: framework-agnostic mush. Name the Nuxt shape.
