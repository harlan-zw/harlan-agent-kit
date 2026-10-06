# Nuxt API migration

Evidence baseline: Nuxt tag `v4.6.0`. Refresh versioned sources when the target changes.

## Portable server runtime

Import `defineEventHandler` and its helpers explicitly from `nuxt/server`.
On Nuxt 4, the corresponding auto-imports still use h3 events.
Mixing those handlers with portable helpers can produce `NUXT_E8012`.
Keep `nuxt/server` external in the published module build.
Ensure the Nuxt server builder bundles shared portable runtime entries during prerender.
Externalized entries can import the generic `serverFetch` stub outside Nuxt's alias transformation.
Use Nitro 2 `externals.inline` or Nitro 3 `noExternals`, preserving existing inline choices.
Prove runtime requests and static generation from packed artifacts.
Use it only in server code. App plugins and components cannot import its runtime.
Type-only imports can reference its types.
Verify default SSR and explicit SPA rules separately on each compiled builder.
An absent `ssr` field does not imply one universal default across Nitro 2 and Nitro 3.
Check native rule normalization and rendering behavior before deleting a builder workaround.
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
Do not rely on `globalThis.$fetch` during Nitro 3 prerender hooks or scheduled tasks.
Choose an explicit local transport for the builder and preserve configured external base URLs.
Test additional crawling and restoration paths, rather than only the initial prerender request.
Nitro 3 closes its prerender worker before later crawling hooks can reuse it.
If several modules reopen the generated app, share its lifetime by renderer identity.
Register clients during prerender initialization. Close the app only after every client releases it.
Prove that one module finishing cannot close another module's active transport.
Use the generated builder's public exports. Do not assume global fetch remains available.
For packages with native optional binaries, prefer Nitro's trace dependencies over forced external package specifiers.
A forced external can bypass the generated prerender app's absolute resolver.

Use Nuxt's runtime hooks through `useServerHooks` where the hook belongs to `NuxtServerHooks`.
For Nitro lifecycle hooks, use the appropriate Nitro API.

Sources: [server imports](https://github.com/nuxt/nuxt/blob/v4.6.0/docs/3.guide/6.going-further/5.server-imports.md),
[migration differences](https://github.com/nuxt/nuxt/blob/v4.6.0/docs/1.getting-started/18.upgrade.md#differences-from-h3-v1),
[public server source](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/nuxt/src/server/index.ts).

## Nitro-specific behavior

Dropping Nuxt 3 does not remove Nitro 2. Nuxt 4.6 still uses it.
Storage, cached handlers, tasks, database access, lazy handlers, and Nitro plugins need a separate audit.
Audit third-party plugin internals too. A supported SDK version can still wrap Nitro 2-only `localFetch`.
Nitro 3 exposes `fetch(Request)` instead. Preserve request isolation and error capture when adapting it.
Sentry's request wrapper needs its AsyncLocalStorage strategy initialized when `withSentry` is absent.
Prove concurrent requests retain different scope tags after an `await`.
Fetch instrumentation must cover native app fetch and external fetch, rather than only `$fetch`.
If instrumentation uses `useRequest()`, enable Nitro's `experimental.asyncContext` for that feature.
Without it, native requests can succeed while request-scoped telemetry stays empty.
Preserve request bodies, abort signals, and transport options when wrapping native fetch.
Read native request context from `event.req.context`.
Derive the method and URL from `event.req`; the old event properties can be absent.
Native matched routes use `matchedRoute.route`, rather than Nitro 2's `matchedRoute.path`.
Cloudflare request bindings now live under `req.runtime.cloudflare`, with the execution context beside the environment.
Do not rely only on Nitro 2 context layouts or the isolate-wide environment.
A legacy h3 event also has `req` and `res`. Check header capabilities before treating them as portable objects.
If storage never uses watchers, audit whether `unstorage`'s `fs-lite` driver preserves its persistence contract.
The full `fs` driver can introduce an optional `chokidar` dependency during server bundling.
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
| Response hook | `afterResponse(event, response)` | `response(response, event)` |
| Lazy handlers | `h3` | `nitro/h3` |

Nitro 3 has no `beforeResponse` or `afterResponse` lifecycle hook.
Its response hook receives the final `Response` before the request event.
Mutate that response's headers when changing the output sent to the client.
Nitro 2 can pass a native `Response` as `beforeResponse`'s body.
h3 copies its headers after that hook runs, overriding Node response headers.
Read the body headers and pending Node headers when applying cache policy.
Write changes into the body response too.
Do not assume `event.res.headers` still owns those final headers.

Nitro 3 uses `HookableCore`, which has no `callHookParallel` or `callHookWith`.
Serial `callHook` stops after a rejected handler.
Preserve independent drains when one sink fails. Exercise both sinks in a real server.
Include synchronous throws as well as rejected promises in that exercise.
Do not cast a missing dispatch method into existence.
Initialize any dispatcher adapter before application plugins register their drains.

Keep renderer hooks separate from request and response lifecycle hooks.
Preserve Node streaming behavior and edge response behavior when moving compression or body transforms.
Nitro 3 exposes `response(response, event)`. Native `beforeResponse` and `afterResponse` hooks are absent.
Select lifecycle adapters through `getNitroVersion`, then prove their side effects on both real builders.
The Nitro 3 hook receives a Web `Response`. Its return value does not replace that response.
Apply body transforms at the handler's return boundary. Set final headers on the actual response.
Test success and error responses when hooks choose status-dependent headers.
Check lifecycle timing when cleanup shares resources with deferred work or streamed responses.

Forwarded request context can share resources across nested local requests.
Track the request that owns a database or other cleanup resource.
Do not let a child response close a borrowed parent resource.
Prove that the parent response still closes the live resource on Nitro 2 and Nitro 3.
If deferred work delays cleanup, preserve the owner's cleanup identity in the shared resource state.
The last task can finish in a borrowed child after the owner responds.
Prove that this task closes the owner's resource exactly once.
Do not declare generic server-builder support while required Nitro features remain.
The experimental Vite server lacks storage, caching, tasks, and Nitro plugins.

Kit infers compatibility from registered imports. Use `meta.compatibility.server` only when inference cannot describe the files.
Use `resolveServerVariant` for aliases and `addServerImports` variants where appropriate.
Nitro-specific variants take priority over `nuxt` variants on their matching hosts.
Tests must prove which implementation ran.
Kit falls back to the Nitro 2 variant when a matching Nitro 3 variant is absent.
Use `{ nitro2: true, nitro3: false }` when selecting a removed Nitro 2 option.
Likewise, use `{ nitro2: false, nitro3: file }` for a Nitro 3-only initializer.
Do not mistake a passing Nitro 3 compatibility layer test for a completed portable migration.

Source: [versioned server compatibility guide](https://github.com/nuxt/nuxt/blob/v4.6.0/docs/3.guide/4.modules/9.server-compatibility.md).

## Module runtime aliases

Use each module's existing namespace with explicit `/app` and `/server` entry points.
For example, expose browser composables through `#site-config/app` and server helpers through `#site-config/server`.
Register directory aliases and create curated `index.ts` barrels inside those directories.
A file alias can shadow existing deep imports or fail to resolve them.
Keep Node filesystem imports and server configuration out of app barrels.
Expose a server entry only when the module has a public server function.
Do not invent an empty API to make every manifest look alike.

Register both directory aliases in Nuxt. Also register the server alias in Nitro.
Register app runtime directories in `build.transpile` and preserve existing entries.
Centralize this in the alias helper so packed plugins receive Vite transformation consistently.
Nuxt 4.6 can include server files in its generated app typecheck context.
Add exact and wildcard TypeScript paths during `prepare:types`, using the corresponding app or server configuration.
Resolve paths relative to the generated configuration's base URL and normalize separators.
Avoid rooted export declarations inside ambient modules.
Parent aliases can still resolve deep imports across contexts. Scoped path registration does not enforce an import ban.
Prove consumer imports with the real parent aliases present, rather than an artificially isolated namespace.
Test packed app SSR output, server requests, and generated app and server types on all three Nuxt lanes.
Keep disabled and mocked module behavior consistent with existing public functions.

## Types and Kit

Move server context and route-rule extensions to Nuxt's owned types where possible.
Use `RequestEventContext` for fields on `event.context`.
`NuxtRequestContext` owns the nested `event.context.nuxt` state, rather than the whole context.
Audit `NuxtRequestContext`, `AppRouteRules`, `RuntimeConfig`, `ServerRoutes`, and `NuxtServerHooks`.
Prefer one augmentation of `@nuxt/schema`; `nuxt/schema` mirrors its public types.
Retain builder-specific augmentation only for builder-specific contracts.
Generate custom Nitro hook augmentations for the selected builder.
Exercise registrations without `as never` so type mismatches remain visible.
Use `addServerTemplate` for server virtual files and the appropriate `addTypeTemplate` context for declarations.
Register server declarations with `{ nuxt: true, nitro: true }` when generated API route types include their server files.
The app compiler then needs the same request context and hook augmentations as the server compiler.
Prepare fixtures before checking generated app, server, shared, and Node TypeScript contexts.

When using Site Config 5 URL helpers, preserve the application's base path explicitly.
The path resolver removes that prefix unless the caller requests `withBase: true`.
Prove signed URLs with a non-root application base path, including query parameters and rendered output.

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
This property belongs to app templates. Nuxt 4.6 `addServerTemplate` does not accept it.
The Kit index exports `getNitroVersion` but does not export the release notes' `hasNitroVersion` name.
Check exact exports before adding version checks.

Sources: [Kit exports](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/kit/src/index.ts),
[template schema](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/schema/src/types/nuxt.ts),
[dependency installation](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/kit/src/dependency.ts),
[layer directories](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/kit/src/layers.ts).

## Fetch and AsyncData addons

Use `createUseFetch` and `createUseAsyncData` when a wrapper adds state to Nuxt's data object.
Import these factories and addon makers from `#imports` in runtime composables.
Nuxt 4.6 does not export these runtime factories from `nuxt/app`.
Its compiler recognizes exported top-level factory declarations.
An untransformed factory throws instead of creating a composable.

Return wrapper properties from `defineUseFetchAddon` or `defineUseAsyncDataAddon` setup.
Nuxt attaches them to both the returned promise and the awaited data object.
Directly assigning properties to the promise can lose them after `await`.
Type the augmented promise as resolving to the extended data object too.
Intersecting extensions with an existing `AsyncData` promise can leave `Awaited` unchanged.
Build declarations and check packed subpath exports after adding factory macros.
Use named public types when inference would expose private Nuxt paths.
Add a real Nuxt regression for both URL and handler wrappers.
Preserve middleware, deadlines, hydration, stale data, and request context while adopting addons.
Use Nuxt-owned `TypedFetchRequest` and `TypedServerResponse` types for route inference.
Keep `experimental.routeTypedFetch` scoped to a fixture when exercising that feature.

Sources: [addon implementation](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/nuxt/src/app/composables/addons.ts),
[factory transform](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/nuxt/src/compiler/plugins/keyed-function-factories.ts).

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
