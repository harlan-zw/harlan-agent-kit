# Nuxt API migration

Evidence baseline: Nuxt tag `v4.6.0`. Refresh versioned sources when the target changes.

## Portable server runtime

Import `defineEventHandler` and its helpers explicitly from `nuxt/server`.
On Nuxt 4, the corresponding auto-imports still use h3 events.
Mixing those handlers with portable helpers can produce `NUXT_E8012`.
Keep `nuxt/server` external in the published module build.
Use it only in server code. App plugins and components cannot import its runtime.
Type-only imports can reference its types.
App-side `useRequestEvent` follows the configured builder's event type.
Do not assume that its event already satisfies the portable handler contract.

| Existing code | Portable replacement |
| --- | --- |
| `H3Event` | `RequestEvent`, or a precise `Pick<RequestEvent, ...>` |
| `event.node.req.headers` | `event.req.headers` |
| `event.path` | `event.url.pathname` |
| Response header helpers | `event.res.headers.get/set/append/delete` |
| `createError({ statusCode, statusMessage })` | `createError({ status, statusText })` |
| `isError` | `isNuxtError` |
| `sendRedirect(event, url)` | `return sendRedirect(event, url)` |
| Decoded router params | Pass `{ decode: true }` when decoding is required |
| CORS boolean early exit | Return the preflight `Response` when provided |
| `useRuntimeConfig(event)` | `useRuntimeConfig()`, without a per-request form |
| Raw or multipart body helpers | Standard `Request` body methods when semantics match |
| In-process `$fetch` | Consider `serverFetch(event, path)`, returning a `Response` |

Native `fetch` and `serverFetch` do not preserve ofetch's parsing, retries, or error contract.
Inspect forwarded headers, base URL handling, hooks, and response status before replacement.
Keep local and external source fetching distinct.
Preserve cookie multiplicity and request isolation.

Use Nuxt's runtime hooks through `useServerHooks` where the hook belongs to `NuxtServerHooks`.
For Nitro lifecycle hooks, use the appropriate Nitro API.

Sources: [server imports](https://github.com/nuxt/nuxt/blob/v4.6.0/docs/3.guide/6.going-further/5.server-imports.md),
[migration differences](https://github.com/nuxt/nuxt/blob/v4.6.0/docs/1.getting-started/18.upgrade.md#differences-from-h3-v1),
[public server source](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/nuxt/src/server/index.ts).

## Nitro-specific behavior

Dropping Nuxt 3 does not remove Nitro 2. Nuxt 4.6 still uses it.
Storage, cached handlers, tasks, database access, lazy handlers, and Nitro plugins need a separate audit.
Use `addNitroPlugin` for Nitro plugin registration.
Use `{ nitro2: file, nitro3: file }` variants where runtime implementations differ.
Use one portable handler when it imports only `nuxt/server`.
Do not retain a legacy handler just to support Nuxt releases below the new minimum.

| Area | Nitro 2 | Nitro 3 |
| --- | --- | --- |
| Storage | `nitropack/runtime` | `nitro/storage` |
| Caching | `nitropack/runtime` | `nitro/cache` |
| Plugins | `defineNitroPlugin` from `nitropack/runtime` | `definePlugin` from `nitro` |
| Nitro hooks | `useNitroApp().hooks` | `useNitroHooks()` from `nitro/app` |
| Lazy handlers | `h3` | `nitro/h3` |

Keep renderer hooks separate from request and response lifecycle hooks.
Preserve Node streaming behavior and edge response behavior when moving compression or body transforms.
Do not declare generic server-builder support while required Nitro features remain.
The experimental Vite server lacks storage, caching, tasks, and Nitro plugins.

Kit infers compatibility from registered imports. Use `meta.compatibility.server` only when inference cannot describe the files.
Use `resolveServerVariant` for aliases and `addServerImports` variants where appropriate.
Nitro-specific variants take priority over `nuxt` variants on their matching hosts.
Tests must prove which implementation ran.
Do not mistake a passing Nitro 3 compatibility layer test for a completed portable migration.

Source: [versioned server compatibility guide](https://github.com/nuxt/nuxt/blob/v4.6.0/docs/3.guide/4.modules/9.server-compatibility.md).

## Types and Kit

Move server context and route-rule extensions to Nuxt's owned types where possible.
Audit `NuxtRequestContext`, `AppRouteRules`, `RuntimeConfig`, `ServerRoutes`, and `NuxtServerHooks`.
Prefer one augmentation of `@nuxt/schema`; `nuxt/schema` mirrors its public types.
Retain builder-specific augmentation only for builder-specific contracts.
Use `addServerTemplate` for server virtual files and the appropriate `addTypeTemplate` context for declarations.
Prepare fixtures before checking generated app, server, shared, and Node TypeScript contexts.

Read exports and signatures rather than guessing from release-note names:

| Exact API | Action |
| --- | --- |
| `NuxtTemplate.dependsOn` | Use `[]`, `['pages']`, `['plugins']`, or a change predicate according to inputs |
| `ensureDependencyInstalled` | Inspect prompt behavior; returns a boolean for one dependency |
| `getAddDependencyCommand` | Use `{ dev: true }` for an explicit developer installation command |
| `getLayerDirectories(nuxt)` | Returns an ordered array; use each entry's `appPages`, `public`, or other directory |
| `setGlobalHead` | Consider for build-time global head contributions |
| `updateAppConfig` | Consider for module-owned app configuration |

The release notes describe template dependencies, but the schema property is `dependsOn`.
The Kit index exports `getNitroVersion` but does not export the release notes' `hasNitroVersion` name.
Check exact exports before adding version checks.

Sources: [Kit exports](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/kit/src/index.ts),
[template schema](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/schema/src/types/nuxt.ts),
[dependency installation](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/kit/src/dependency.ts),
[layer directories](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/kit/src/layers.ts).

## Earlier 4.x opportunities

| Release | Opportunity | Migration use |
| --- | --- | --- |
| [4.0](https://github.com/nuxt/nuxt/releases/tag/v4.0.0) | App directory and split TypeScript contexts | Remove v3 directory assumptions; retain explicitly configured layouts |
| [4.1](https://github.com/nuxt/nuxt/releases/tag/v4.1.0) | `moduleDependencies`, lifecycle callbacks, layer directories, page rules | Replace manual dependency ordering and path discovery where equivalent |
| [4.2](https://github.com/nuxt/nuxt/releases/tag/v4.2.0) | `setGlobalHead`, configurable server builder, Vite Environment API preview | Replace head mutation where equivalent; test builder assumptions |
| [4.3](https://github.com/nuxt/nuxt/releases/tag/v4.3.0) | Async `moduleDependencies`, route groups, disabled layer modules, error names | Preserve disabled modules and route groups; use `status` and `statusText` |
| [4.4](https://github.com/nuxt/nuxt/releases/tag/v4.4.0) | Vue Router 5, `unrouting`, fetch factories | Audit router peers and routing semantics; remove duplicate parsing only with proof |
| [4.5](https://github.com/nuxt/nuxt/releases/tag/v4.5.0) | Unhead 3, Vite 8, streaming, `updateAppConfig` | Delete Unhead 2 dispatch; audit Vite plugins and rendered metadata under streaming |
| [4.6](https://github.com/nuxt/nuxt/releases/tag/v4.6.0) | Portable server surface, typed fetch, template invalidation, top-level prerender | Remove adapters, improve generated types, and avoid unnecessary template rebuilds |

Treat experimental flags as targeted tests, not defaults imposed on consuming apps.
Test streaming metadata for bots and browsers when the module modifies rendered HTML.
Test early 404, inline error rendering, `noScripts`, and static error pages where behavior depends on renderer execution.
Consider `serialize: false` only for data that never needs client hydration.
Adopt fetch addons, sessions, or derived secrets only when an existing feature needs them.
