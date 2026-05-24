# Interface Design (Nuxt)

When the user wants to explore alternative interfaces for a chosen deepening candidate, use this parallel sub-agent pattern. Based on "Design It Twice" (Ousterhout) — your first idea is unlikely to be the best.

Uses the vocabulary in [LANGUAGE.md](LANGUAGE.md) — **module**, **interface**, **seam**, **adapter**, **leverage** — and the seam catalogue in [NUXT-SEAMS.md](NUXT-SEAMS.md).

## Two flavours of candidate

The design space depends on what kind of candidate the user picked:

- **Seam-shaped candidate** — the question is *which Nuxt seam should host the deepened module* (module vs layer vs composable + plugin vs ports & adapters). Use the four seam-anchored sub-agents below.
- **Convention-shaped candidate** — the user picked a missing convention (validator, policy, presenter, error handler, service composable, event registry, etc. from [NITRO-CONVENTIONS.md](NITRO-CONVENTIONS.md), [VUE-CONVENTIONS.md](VUE-CONVENTIONS.md), or [NUXT-APP-CONVENTIONS.md](NUXT-APP-CONVENTIONS.md)). The seam is already chosen by the convention. The design space is the convention's *interface shape* — what's in the typed object the rest of the codebase depends on. See "Convention-shaped sub-agents" below.

## Process

### 1. Frame the problem space

Write a user-facing explanation of the problem space before spawning sub-agents:

- Constraints any new interface must satisfy (SSR/client, build vs runtime, public vs private exports, layer override, hook ordering)
- Dependencies and category (see [DEEPENING.md](DEEPENING.md))
- An illustrative code sketch (a `nuxt.config.ts` snippet, a composable usage line) — to ground constraints, not propose

Then proceed to Step 2 immediately; sub-agents work in parallel while the user reads.

### 2. Spawn sub-agents

#### Seam-shaped sub-agents

Spawn 4 sub-agents in parallel using the Agent tool. Each must produce a **radically different** interface for the deepened module, anchored in a different Nuxt seam from [NUXT-SEAMS.md](NUXT-SEAMS.md).

Prompt each sub-agent with a separate technical brief (file paths, coupling details, dependency category from [DEEPENING.md](DEEPENING.md), what sits behind the seam). The brief is independent of the user-facing problem-space explanation in Step 1. Give each agent a different Nuxt-shaped design constraint:

- **Agent 1 — Module-shaped**: "Design as a single Nuxt module (`defineNuxtModule`). Minimise the options surface — aim for 3–5 keys. Maximise leverage per option. Use `addImports`/`addServerHandler` to wire the existing files as private implementation. Expose at most two hooks for downstream extension."
- **Agent 2 — Composable + plugin pair**: "Design as one or two composables backed by a single plugin. Optimise for caller ergonomics — the most common use case should be a one-liner. Keep the plugin's `provide` private; the composable is the public seam."
- **Agent 3 — Layer-shaped**: "Design as a Nuxt layer that hosts the feature as a self-contained vertical. Define the layer's public surface (components, composables, pages it exposes) and its override points (hooks, slots, named components). Optimise for the case where another app extends and partially overrides this layer."
- **Agent 4 — Ports & adapters**: "Design around an explicit port at the seam, with at least two adapters (production + test). Use `runtimeConfig` or a module option to choose the adapter. Optimise for testability and for swapping providers."

#### Convention-shaped sub-agents

Spawn 3 sub-agents, each designing a different *interface shape* for the chosen convention. Examples by convention type:

- **Validator** (NITRO-CONVENTIONS.md §1): Agent A returns a function `(event) => parsed | throws`; Agent B returns a tuple `[parse, schema]` for reuse on the client; Agent C returns an object `{ parse, partial, openApiSchema }` to drive docs + client + server from one definition.
- **Policy** (NITRO-CONVENTIONS.md §2 / NUXT-APP-CONVENTIONS.md §2): Agent A is a pure predicate `(user, resource) => boolean`; Agent B is a method-on-resource `post.canBe('updated', user)`; Agent C is a registry `defineAbility(user).can('update', post)`.
- **Service composable** (VUE-CONVENTIONS.md §1): Agent A is the factory + provide + use triplet; Agent B is a class wrapped in `reactive()`; Agent C is a single composable that auto-detects scope (returns existing instance if already provided, else creates one).
- **Error handling** (NITRO-CONVENTIONS.md §4): Agent A is a `DomainError` hierarchy + handler wrapper; Agent B is `Result<T, E>` returns from server modules; Agent C is a tagged-union error object passed through `event.context.error`.

Each sub-agent's brief includes the convention file's "Gap" + "Seam" entries plus the constraints from Step 1.

Include [LANGUAGE.md](LANGUAGE.md) vocabulary, [NUXT-SEAMS.md](NUXT-SEAMS.md) vocabulary, the relevant convention file, and CONTEXT.md vocabulary in each brief so every sub-agent names things consistently.

Each sub-agent outputs:

1. Interface (Nuxt module options / composable return shape / layer public surface / port type — plus invariants, ordering, error modes, SSR/client behaviour)
2. Usage example showing how callers use it (with realistic Nuxt file paths)
3. What the implementation hides behind the seam (which existing files become private, which hooks fire when)
4. Dependency strategy and adapters (see [DEEPENING.md](DEEPENING.md))
5. Trade-offs — where leverage is high, where it's thin, what's awkward to test, what's awkward to extend

### 3. Present and compare

Present designs sequentially so the user can absorb each one, then compare them in prose. Contrast by **depth** (leverage at the interface), **locality** (where change concentrates), **seam placement** (which Nuxt extension point carries the interface), and **build-time vs runtime split**.

After comparing, give your own recommendation: which design you think is strongest and why. If elements from different designs would combine well, propose a hybrid (e.g. *"Agent 1's module shape with Agent 4's port for the third-party adapter"*). Be opinionated — the user wants a strong read, not a menu.
