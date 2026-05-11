# Nuxt App Conventions

The Nuxt-specific layer of the app-side conventions. The framework-agnostic Vue patterns it builds on (service composables, factory + provide + use, component thinness, per-component vs per-subtree state) live in [VUE-CONVENTIONS.md](VUE-CONVENTIONS.md). Read that first; this file only covers what's specific to Nuxt.

> **These are deepening candidates, not unconditional rules.** Surface them during the Explore phase ([SKILL.md](SKILL.md) §1); walk the design tree in the grilling loop ([SKILL.md](SKILL.md) §3); accept rejections with load-bearing reasons via ADR. Each section names the **interface** at the seam (in [LANGUAGE.md](LANGUAGE.md) terms); reach for the dependency category from [DEEPENING.md](DEEPENING.md) when designing the test strategy for the deepened module.

What's Nuxt-specific:

- **Where to call `provide`** in a Nuxt app, and how SSR affects it.
- **`$fetch`, `useAsyncData`, `useFetch`** as the production port for service composables.
- **Cross-scope policies** that share predicates with the nitro server (mirroring NITRO-CONVENTIONS.md §2).
- **`useState` for SSR-safe app-wide state**, and how it composes with §1 service composables.

## 1. Wiring service composables into Nuxt

The factory + provide + use pattern from [VUE-CONVENTIONS.md](VUE-CONVENTIONS.md) §1 ports across as-is. The Nuxt-specific decisions are:

- **`$fetch` as the port.** Pass `(input) => $fetch(...)` into the `provide` wrapper. The factory stays pure; `$fetch` (auto-imported, ofetch under the hood) is supplied at the call site.
- **Where to call `provideX()`.** Three useful spots:
  - `app.vue` for app-wide services (current user, theme).
  - A layout's setup for layout-scoped services (admin chrome, dashboard sidebar state).
  - A page's setup for page-scoped services (one form, one wizard).
- **SSR safety.** `provide` runs once per SSR pass and once per client mount, so `provideX()` at the page level is SSR-safe. **Module-level singletons inside a factory leak between requests on the server** — never store feature state in a top-level `let` or `const ref()`. Always inside `createXxxService()`.

```ts
// composables/useOrderForm.ts
// (factory + use unchanged from VUE-CONVENTIONS.md §1)
export function provideOrderForm(initial?: Partial<OrderInput>) {
  const service = createOrderFormService({
    initial,
    submit: input => $fetch<Order>('/api/orders', { method: 'POST', body: input }),
  })
  provide(KEY, service)
  return service
}
```

## 2. Client policy mirror

**Gap.** A page renders a "Delete" button that calls `DELETE /api/posts/:id`, which 403s server-side. The user sees and clicks an action that was never available. Or the UI hides actions inconsistently because each component re-derives "can I?" in its own way.

**Seam.** The pure predicate from a server policy (NITRO-CONVENTIONS.md §2) lives in `shared/policies/`. The server's `authorize()` and the client's `useCanX()` composable both call the same predicate.

**Template.**

```ts
// shared/policies/post.ts
import type { Post, User } from '~~/shared/types'

export function canUpdatePost(user: User | null, post: Post): boolean {
  if (!user)
    return false
  return user.id === post.authorId || user.role === 'admin'
}

export function canDeletePost(user: User | null, _post: Post): boolean {
  return user?.role === 'admin'
}
```

```ts
import type { Post } from '~~/shared/types'
// composables/policies/post.ts
import { canDeletePost, canUpdatePost } from '~~/shared/policies/post'

export function useCanUpdatePost(post: MaybeRef<Post>) {
  const { user } = useCurrentUser()
  return computed(() => canUpdatePost(user.value, unref(post)))
}

export function useCanDeletePost(post: MaybeRef<Post>) {
  const { user } = useCurrentUser()
  return computed(() => canDeletePost(user.value, unref(post)))
}
```

```ts
// server/policies/post.ts (re-export — handlers import from here)
export { canDeletePost, canUpdatePost } from '~~/shared/policies/post'
```

One source of truth for "can X do Y." Authorization decisions are co-located, typed, and unit-testable as plain functions on both sides of the wire.

## 3. Async resource composables

**Gap.** `useAsyncData('posts', () => $fetch('/api/posts'))` repeated in five components, each with slightly different keys, params, transforms, or error handling. The remote resource has no canonical owner.

**Seam.** Wrap each remote resource in a typed composable that owns the fetch shape + key + transform. Components consume the composable; the resource is a one-line interface to them.

**Template.**

```ts
// composables/resources/usePost.ts
import type { Post } from '~~/shared/types'

export function usePost(id: MaybeRef<string>) {
  return useAsyncData(
    () => `post:${unref(id)}`,
    () => $fetch<Post>(`/api/posts/${unref(id)}`),
    { watch: [() => unref(id)] },
  )
}

export function usePostList(params?: MaybeRef<{ tag?: string }>) {
  return useAsyncData(
    () => `posts:${JSON.stringify(unref(params) ?? {})}`,
    () => $fetch<Post[]>('/api/posts', { query: unref(params) }),
    { watch: [() => JSON.stringify(unref(params) ?? {})] },
  )
}
```

For resources that need mutations + local cache invalidation + optimistic updates, **promote to a service composable** (VUE-CONVENTIONS.md §1) — the async resource becomes private to the service. The service exposes typed methods (`create`, `update`, `delete`); components call methods, not `$fetch`.

## 4. App-wide SSR-safe state (`useState` + service composable)

[VUE-CONVENTIONS.md](VUE-CONVENTIONS.md) §3 covers per-component and per-subtree scoping. Nuxt adds a third option:

- **App-wide, SSR-safe**: `useState(key, init)`. Serialised across the SSR boundary into the payload, replayed on hydration on the client. See NUXT-SEAMS.md "Scope boundaries" for what this seam carries between server and client.

**Composition rule.** When a service composable (VUE-CONVENTIONS.md §1) holds state that must outlive route changes and survive SSR (current user, theme, cart), inject the `useState` ref into the factory as a port — same shape as injecting `$fetch`:

```ts
// composables/useCurrentUser.ts — factory only; provide + use follow VUE-CONVENTIONS.md §1
export function createCurrentUserService(deps: {
  fetchMe: () => Promise<User | null>
  state: Ref<User | null> // useState seed, injected so tests pass a plain ref
}) {
  async function refresh() {
    deps.state.value = await deps.fetchMe()
  }
  return { user: deps.state, refresh }
}

export function provideCurrentUser() {
  const service = createCurrentUserService({
    state: useState<User | null>('currentUser', () => null),
    fetchMe: () => $fetch<User | null>('/api/me'),
  })
  // ... provide(KEY, service) — see VUE-CONVENTIONS.md §1
  return service
}
```

Tests pass `{ state: ref<User | null>(null), fetchMe: vi.fn() }` and unit-test without Nuxt at all.

**Common scope mistakes specific to Nuxt.**

- `useState` keys colliding across features (untyped global namespace). Treat keys as private to the owning service composable — one key per service, prefixed by the feature.
- A service composable's state stuffed into `useState` when it's actually subtree-scoped (form state, wizard state). That state then leaks across pages and SSR requests.
- `useState` called *outside* a component setup or composable (e.g. in module top-level): breaks SSR; throws on the server.

## Forbidden patterns

Always wrong on the Nuxt app side. Surface as fixes, never as candidates.

- **F1. `useFetch`/`useAsyncData` against per-principal data, keyed only by URL.** Default key = URL; one user's response hydrates another's render (shared payload, HTTP cache, SSR payload reuse). Include the principal in `key`, or fetch through a service composable that invalidates on auth change.
- **F2. Top-level reactive state in a composable file.** `const x = ref(...)` at module scope is shared across SSR requests — every visitor sees the last visitor's value. Use `useState(key, init)`, or scope inside a factory + `provide` (VUE-CONVENTIONS.md §1).
- **F3. `useState` outside a setup/composable.** Module top-level, plain util, or middleware return — throws on server. Legal only in `setup`, composables, Nuxt plugin `setup`, `defineNuxtRouteMiddleware`.
- **F4. `$fetch` to an internal route from `server/`.** Doubles the request, loses `event.context`. Call the underlying server util directly.
- **F5. Client policy drift from server policy.** `useCanX()` re-implementing the predicate instead of importing from `shared/policies/` (§2). UI shows actions the server refuses.
- **F6. Async resource composable with no transform, no shared key, single caller.** `() => useAsyncData('foo', () => $fetch('/api/foo'))` used once. Inline; the composable is import indirection without locality.

## How these compose

A Nuxt feature on the app side typically looks like:

1. The **page or layout** calls `provideX()` for the feature's service composable.
2. The composable factory is a pure function (VUE-CONVENTIONS.md §1) with `$fetch` injected as the port and, when the state must be SSR-safe and app-wide, `useState` injected as the state seed (§4).
3. **Child components** call `useX()` to read state and trigger methods.
4. UI gating uses **client policy composables** (§2) sharing their predicate with the nitro server.
5. Cross-resource async fetching uses **typed async resource composables** (§3) — promoted into a service composable when mutations enter the picture.

Auditing a Nuxt feature on the app side becomes: which of VUE-CONVENTIONS.md §1–§3 + this file's §1–§4 is missing? Each gap is a deepening candidate with a copy-pasteable starting point.
