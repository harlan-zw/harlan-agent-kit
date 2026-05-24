# Nuxt-Native Seams

Catalogue of Nuxt's framework-native seams. When proposing a deepening, name the seam from this list and explain why it's the right shape (see SKILL.md "Prefer Nuxt-native seams" for why).

Nuxt also exposes many **primitives** — `useState`, `useCookie`, `useHead`, `useAsyncData`, `useFetch`, `definePageMeta`, `defineTask`, `<ClientOnly>`, `createError`/`showError`, etc. These are *not* seams: they have a single implementation and no varying adapters. They are the building blocks composed *inside* a deep module's implementation. Don't propose "deepening" a primitive; propose a module that uses it.

## Seam catalogue

### Nuxt module (`modules/foo.ts`, `defineNuxtModule`)

The deepest seam Nuxt offers. Takes an options object; registers plugins, composables (`addImports`), components (`addComponent`), server handlers (`addServerHandler`), nitro plugins (`addServerPlugin`), build steps, and hooks. Hides a cluster of plugins + composables + server routes behind a single typed options surface.

- **When**: a feature spans `app/` + `server/` + config and currently lives as 3+ files glued together.
- **Interface**: the options type + the hooks the module exposes for downstream layers/modules.
- **Test surface**: `@nuxt/test-utils` against a fixture that consumes the module with representative options.
- **Deepening signal**: the same feature is wired by hand in every consuming app/layer.

### Nuxt layer (`layers/billing/`, `extends` in `nuxt.config.ts`)

A directory that *is* a Nuxt project, merged into the host. Pages, components, plugins, server routes, config — all overlay-able. A layer is the right seam when a feature is a **whole vertical** (UI + composables + server) that can be developed and tested as its own app.

- **When**: a feature is a self-contained product surface (billing, admin, marketing site) and would benefit from being runnable in isolation.
- **Interface**: the layer's public components, composables, pages, and any hooks/options it documents.
- **Test surface**: run the layer as its own Nuxt app via `@nuxt/test-utils`.
- **Deepening signal**: cross-cutting feature folders that import from each other in tangled ways and could instead live as separate layers with explicit overrides.
- **Schema + migrations**: a layer can own its own DB tables and migration files (Laravel-package-style) — see [NITRO-CONVENTIONS.md](NITRO-CONVENTIONS.md) §9 for the host-orchestrated runner that makes per-layer migrations work with Drizzle.
- **Default: disable auto-import scanning at the layer boundary.** A new layer's `nuxt.config.ts` should ship with `components: []` and `imports: { dirs: [] }`. Layers are merged into the host's global auto-import registry by default, which silently leaks every `components/`, `composables/`, and `utils/` file into the consuming app — readers can't tell which layer a symbol came from, two layers with the same filename collide, and the layer stops being a vertical with a chosen public surface. Force the author to opt back in (per-dir, prefixed) for anything intended as public surface; everything else stays internal and gets reached via explicit `#layers/<name>/...` imports. Cross-layer auto-import is also covered as a smell at line 144 below — this rule is the setup-time prevention.

```ts
// layers/billing/nuxt.config.ts — start here, opt back in deliberately
export default defineNuxtConfig({
  components: [], // no global component auto-registration
  imports: { dirs: [] }, // no global composable/util auto-import
})
```

### Nuxt hook (`nuxt.hook('app:created', ...)`, `nitro.hook(...)`)

A named callback registry the framework already drives. Use as the seam when you want **multiple** participants to react to a lifecycle event without knowing about each other. Build hooks (`build:*`, `pages:extend`, `components:extend`), runtime app hooks (`app:created`, `app:mounted`, `page:start`, `page:finish`), and nitro hooks (`render:html`, `request`, `beforeResponse`).

- **When**: more than one piece of code reacts to the same lifecycle event, or you want to expose extension to downstream modules/layers.
- **Interface**: the hook name + payload + ordering guarantees.
- **Adapters**: each listener is an adapter at this seam.
- **Anti-pattern**: inventing a `useEventBus` or custom emitter when a Nuxt or nitro hook already exists.

### Plugin (`plugins/auth.ts`, `plugins/foo.client.ts`, `plugins/bar.server.ts`)

Runtime injection at app boot. The seam for "make X available everywhere as `useNuxtApp().$x`" or `inject('x', ...)`. The `.client`/`.server` suffix is itself a seam: same interface, different adapter per environment.

- **When**: a singleton runtime dependency must be available to composables and components.
- **Interface**: the injected key + its typed shape.
- **Two-adapter test**: a `.client` and `.server` variant is a real seam; a single plugin file is hypothetical.
- **Deepening signal**: many plugins each providing one tiny `$thing` — collapse into a module that registers them under one feature.

### Composable (`composables/useFoo.ts`, `addImports`)

The auto-imported seam for component-side state and behaviour. A composable's interface is its returned object — keep it small; deep composables compose internal helpers but don't expose them.

- **When**: components need shared reactive state or behaviour.
- **Interface**: the returned shape + SSR/client behaviour + which `useState` keys it owns.
- **Deepening signal**: a composable that just wraps a `ref` or a single `useState` is shallow — inline it, or merge with adjacent composables until the interface earns its keep.
- **Scope is part of the interface.** A composable placed at `composables/useFoo.ts` (or anywhere in `imports.dirs`) is **global**: every component, page, and other composable in the app graph can call it without an import, and the name lives in a flat app-wide namespace. Treat that as a commitment. Default new extractions to **feature-local + `_`-prefixed** (e.g. `composables/checkout/_useCartTotals.ts`) or to a `_internal/` sibling dir; promote to global only when ≥2 unrelated features call it and the name is unambiguous. See §"Internal vs global scope" below.

### Server route / handler (`server/api/x.post.ts`, `defineEventHandler`)

The HTTP seam. The handler is an adapter; the interface is the request/response contract. Keep handlers thin — they should call into a deep server-side module, not embed business logic.

- **When**: client needs to talk to the server.
- **Interface**: the URL + method + request schema + response schema + auth requirements.
- **Deepening signal**: business logic embedded directly in handlers, repeated across handlers.

### Nitro plugin (`server/plugins/foo.ts`)

Server-side equivalent of a Nuxt plugin. Runs once per server start. Seam for cross-cutting server concerns (logging, metrics, hook listeners on `nitro` hooks).

- **When**: server-wide setup or hook subscription.
- **Interface**: which nitro hooks it attaches to, what it mutates on the event context.

### Server middleware (`server/middleware/auth.ts`)

Per-request seam on the server. Runs before handlers; can mutate `event.context`. The seam for cross-cutting per-request concerns (auth, request IDs, tenancy).

- **When**: every server request must pass through some logic.
- **Interface**: what it reads from the request, what it writes onto `event.context`.

### `runtimeConfig` / `appConfig`

The seam between build-time config and runtime values. `runtimeConfig` is for env-injectable secrets and per-environment values; `appConfig` is for build-frozen, type-safe app constants. Confusing the two is a frequent source of friction.

- **When**: a value must be configurable at runtime (`runtimeConfig`) or compile-time (`appConfig`).
- **Interface**: the typed shape declared in `nuxt.config.ts`.
- **Deepening signal**: env vars read directly via `process.env` scattered across the codebase — pull them through `runtimeConfig`.

### Component (`components/`, `addComponent`)

Auto-imported component seam. The slot + props + emits surface is the interface. A deep component takes a small props shape and renders a coordinated piece of UI; a shallow one is a one-liner around a primitive.

**Scope is part of the interface.** Like composables, a component placed in a scanned `components/` dir is **global** by default: every template in the app can use `<Foo />` without an import, and the name lives in a flat namespace (with optional `pathPrefix`-derived prefixes). Default child/extracted components to **feature-local + `_`-prefixed** (`components/checkout/_LineItemRow.vue`) or to a `_internal/` sibling dir; promote to the global surface only at ≥2 unrelated callers. See §"Internal vs global scope" below.

### Route middleware (`middleware/auth.ts`, `definePageMeta({ middleware })`)

The **app-side** route guard seam (nuxt server + client). Distinct from `server/middleware/` (per-request, nitro scope). Three flavours: global (`middleware/auth.global.ts`, runs on every nav), named (opted into via `definePageMeta`), and inline (defined in `definePageMeta({ middleware: [...] })`). Interface: the `(to, from)` signature plus the navigation-result return shape (`navigateTo`, `abortNavigation`, `false`).

- **Anti-pattern**: an `onMounted` redirect inside a page component instead of route middleware.

### Layout (`layouts/default.vue`, `<NuxtLayout name="...">`)

The wrapper seam for pages. The layout's `<slot />` is the seam: pages render into the layout. Named slots (`<slot name="header" />`) are sub-seams. The interface is the layout name + named-slot contract. One layout is hypothetical; two layouts swapped via `definePageMeta({ layout })` is a real seam.

### Error UI (`error.vue`, `useError`, `showError`, `clearError`)

The error-rendering seam. `error.vue` at the project root is the adapter; `showError` / a thrown error in SSR is how application code crosses into it. Interface: the `NuxtError` shape (`statusCode`, `statusMessage`, `data`, `fatal`). One global handler — give it a typed shape and route everything through it.

### `shared/` directory

The **cross-scope shared-code seam** — the only place a single module may be imported by both runtime graphs. For types, pure validators, schemas, branded-ID utils, constants. Nuxt forbids importing Vue or Nitro code here.

**Auto-import is narrow** (Nuxt ≥3.14): only flat `shared/utils/*` and `shared/types/*` auto-import into both graphs. Nested subdirs don't auto-import unless added to `imports.dirs` *and* `nitro.imports.dirs`. Everything else uses the `#shared/*` alias (e.g. `import { x } from '#shared/schemas/order'`).

**No import-time side effects.** Pure declarations only — no top-level `console.*`, listener registration, env reads, `$fetch`, or singleton construction. Side effects fire in every consumer graph and break treeshaking. Mark `"sideEffects": false`.

For logic reused across multiple consumers or needing its own tests, promote to a `packages/*` workspace package instead — see [DEEPENING.md](DEEPENING.md) "The seam ladder for non-framework code."

- **Anti-pattern**: `types/` imported from both `server/` and `composables/` — move to `shared/types/`.
- **Anti-pattern**: a `shared/` module running work at import — move into an exported function or a plugin/hook.
- **Anti-pattern**: dropping a util into `shared/lib/` or `shared/utils/foo/bar.ts` expecting auto-import. Either flatten into `shared/utils/*`, import via `#shared/...`, or extend `imports.dirs` + `nitro.imports.dirs`.
- **Anti-pattern**: importing Vue or Nitro APIs from `shared/` — belongs in `composables/` or `server/utils/`.

### Nitro storage (`useStorage()`, `useStorage('redis')`, `:my-mount`)

The KV-storage **ports-and-adapters** seam built into nitro via `unstorage`. Interface: `getItem` / `setItem` / `hasItem` / `removeItem` / `getKeys`, optional TTL. Adapters: memory, fs, redis, cloudflare-kv, vercel-kv, s3, etc. — selected via `nitro.storage` and `nitro.devStorage`. **Two adapters by default** (in-memory in tests, redis in prod): a real seam by construction. Reach for this before writing your own KV abstraction.

### Nitro cache (`defineCachedFunction`, `defineCachedEventHandler`, `cachedEventHandler`)

The function/handler memoisation seam. Wraps any nitro-side function or handler with a typed cache key, TTL, and stale-while-revalidate. Backed by `useStorage('cache')` — same adapter story as storage. Interface: the cache options (`maxAge`, `staleMaxAge`, `swr`, `getKey`, `varies`).

### Route rules (`routeRules` in `nuxt.config.ts`, `defineRouteRules` in a page)

The declarative per-route rendering/caching/headers/redirect seam. Replaces hand-rolled middleware for: `prerender`, `ssr`, `isr`, `swr`, `cache`, `headers`, `cors`, `redirect`, `proxy`, `noScripts`, `appMiddleware`. Match by glob (`/blog/**`). **Reach for route rules before reaching for runtime code** — declarative caching/redirects are easier to audit, easier to override per layer, and free at the edge.

### Server component / `<NuxtIsland>` (`components/MyThing.server.vue`)

The server-rendered island seam. Component renders on the server only; client receives HTML and (optionally) lazy-rehydrated props. Interface: serialisable props + named slots. Use when you want server-side data fetching co-located with markup and no client JS for that island.

### `app/router.options.ts`

The vue-router customisation seam: history mode, scroll behaviour, custom routes. Build-time. Interface: the `RouterConfig` shape. Pair with the `pages:extend` hook for programmatic route mutation.

### Auto-import scoping (`utils/`, `server/utils/`, `composables/`, `shared/utils/`, `shared/types/`, `imports.dirs`)

The **naming seam** for auto-discovered exports, and a *scope-enforcer*: `utils/` and `composables/` auto-import into the app graph; `server/utils/` into nitro only; `shared/utils/` and `shared/types/` into *both* (Nuxt ≥3.14). Nested subdirs aren't scanned — extend `imports.dirs` / `nitro.imports.dirs` to opt in. Directory choice is the scope decision.

**Don't rely on auto-import across scopes or layers.** When an import crosses `shared/` ↔ `server/` ↔ `app/` or a layer boundary, write it explicitly (`#shared/...`, `#layers/...`, or a relative path). Auto-import is invisible (reader can't tell which layer/scope `parseOrder()` came from), order-sensitive across layer overrides, and the scopes have separate module graphs (same name may resolve to different implementations server vs client). Auto-import is fine *within* a single scope for obvious cases.

### Type-level seam (TypeScript module augmentation)

A typed seam is a real seam; an untyped one is a wishful one. The interface of a Nuxt module/plugin/middleware almost always involves an augmentation:

- `declare module '#app' { interface NuxtApp { $foo: Foo } }` — types for `provide`/`inject`.
- `declare module 'h3' { interface H3EventContext { user?: User } }` — types for the nitro→nuxt-server seam (the `event.context` interface).
- `declare module 'nuxt/schema' { interface RuntimeConfig { ... }, interface PublicRuntimeConfig { ... }, interface AppConfig { ... } }` — types for `runtimeConfig` and `appConfig`.
- `declare module 'vue-router' { interface PageMeta { ... } }` — types for custom `definePageMeta` keys.
- `declare module '#app' { interface RuntimeNuxtHooks { 'foo:bar': (x: X) => void } }` — types for custom runtime hooks.

When you propose a deepening that introduces or relies on one of these seams, the augmentation is **part of the interface** — list it explicitly in the candidate.

## Internal vs global scope

Auto-import makes every file in `components/`, `composables/`, `utils/`, `server/utils/` **global by default** — flat namespace, app-wide rename blast radius. Most extractions don't deserve that. Default internal; promote on evidence.

- **Default**: feature-local, colocated with consumer, `_`-prefixed (`components/checkout/_LineItemRow.vue`, `composables/checkout/_useCartTotals.ts`) or under `_internal/` when ≥3 internals share a feature. Imported by relative path inside the feature.
- **Promote to global** only when `scan --tsconfig .nuxt/tsconfig.json` shows callers in **≥2 unrelated feature dirs** AND the name reads unambiguously in all of them.
- **Reuse within one feature** justifies a feature-local shared file, not promotion.

One-time `nuxt.config.ts` setup so Nuxt skips `_`-prefixed paths:

```ts
export default defineNuxtConfig({
  ignore: ['**/_*/**', '**/_*.{ts,vue}'],
  components: [{ path: '~/components', pathPrefix: false, ignore: ['**/_*/**', '**/_*'] }],
})
```

**Promotion checklist**: ≥2 unrelated feature consumers (cited via `scan`), unambiguous global name, explicit typed contract, locality win on deletion. Missing any → keep internal.

**Anti-patterns**: `composables/useX.ts` with one caller (inline or move to `_`-prefixed feature dir); `components/<Feature><Thing>.vue` used only by that feature (move to `components/<feature>/_Thing.vue`); cross-feature import of an `_`-prefixed internal (contract violated — either promote or move consumer).

## Scope boundaries (the three runtimes)

A Nuxt app contains **three distinct runtime scopes**. They do not share a module graph. Code in one scope **cannot import** from another — the seam between them is a routing protocol, not a function call. Naming the scope is a prerequisite to naming the seam.

| Scope           | Where it runs                  | Files                                                                                                                                |
| --------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Nitro**       | Server, framework-level (h3)   | `server/plugins/`, `server/middleware/`, `server/routes/`, `server/api/` handler shell, nitro hooks                                  |
| **Nuxt server** | Server, app-level (during SSR) | `app.vue`, `pages/`, `components/`, `composables/`, `plugins/*.server.ts`, `plugins/*.ts` (isomorphic) when executed on the server    |
| **Nuxt client** | Browser, app-level             | Same app files as above, executed in the browser; `plugins/*.client.ts`                                                              |

### The hard rule: no cross-scope imports

- Nitro code **must not** import from `composables/`, `app/`, `pages/`, `components/`, or anything in the Nuxt app graph.
- Nuxt server code **must not** import from `server/` (no reaching across the seam to a handler's internals).
- Nuxt client code is the same module graph as Nuxt server — split behaviour with `import.meta.client` / `import.meta.server`, not by importing across the wire.

If you find a cross-scope import, it is **always** a shallowness signal: the boundary has been smuggled past instead of crossed through the proper seam.

The one sanctioned exception is the **`shared/` directory** (see the seam catalogue): pure types, schemas, and IO-free utilities can be imported by both runtime graphs because `shared/` belongs to *neither* scope. Anything with framework calls or runtime IO does not belong there.

### How scopes talk to each other

Each pair has exactly one supported seam:

- **Nitro → Nuxt server**: the h3 event context. Nitro sets `event.context.foo = ...`; Nuxt server reads via `useRequestEvent()?.context.foo`. The **shape of `event.context`** is the interface — augment `H3EventContext`, never untyped.
- **Nuxt server → Nuxt client**: `useState(key, init)`, `useAsyncData(key, fn)`, `useFetch(url)`. State key + typed shape is the interface. Never module-level singletons (don't cross the wire) or `window` globals.
- **Nuxt client → Nuxt server**: HTTP only (`$fetch` / `useFetch` to `server/api/*`). The route is the seam.
- **App → Nitro at boot**: a Nuxt module via `addServerPlugin` (module options are the seam, not a runtime call).

When proposing a candidate, state which scopes it spans and which seams carry data between them.

## Cross-cutting: build-time vs runtime

Every Nuxt seam sits on one side of this line. State it explicitly when proposing a deepening:

- **Build-time**: module setup, `addImports`, `addServerHandler`, `pages:extend`. Code runs once when Nuxt builds.
- **Runtime, server**: nitro plugins, server middleware, server routes, `nuxt.hook('app:created')` on the server side.
- **Runtime, client**: `.client` plugins, composables, components, `app:mounted`.
- **Both**: isomorphic plugins, composables that branch on `import.meta.server`/`import.meta.client`.

A common shallow pattern is a module that *should* be wiring at build time but instead pushes the work into a runtime plugin — usually because the author didn't reach for `addImports`/`addServerHandler`. Flag this when you see it.

## Anti-patterns (shallow shapes to flag)

- **Plugin-per-value**: ten plugins each doing `nuxtApp.provide('x', ...)`. Collapse into one module + one plugin, or replace with composables.
- **Composable-as-getter**: `useFoo()` that returns a single `useState` ref. Either inline at call sites or grow the composable to own real behaviour.
- **Logic in `<script setup>`**: multiple refs, watchers, async functions inline in a page or component. Untestable without mounting. Extract to a service composable (factory + `provide`/`use` pair). See [VUE-CONVENTIONS.md](VUE-CONVENTIONS.md) §1.
- **Hand-rolled DI container**: a `services/` folder with a registry parallel to plugins + `provide`/`inject`.
- **Custom event bus**: `mitt`/`EventEmitter` for app-wide events when a Nuxt or nitro hook would do.
- **Hand-rolled KV** (a `Map` + serialisation, custom Redis wrapper) when nitro storage (`useStorage`) already gives a typed ports-and-adapters interface.
- **Per-handler cache wrappers** (manual `if (cache.has(key))`) when `defineCachedEventHandler` / `defineCachedFunction` exist.
- **Custom cron runner** instead of nitro tasks (`defineTask` + `nitro.scheduledTasks`).
- **Server logic in handlers**: `server/api/*.ts` files containing DB calls, validation, and business rules inline. Pull into a deep server module; the handler becomes an adapter. (See [NITRO-CONVENTIONS.md](NITRO-CONVENTIONS.md) §1 validators, §2 policies, §3 presenters for the routine decomposition.)
- **Layer that's just a folder**: `layers/foo` with no `nuxt.config.ts` and no public surface.
- **Module with no options**: `defineNuxtModule()` taking no input and exposing no hooks rarely earns the indirection over a plain plugin.
- **`process.env` reads outside `runtimeConfig`**: bypasses Nuxt's config seam.
- **Mixing `appConfig` and `runtimeConfig`**: signals the author hasn't decided which side of the build/runtime line a value lives on.
- **Runtime caching/redirect logic that should be route rules**: prerender flags, SWR/ISR, custom headers, simple redirects belong in `routeRules`, not in middleware.
- **`onMounted` redirects** instead of route middleware: page chrome flashes before the redirect; route middleware is the correct seam.
- **Server-fetched markup re-fetched on the client** instead of a server component (`<NuxtIsland>` / `*.server.vue`).
- **Cross-scope type imports**: a `types/` folder imported from both `server/` and `composables/`. Move to `shared/` — the seam the cross-scope import rule reserves.
- **Untyped `nuxtApp.provide` / `event.context.foo = ...`**: the seam exists but its interface is missing. Augment `NuxtApp` / `H3EventContext`.
- **Prop-drilling page chrome**: a page mutating its layout via emits/props instead of using `definePageMeta({ layout })` plus a layout slot.

## How to name the seam in a candidate

When presenting a deepening candidate, lead with the seam:

> *"Promote `composables/useBilling.ts` + `plugins/billing.ts` + `server/api/billing/*` into a Nuxt module `modules/billing.ts`. The module options become the interface (`{ provider, currency, webhookSecret }`); the existing files become its private implementation, registered via `addImports`/`addServerHandler`. Add a `billing:charge` hook so a downstream layer can observe charges without patching the module."*

Name the seam (Nuxt module), state the interface (options + hook), describe what becomes private (the now-internal files), and note the adapter story (downstream layer as second adapter on the hook).
