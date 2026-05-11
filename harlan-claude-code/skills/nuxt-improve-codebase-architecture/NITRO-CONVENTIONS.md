# Nitro Conventions

Nitro deliberately ships a minimal server kernel (HTTP routing, storage, cache, hooks) and leaves the rest as conventions you establish in your codebase. This file is the **conformity layer**: a set of conventions inspired by mature frameworks (Laravel especially) that fill those gaps with real **seams** in the [LANGUAGE.md](LANGUAGE.md) sense — not just code style.

For each convention: the gap it fills, the seam shape, and a copy-pasteable template the agent can drop into a project. Each section names the **interface** at the seam in [LANGUAGE.md](LANGUAGE.md) terms; reach for the dependency category from [DEEPENING.md](DEEPENING.md) when designing the test strategy. Adapt names freely; the *shape* is the load-bearing part.

> **These are deepening candidates, not unconditional rules.** Surface them during the Explore phase ([SKILL.md](SKILL.md) §1) when you see the gap. The grilling loop ([SKILL.md](SKILL.md) §3) still applies — walk the design tree, run the deletion test, and if the user rejects with a load-bearing reason, offer an ADR. Each section here passes the deletion test by construction (deleting the convention scatters complexity across N handlers), but adopting one is a real refactor with real cost; don't propose all of them at once.

> **No DI container.** Vitest's module mocking (`vi.mock('~~/server/utils/db')`) covers what a Laravel-style service container provides. Design services as plain exported functions in `server/utils/`, not as classes registered in a container — the test seam already exists at the module level.

> **Thread `event` through server code.** The `H3Event` is the request-scoped state object: `event.context` carries the authenticated user, runtime config, request id, `waitUntil`, platform bindings, and per-request caches. Server utils, validators, policies, services, and presenters should accept `event` as their first argument and read state from it — not from module-level singletons, ambient `useRuntimeConfig()` calls without `event`, or implicit `getRequestEvent()` lookups. This keeps handlers pure-ish (one request = one event), makes tests trivial (pass a mock event), and prevents cross-request bleed under concurrency. If a function genuinely doesn't need request state, it doesn't take `event`; if it might need it later, take it now. Reject server-side abstractions that hide `event` behind a global accessor.

## 1. Request validation (`server/validators/`)

**Gap.** Zod (or valibot, etc.) schemas inline in each handler, mixed with parsing of body/query/params and ad-hoc 422 responses.

**Seam.** A validator is a function `(event) => parsedInput | throws 422`. Each route's input shape is one named validator. The handler depends on the validator's typed return shape; the schema is private.

**Template.**

```ts
// server/utils/validator.ts
import type { H3Event } from 'h3'
import type { z } from 'zod'

type Source = 'body' | 'query' | 'params'

export function defineValidator<S extends z.ZodTypeAny>(schema: S, source: Source = 'body') {
  return async (event: H3Event): Promise<z.infer<S>> => {
    const raw
      = source === 'body'
        ? await readBody(event)
        : source === 'query'
          ? getQuery(event)
          : event.context.params ?? {}
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Unprocessable Entity',
        data: parsed.error.flatten(),
      })
    }
    return parsed.data
  }
}
```

```ts
// server/validators/orders/create.ts
import { z } from 'zod'

export const validateCreateOrder = defineValidator(z.object({
  items: z.array(z.object({ sku: z.string(), qty: z.number().int().positive() })).min(1),
  couponCode: z.string().optional(),
}))
```

```ts
// server/api/orders.post.ts
export default defineEventHandler(async (event) => {
  const input = await validateCreateOrder(event)
  // input is fully typed; handler stays thin
  return placeOrder(event, input)
})
```

## 2. Authorization (`server/policies/`)

**Gap.** `if (user.id !== post.userId)` checks scattered across handlers, often subtly inconsistent.

**Seam.** A policy is a pure function `(user, resource) => boolean | Promise<boolean>`. The `authorize` helper threads the current user from `event.context` and throws 401/403. Every authorization decision is one named policy in `server/policies/`.

**Template.**

```ts
// server/utils/authorize.ts
import type { H3Event } from 'h3'

type Policy<R, U = NonNullable<H3EventContext['user']>> = (user: U, resource: R) => boolean | Promise<boolean>

export async function authorize<R>(event: H3Event, policy: Policy<R>, resource: R): Promise<void> {
  const user = event.context.user
  if (!user)
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  const allowed = await policy(user, resource)
  if (!allowed)
    throw createError({ statusCode: 403, statusMessage: 'Forbidden' })
}
```

```ts
// server/policies/post.ts
import type { Post, User } from '~~/shared/types'

export function updatePost(user: User, post: Post) {
  return user.id === post.authorId || user.role === 'admin'
}

export function deletePost(user: User, post: Post) {
  return user.role === 'admin'
}
```

```ts
// server/api/posts/[id].patch.ts
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const post = await getPost(id)
  await authorize(event, updatePost, post)
  // ...
})
```

Augment `H3EventContext` so `event.context.user` is typed (see NUXT-SEAMS.md "Type-level seam"); a server middleware in nitro is responsible for setting it.

## 3. Response presenters (`server/presenters/`)

**Gap.** Raw DB rows returned to the client. Soft-deleted columns, password hashes, internal flags leak by accident.

**Seam.** A presenter is a pure function `(row, ctx?) => Resource`. The handler returns `toUserResource(user)`; the row shape never escapes the server module. No helper is needed — the convention is *one presenter per resource type*, exported from `server/presenters/`.

**Template.**

```ts
// shared/types/user-resource.ts
export interface UserResource {
  id: string
  name: string
  avatarUrl: string | null
}
```

```ts
// server/presenters/user.ts
import type { User } from '~~/server/db/schema'
import type { UserResource } from '~~/shared/types/user-resource'

export function toUserResource(user: User): UserResource {
  return {
    id: user.id,
    name: user.displayName,
    avatarUrl: user.avatarUrl,
  }
}

export const toUserResources = (users: User[]) => users.map(toUserResource)
```

The shared `UserResource` type lives in `shared/` (so the app can import it), the DB row type stays nitro-side. That split *is* the seam.

## 4. Centralized error handling (`server/utils/handler.ts` + `shared/errors.ts`)

**Gap.** Every handler has its own try/catch. Some throw `createError`; some return `{ error: '...' }`. New error types ramify across files.

**Seam.** Two pieces:
- A **domain error base class** in `shared/errors.ts`, subclassed per error kind, carrying its own HTTP mapping.
- A **handler wrapper** `defineApiHandler` that catches domain errors and maps them once. The nitro `error` hook is for *observability* (logging, telemetry), not response shaping.

**Template.**

```ts
// shared/errors.ts
export class DomainError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 400,
    readonly data?: Record<string, unknown>,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id?: string) {
    super(`${resource}${id ? ` ${id}` : ''} not found`, 404)
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, data?: Record<string, unknown>) {
    super(message, 409, data)
  }
}
```

```ts
import type { EventHandler, EventHandlerRequest } from 'h3'
// server/utils/handler.ts
import { DomainError } from '~~/shared/errors'

export function defineApiHandler<T extends EventHandlerRequest, R>(
  fn: EventHandler<T, R>,
): EventHandler<T, R> {
  return defineEventHandler(async (event) => {
    try {
      return await fn(event)
    }
    catch (err) {
      if (err instanceof DomainError) {
        throw createError({
          statusCode: err.statusCode,
          statusMessage: err.message,
          data: err.data,
        })
      }
      throw err
    }
  })
}
```

```ts
// server/api/posts/[id].get.ts
import { NotFoundError } from '~~/shared/errors'

export default defineApiHandler(async (event) => {
  const id = getRouterParam(event, 'id')!
  const post = await findPost(id)
  if (!post)
    throw new NotFoundError('Post', id)
  return toPostResource(post)
})
```

```ts
// server/plugins/error-observer.ts (observability only — does not shape responses)
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('error', (err, { event }) => {
    if (err instanceof DomainError && err.statusCode < 500)
      return // expected
    console.error('[unhandled]', event?.path, err)
    // forward to Sentry/Axiom/etc. here
  })
})
```

The interface here is the **set of `DomainError` subclasses**. Adding a new error type is one file in `shared/errors.ts`; no handler edits.

**Floor.** `defineApiHandler` only earns its keep when the codebase has at least one `DomainError` subclass *and* most handlers throw them. If the only thing the wrapper does is call `defineEventHandler` and re-throw, delete it — that's a passthrough (see Forbidden patterns F3). Do not retrofit the wrapper to handlers that have no input, no auth check beyond defaults, and no transform; keep them as `defineEventHandler`.

## 5. Service providers via Nuxt modules

**Gap.** One giant `server/plugins/` folder where every feature dumps its boot logic. No locality.

**Seam.** Each feature is a Nuxt module that registers exactly one nitro plugin via `addServerPlugin` (plus any `addServerHandler`, `addImports`, etc.). The Nuxt module *is* the service provider. The module options are its public interface.

**Template.**

```ts
// modules/billing/index.ts
import { addServerHandler, addServerPlugin, createResolver, defineNuxtModule } from 'nuxt/kit'

export interface BillingModuleOptions {
  provider: 'stripe' | 'paddle'
  webhookPath: string
}

export default defineNuxtModule<BillingModuleOptions>({
  meta: { name: 'billing', configKey: 'billing' },
  defaults: { provider: 'stripe', webhookPath: '/api/billing/webhook' },
  setup(options, nuxt) {
    const { resolve } = createResolver(import.meta.url)

    nuxt.options.runtimeConfig.billing = {
      provider: options.provider,
      apiKey: '', // injected from NUXT_BILLING_API_KEY
    }

    addServerPlugin(resolve('./runtime/server/plugin'))
    addServerHandler({ route: options.webhookPath, handler: resolve('./runtime/server/webhook.post') })
  },
})
```

The feature's nitro plugin (`./runtime/server/plugin.ts`) is the *only* server-plugin that feature owns. Adding a feature is adding a module; removing one is removing the module. Boot graph is feature-local.

## 6. Event + listener registry (`server/listeners/`)

**Gap.** Cross-feature reactions ("when an order is placed, send email + update analytics + warm cache") embedded inline inside the order handler. Adding the next reaction means editing the handler.

**Seam.** A typed runtime hook per business event. Listeners subscribe in `server/listeners/`; each listener file owns one reaction. The handler emits the event and forgets about who listens.

**Template.**

```ts
// server/types/events.ts
import type { Order } from '~~/shared/types'

declare module 'nitropack/types' {
  interface NitroRuntimeHooks {
    'order:placed': (order: Order) => void | Promise<void>
    'order:shipped': (order: Order, trackingNumber: string) => void | Promise<void>
  }
}

export {}
```

```ts
// server/listeners/notify-on-order-placed.ts
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('order:placed', async (order) => {
    await sendOrderConfirmationEmail(order)
  })
})
```

```ts
// inside a handler / service
const nitroApp = useNitroApp()
await nitroApp.hooks.callHook('order:placed', order)
```

If a listener may be slow, dispatch via `event.waitUntil(...)` (see §8) or via a job (see §8) so the request returns promptly.

## 7. Nitro tasks (`server/tasks/`)

**Gap.** Cron jobs and ops commands (migrations, reindex, cleanup, cache-warm) shoehorned into request handlers triggered by hand or external schedulers.

**Seam.** Tasks are nitro's "scheduled function or manually-invoked function" primitive. Use them for **cron and ops**, not as a job queue. **They are experimental** (`experimental.tasks: true`) and platform-aware (node/bun/deno via croner; Cloudflare Cron Triggers; Vercel Cron).

When to reach for tasks:

- ✅ Periodic cron work (cleanup, reindex, cache-warm, digest emails).
- ✅ Ops commands triggered manually via devtools, CLI, or an authenticated admin endpoint that calls `runTask`.
- ❌ Per-request deferred work that needs retries/backoff/dead-letter — see §8.

**Template.**

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  nitro: {
    experimental: { tasks: true },
    scheduledTasks: {
      '0 * * * *': ['cache:warm'],
      '0 3 * * *': ['db:cleanup', 'search:reindex'],
    },
  },
})
```

```ts
// server/tasks/cache/warm.ts
export default defineTask({
  meta: { name: 'cache:warm', description: 'Warm the popular-products cache' },
  async run({ payload, context }) {
    const products = await fetchPopularProducts()
    await useStorage('cache').setItem('popular-products', products)
    return { result: products.length }
  },
})
```

```ts
// server/api/admin/reindex.post.ts (manual trigger)
export default defineApiHandler(async (event) => {
  await authorize(event, isAdmin, null)
  const { result } = await runTask('search:reindex', { payload: {} })
  return { result }
})
```

Tasks payloads are `Record<string, unknown>`; type them at the call site, not in `defineTask` (the task interface intentionally stays loose).

## 8. Job / queue seam (BYO)

**Gap.** Per-request deferred work that must complete eventually with retries — order placement triggers payment capture, email, analytics, etc. Nitro tasks are the wrong shape (no retries, no DLQ, no concurrency control).

**Seam.** Define a small `Job<P>` port and a `dispatch` function in your codebase. Two adapters:

- **Fire-and-forget adapter** for edge runtimes: `event.waitUntil(job.run(payload))`. No retries, but the request returns promptly.
- **Real queue adapter** for retryable work: BullMQ + Redis (node), QStash (HTTP-based, edge-friendly), Cloudflare Queues, Inngest, etc. The choice belongs in module options or `runtimeConfig`.

This is exactly the **Remote-but-owned (Ports & Adapters)** category from DEEPENING.md: one logic, two adapters, test adapter is in-memory.

**Template (port + fire-and-forget adapter).**

```ts
// server/utils/jobs.ts
import type { H3Event } from 'h3'

export interface Job<P> {
  name: string
  run: (payload: P) => Promise<void>
}

export function defineJob<P>(job: Job<P>): Job<P> {
  return job
}

// Fire-and-forget adapter. Suitable for edge runtimes; no retries.
export async function dispatch<P>(event: H3Event, job: Job<P>, payload: P): Promise<void> {
  const promise = job.run(payload).catch((err) => {
    console.error(`[job:${job.name}] failed`, err)
  })
  if ('waitUntil' in event.context && typeof event.context.waitUntil === 'function') {
    event.context.waitUntil(promise)
    return
  }
  // node fallback: do not await, let the response return
  void promise
}
```

```ts
// server/jobs/send-order-confirmation.ts
import type { Order } from '~~/shared/types'

export const sendOrderConfirmation = defineJob<{ orderId: string }>({
  name: 'send-order-confirmation',
  async run({ orderId }) {
    const order = await loadOrder(orderId)
    await sendEmail(order.customerEmail, renderConfirmation(order))
  },
})
```

```ts
// inside an order handler
await dispatch(event, sendOrderConfirmation, { orderId: order.id })
```

For retryable work, swap the dispatcher for a queue-backed adapter (BullMQ/QStash/Inngest) — the **`Job<P>` port stays identical**. That stability is the whole point of the seam.

When you reach for a real queue, the seam discipline matters more, not less:

- The job's payload type *is* the wire format — keep it serialisable, no functions, no class instances.
- Idempotency keys belong in the payload (`{ idempotencyKey, ...input }`); the job's `run` checks them before doing work.
- Retries are the queue's responsibility, not the job's.

## 9. Schema + migrations (per-layer, host-orchestrated)

**Gap.** Drizzle-kit (and Prisma, and most TS-first ORMs) expects **one schema source, one migrations folder**. That doesn't fit a Nuxt project with layers, where a billing layer reasonably wants to own its tables alongside its handlers, services, and pages. Without a convention, schemas pile up in one giant `server/database/schema.ts` in the host app, and the layer-as-vertical principle breaks at the data boundary.

**Seam.** Adopt Laravel's pattern, where each package ships its own migrations registered with the framework's runner. The schema's interface (the typed table definitions) is **composable across layers**; the migration timeline is **globally ordered by timestamp filename**, applied by a host-owned runner that discovers all layer migration paths.

- **Each layer owns**: its schema fragment, its migrations folder, its own `drizzle.config.ts` (so `drizzle-kit generate` works per-layer).
- **The host owns**: a barrel re-exporting layers' tables (so app code has a single import surface for typed queries), and the **migration runner** that discovers `layers/*/server/database/migrations/` + the host's own migrations, orders by filename, and applies them.

This is structurally the Laravel `loadMigrationsFrom()` pattern; the runner is the small piece Drizzle doesn't ship.

**Template.**

```
# Layer (one per modular feature)
layers/billing/
  drizzle.config.ts                      # generates into the layer's own migrations
  server/database/
    schema.ts                            # exports the layer's tables
    migrations/                          # SQL files, timestamp-prefixed
      20260115093000_create_invoices.sql
  server/services/billing.ts             # consumes its own tables
  server/api/billing/...

# Host app
drizzle.config.ts                        # host-only schema (or barrel; see below)
server/database/
  schema.ts                              # barrel re-exporting from each layer + host
  migrations/                            # host-only migrations live here
  migrate.ts                             # the cross-layer runner (server util)
server/tasks/db/migrate.ts               # nitro task wrapping migrate.ts
```

```ts
export * from '#layers/analytics/server/database/schema'
// server/database/schema.ts (host)
// Barrel of all schema fragments. App-side code imports from here.
export * from '#layers/billing/server/database/schema'
export * from './tables/users' // host's own tables
```

```ts
// server/database/migrate.ts (host)
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { useDb } from './client'

interface MigrationSource {
  layer: string // 'billing', 'analytics', 'host'
  dir: string // absolute path
}

export async function runMigrations(sources: MigrationSource[]): Promise<void> {
  const db = useDb()

  await db.run(sql`CREATE TABLE IF NOT EXISTS _migrations (
    layer TEXT NOT NULL,
    name  TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (layer, name)
  )`)

  // Discover all SQL files across all sources, tag with their layer.
  const files = (await Promise.all(sources.map(async (src) => {
    const names = (await readdir(src.dir)).filter(f => f.endsWith('.sql')).sort()
    return names.map(name => ({ layer: src.layer, name, path: join(src.dir, name) }))
  }))).flat()

  // Global ordering by filename (timestamp-prefixed).
  files.sort((a, b) => a.name.localeCompare(b.name))

  const applied = new Set(
    (await db.all<{ layer: string, name: string }>(sql`SELECT layer, name FROM _migrations`))
      .map(r => `${r.layer}/${r.name}`),
  )

  for (const f of files) {
    if (applied.has(`${f.layer}/${f.name}`))
      continue
    const sqlText = await readFile(f.path, 'utf8')
    await db.run(sql.raw(sqlText))
    await db.run(sql`INSERT INTO _migrations (layer, name, applied_at) VALUES (${f.layer}, ${f.name}, ${Date.now()})`)
    console.log(`[migrate] ${f.layer}/${f.name} applied`)
  }
}
```

```ts
// server/tasks/db/migrate.ts (host) — nitro task wrapping the runner
import { runMigrations } from '~~/server/database/migrate'

export default defineTask({
  meta: { name: 'db:migrate', description: 'Apply all pending migrations across host + layers' },
  async run() {
    await runMigrations([
      { layer: 'billing', dir: new URL('../../../layers/billing/server/database/migrations', import.meta.url).pathname },
      { layer: 'analytics', dir: new URL('../../../layers/analytics/server/database/migrations', import.meta.url).pathname },
      { layer: 'host', dir: new URL('../../database/migrations', import.meta.url).pathname },
    ])
    return { result: 'ok' }
  },
})
```

(For better ergonomics, register migration sources via a Nuxt module hook from each layer instead of hard-coding paths — that's the real Laravel `loadMigrationsFrom` shape. The hook accumulates sources at build time; the task reads them at runtime.)

**Interface = the schema barrel + the `_migrations` table contract.** App code imports table types from `~~/server/database/schema`; the runner cares only about timestamp ordering and the layer/name pair tracked in `_migrations`.

**Dependency category** ([DEEPENING.md](DEEPENING.md)): **local-substitutable** — the database driver is selected via Drizzle config / `runtimeConfig` (sqlite + memory in tests, sqlite-on-disk or libsql/Postgres in prod). The seam is internal; tests run the same migrations against the test driver.

**Cross-layer foreign keys.** Same constraint Laravel has at the package level. Two options:

- **Application-level relations only.** Define typed `relations()` in code; skip SQL-level `FOREIGN KEY` constraints when crossing layers. Cheaper coupling, integrity enforced at the service layer.
- **Host-level finishing migration.** If you genuinely want SQL FKs, the host adds the constraint as a host migration that runs after both layers' tables exist. Ordering is enforced by timestamp.

**Anti-patterns.**

- **Layer assumes the host's schema.** A layer importing tables from `~~/server/database/schema` (the host barrel) instead of its own. The layer is no longer a vertical — it's just code organised in a layer-shaped folder.
- **One global `server/database/schema.ts` for everything.** Defeats the layer-as-vertical principle; every feature change forces edits in the host. Use the barrel pattern instead.
- **Host-only migrations folder when layers exist.** The host ends up owning migrations whose schema source is in a layer — change-locality is broken (table change in layer X requires a migration edit in host).
- **`drizzle-kit push` against a layer schema in production.** Push skips the migration timeline; only safe in dev. Production runs through the migration runner only.
- **Cross-layer SQL FKs without the finishing-migration pattern.** Will fail with "table doesn't exist" if migrations interleave wrong.
- **Layer-owned `_migrations` tracking.** The tracking table is per-DB, not per-layer. One `_migrations` table for the whole app; the `layer` column distinguishes sources.

## Forbidden patterns

Always wrong on the nitro side. Surface as fixes, never as candidates.

- **F1. `defineCachedEventHandler` wrapping an authenticated route.** Nitro's cache wrapper proxies the inner request and only forwards headers listed in `opts.varies` — without it the inner handler sees no cookie/authorization/x-api-key, so `requireUserSession` (and friends) throw 401 on every cached path. Fix: outer `defineEventHandler` does auth, then calls a `defineCachedFunction` keyed on the resource id. `varies: ['cookie', ...]` "works" but splits the cache per principal; only right when the body genuinely varies per user. Detect: `defineCachedEventHandler` whose body calls `require*Session`, `getUserSession`, reads `event.context.user`, or runs a policy.
- **F2. Cache key omits a varying input.** `defineCachedFunction`/`defineCachedEventHandler` whose `getKey` ignores args the body uses (pagination, filters, locale). First response wins for the whole TTL. If the handler reads `getQuery` or >1 router param, every one of them must be in `getKey` (or in `varies`).
- **F3. Meta-handler that does no work.** `defineApiHandler` (or similar wrapper) that catches no domain errors, mounts no validation, runs no policy — pure passthrough. Use `defineEventHandler`. See SKILL.md "Meta-handler with no work to do".
- **F4. Convention file per single-use call.** `server/{schemas,policies,presenters}/foo.ts` with one caller and <10 lines of inline logic. Inline. See SKILL.md "Convention extraction below the floor".
- **F5. Top-level side effect in a server util.** Module-scope `console.log`, connection open, hook register, env read — fires on every import including tests. Move behind an exported function or into a `server/plugins/` nitro plugin.
- **F6. `useRuntimeConfig()` at module top level.** Outside a request scope it reads build-time defaults only and silently ignores runtime env overrides. Call inside a handler/plugin lifecycle.
- **F7. Augmented `event.context` field typed non-optional but set conditionally.** If a request middleware/plugin sets `event.context.foo` only on some platforms (e.g. Cloudflare env present), the augmentation type must be `T | undefined` — otherwise downstream `event.context.foo.x` reads NPE silently in dev.
- **F8. `process.env` in code that runs on edge/Workers.** `undefined` at runtime; degrades silently (e.g. unauthenticated GitHub at 60 req/hr). Use `useRuntimeConfig(event)` and let nitro env-map.
- **F9. `shouldBypassCache` (or any cache opt) tied to auth/session state without keying on it.** Cache decision varies per principal but the key doesn't — leaks one user's payload to the next.

## How these conventions interact

These conventions compose:

1. A handler wrapped by `defineApiHandler` (§4) calls `validateX(event)` (§1), then `authorize(event, policy, resource)` (§2), then a server module that throws domain errors (§4) and emits `nitroApp.hooks.callHook('thing:happened', ...)` (§6). The handler queries via the schema barrel (§9) and returns `toResource(...)` (§3).
2. The feature is packaged as a Nuxt module (§5) — or a layer when it owns its own schema (§9) — that registers its nitro plugin (which subscribes listeners + sets up services).
3. Cron work the feature owns lives in `server/tasks/` (§7); deferred per-request work goes through the job port (§8); schema migrations run through the host's migrate task (§9, composing with §7).

A feature audit using this skill becomes: which of §1–§9 is missing or hand-rolled? Each missing convention is a deepening candidate with a copy-pasteable starting point.
