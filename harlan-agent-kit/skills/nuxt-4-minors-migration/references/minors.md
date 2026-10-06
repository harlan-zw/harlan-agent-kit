# Nuxt 4.1 To 4.6

Each item names its tier, the detection, and the change. The Skill defines the tiers.
Items that compatibility version 5 controls live in [compatibility version 5](compat-v5.md).
Run every `rg` from the app root. Add layer directories when the site has them.

## Upgrade

Tier 0.

1. **Node floor.** Nuxt 4.6 requires Node `^22.22.3 || ^24.15.0 || >=26.0.0`.
   - Detect: `rg -n 'node-version|"node":|FROM node' .github package.json Dockerfile .nvmrc .node-version`
   - Change `engines`, `.nvmrc`, `.node-version`, and CI `node-version`. Prefer `24`.
   - A self-hosted runner uses the host's Node unless CI installs one. Check each runner that builds the site.
2. **Nuxt version.** Raise `nuxt` to the latest 4.x release where it is declared: the catalog in `pnpm-workspace.yaml`, or `package.json`. Then run `pnpm dedupe`. With another package manager, run `nuxt upgrade --dedupe`.
3. **Overrides.** Remove a `vite` override that pins Vite below 8, and any `rolldown-vite` override. Nuxt 4.5 ships Vite 8 on Rolldown.
4. **Supply-chain policy.** With `trustPolicy: no-downgrade`, pnpm rejects the cssnano 9 family that `@nuxt/vite-builder` 4.6.0 installs. Expect about 30 packages. Repeat these steps until the install passes:
   1. Run `pnpm install > install.log 2>&1 || rg -o 'trust downgrade for "([^"]+)"' -r '$1' install.log`
   2. Check the named package: `npm view <name>@<version> dist.attestations.provenance.predicateType repository.url`
   3. If the provenance is SLSA and the repository is the package's own, add the exact `<name>@<version>` to `trustPolicyExclude`. Group the entries under one comment that names the reason.
   4. If the provenance is missing, stop and report the package.
   With a release age policy, pnpm adds the new Nuxt packages to `minimumReleaseAgeExclude` itself. Keep those entries; they follow the site's existing pattern.
5. **Modules.** Build once. Upgrade each module that fails on Vite 8, unhead v3, or vue-router 5.

## 4.1

- **T1: `entryImportMap` is on by default.**
  Detect: `rg -n entryImportMap nuxt.config.ts`.
  Change: delete `entryImportMap: true`. Keep `false` only with a reason.
- **T1: `installModule` is deprecated in local modules.**
  Detect: `rg -n 'installModule\(' modules layers`.
  Change: declare `moduleDependencies` in `defineNuxtModule`.
- **T1: `nuxt.options._layers` is private.**
  Detect: `rg -n '_layers' modules layers`.
  Change: use `getLayerDirectories(nuxt)` from `@nuxt/kit`.
- **T1: `.nuxtrc` tracks module versions for `onInstall` and `onUpgrade`.**
  Detect: `rg -n nuxtrc .gitignore`.
  Change: commit `.nuxtrc`.

## 4.2

- **T2: `useAsyncData` handlers receive an abort signal.**
  Detect: `rg -n -A4 'useAsyncData\(' app layers`, then find handlers that call `$fetch`.
  Change: write `(_nuxtApp, { signal }) => $fetch(url, { signal })`. Then `refresh`, `clear`, and `dedupe: 'cancel'` stop the request.
- **T2: `experimental.extractAsyncDataHandlers` moves handlers into lazy chunks.** A prerendered page then ships none of them.
  Detect: most routes prerender, through `nitro.static`, `prerender` routes, or `prerender: true` route rules.
  Change: build with and without it. Compare the JavaScript a prerendered page loads up front: the files its HTML names through module scripts and `modulepreload` links. Keep it only when that number drops. The total in `.output/public/_nuxt` grows either way, because handlers move into extra chunks.
  On harlanzw.com, whose handlers only query content, it raised a page from 14 files and 882,848 bytes to 21 files and 884,558 bytes, so the site keeps it off.
- **T3: `experimental.typescriptPlugin`** adds editor features and installs `@dxup/nuxt`. Follow-up only.

## 4.3

- **T1: `statusCode` and `statusMessage` are deprecated.** Nuxt 5 removes them. See [status renames](#status-renames).
- **T0: the server tsconfig enables `noUncheckedIndexedAccess`.**
  Detect: typecheck.
  Change: fix each error. Do not turn the option off.
- **T2: `#server` alias.**
  Detect: `rg -n "from '(\.\./){2,}" server`.
  Change: if the target is inside `server/`, import it from `#server/...`.
- **T2: `appLayout` route rule.**
  Detect: `rg -n 'layout:' app/pages layers`, then find one layout repeated under one path prefix. Also find middleware that calls `setPageLayout` by path.
  Change: set `routeRules['/prefix/**'] = { appLayout: 'name' }`. Delete the repeated `layout` keys.
- **T2: route groups in `to.meta.groups`.**
  Detect: pages in a `(group)/` folder, and middleware that checks the same pages by path prefix.
  Change: check `to.meta.groups?.includes('group')`.
- **T2: disable a layer's module with `<configKey>: false`.**
  Detect: workarounds that turn off a module a layer installs.
  Change: set that module's config key to `false`.

### Status renames

Rename only Nuxt and h3 error shapes. `FetchError.statusCode` from ofetch and `Response.status` are different objects.
h3 v1's `createError` reads `status` and `statusText` too, so server code can change before it moves to `nuxt/server`.

- `createError` and `showError` arguments.
  Detect: `rg -nU '(createError|showError)\(\{[^}]*status(Code|Message)' app server layers shared`.
  Change: `status` and `statusText`.
- `error.vue` and `useError()` reads.
  Detect: `rg -n 'error(\.value)?\??\.status(Code|Message)' app layers`.
  Change: `error.status` and `error.statusText`.
- Other `NuxtError` reads in plugins and middleware.
  Detect: `rg -n '\.statusCode\b' app layers`, then read each hit.
  Change: only reads of a `NuxtError`.
- Redirect route rules: leave them. nitropack v2 reads only `redirect.statusCode`, so a renamed `status` silently drops the 301. See [compatibility version 5](compat-v5.md#nuxt-5-preparation-on-46).

## 4.4

- **T2: `createUseFetch` and `createUseAsyncData`.** A hand-written wrapper loses automatic key injection, so two calls can share a key.
  Detect: `rg -n 'return use(Lazy)?(Fetch|AsyncData)\(' app/composables layers` and `rg -n '\$fetch\.create\(' app`.
  Change: `export const useApiFetch = createUseFetch({ baseURL })` in `app/composables/`. Nuxt scans that directory to inject keys, so the factory must live there. Delete the wrapper.
- **T1: vue-router 5 replaces `unplugin-vue-router`.**
  Detect: `rg -n unplugin-vue-router package.json app nuxt.config.ts`.
  Change: remove the dependency. Replace each `unplugin-vue-router` import with its `vue-router` 5 equivalent, then typecheck.
- **T2: typed layout props.**
  Detect: `rg -n 'provide\(|inject\(' app/layouts`, or `useState` that pages set for a layout.
  Change: declare `defineProps` in the layout. Pass props with `definePageMeta({ layout: { name, props } })`, or with `setPageLayout(name, props)` in middleware.
- **T2: `useAnnouncer` and `<NuxtAnnouncer>`.**
  Detect: `rg -n aria-live app layers` in hand-written live regions.
  Change: add `<NuxtAnnouncer />` to `app.vue`. Call `useAnnouncer().polite()` or `.assertive()`. Keep `<NuxtRouteAnnouncer />`.
- **T2: `useCookie(name, { refresh: true })` extends the expiry on every write.**
  Detect: code that rewrites a cookie only to extend its expiry.
  Change: add `refresh: true`.
- **T1: `normalizeComponentNames` is on by default.**
  Detect: `rg -n normalizeComponentNames nuxt.config.ts`.
  Change: delete `normalizeComponentNames: true`.
- **T3: view transition types, and `nuxt build --profile`.** Use the profiler when a build is slow.

## 4.5

- **T1: Vite 8 renames esbuild and Rollup options.**
  Detect: `rg -n 'esbuild|rollupOptions' nuxt.config.ts modules layers`.
  Change: `vite.esbuild` to `vite.oxc`. `optimizeDeps.esbuildOptions` to `optimizeDeps.rolldownOptions`. `build.rollupOptions` to `build.rolldownOptions`. Read the Vite 8 migration guide for CommonJS interop.
- **T1: unhead v3 drops promise input and narrows `useHead` types.**
  Detect: `rg -n -A3 'use(Head|SeoMeta)\(' app layers`, then find `await`, a promise, or an async function in values.
  Change: resolve values before the call, or pass a computed. Fix each new type error.
- **T2: `enabled` option for `useFetch` and `useAsyncData`.**
  Detect: `immediate: false` with a `watch` that calls `execute`, or a handler that returns `null` under a condition.
  Change: pass `enabled: () => condition`. Delete the watch.
- **T1: `<NuxtLink custom>` no longer prefetches by itself.**
  Detect: `rg -n '<NuxtLink[^>]*\bcustom\b' app layers`.
  Change: read `prefetch` and `shouldPrefetch` from the slot. Call `shouldPrefetch('interaction') && prefetch()` on `pointerenter` and `focus`.
- **T2: `useLayout()` returns the resolved layout.**
  Detect: `rg -n 'meta\.layout' app layers`.
  Change: use `useLayout()`.
- **T2: `import.meta.envName` holds the `--envName` value.**
  Detect: runtime config or environment reads that only carry the environment name.
  Change: use `import.meta.envName`.
- **T3: `experimental.ssrStreaming`.** Follow-up. Test status codes, headers, and cookies that code sets after render starts.
- **T3: `experimental.prefetchPreloadTags`.** Follow-up. Measure navigation before and after.
- **T3: `tracingChannel`.** Follow-up when the site adds OpenTelemetry.

## 4.6

- **T0: `nuxt/server` and explicit server imports.** Read [server imports](server-imports.md).
- **T1: top-level `prerender` replaces `nitro.prerender`.**
  Detect: `rg -n -B2 'prerender:' nuxt.config.ts`, inside `nitro`.
  Change: move the block to top-level `prerender`. Move `nitro.routeRules` to top-level `routeRules` too.
- **T1: `typescript.tsConfig` is a shared baseline.** `appTsConfig` and `serverTsConfig` override per context.
  Detect: `rg -n tsConfig nuxt.config.ts`.
  Change: move server-only options to `typescript.serverTsConfig`.
- **T2: `app/types/` and `server/types/` join the right tsconfig.**
  Detect: ambient `.d.ts` files wired through manual `include` entries.
  Change: move them into `app/types/` or `server/types/`. Delete the manual include.
- **T2: `experimental.strictRouteTypes` rejects `$fetch` calls to paths that do not exist.**
  Change: enable it after typed `$fetch` passes. If dynamic paths make it noisy, skip it with a reason.
- **T2: `experimental.early404` answers unknown paths before the Vue app starts.**
  Detect: `rg -n 'addRoute\(' app layers`, a root catch-all page, or middleware that redirects unknown paths.
  Change: if none exist, enable it. Then `curl` an unknown path for a 404, and each route type for its normal status.
- **T2: `experimental.prerenderErrorPages` writes a real `404.html`.**
  Detect: a static or mostly prerendered deploy.
  Change: enable it. Check that `.output/public/404.html` holds rendered HTML.
- **T2: `experimental.stripNeverHydratedData` keeps data out of the payload.**
  Detect: `rg -n hydrate-never app layers`.
  Change: enable it when the site has `hydrate-never` components. For one call, pass `serialize: false`.
- **T2: addons for `createUseFetch` with `defineUseFetchAddon`.**
  Detect: refresh on focus, polling, or retry logic repeated across fetch calls.
  Change: write one addon. Pass it in `addons`.
- **T2: `<NuxtLink>` to a `public/` file needs no `external`.**
  Detect: `rg -n '<NuxtLink[^>]*external' app layers`, then keep only links to files in `public/`.
  Change: delete `external`.
- **T2: new dev warnings.** Nuxt warns about a payload over 100 kB, a `noScripts` route that needs JavaScript, and a `public/` file that shadows a route.
  Detect: run `nuxt dev` and open the main routes.
  Change: fix each warning, or record why it stays.
- **T3: Vue Vapor, `@nuxt/vite-server`, and `appSecret` sessions.** Out of scope.
