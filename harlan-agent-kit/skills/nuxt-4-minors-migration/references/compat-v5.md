# Compatibility Version 5

Tier 0. Set it in every app and layer `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  future: { compatibilityVersion: 5 },
})
```

Then do three things:

1. Delete options that now repeat a default, such as `typedPages: true` or `viteEnvironmentApi: true`.
2. Find every option that undoes a default below. Try to remove it. Keep it only with a comment that names the blocker and links the issue.
3. Work through each default below. Each one names the detection, the fix, and the opt-out key.

Run every `rg` from the app root. Add layer directories when the site has layers.

## Defaults That Change On 4.6

### Server auto-imports off

`experimental.nitroAutoImports: false`. Follow [server imports](server-imports.md). Never keep `nitroAutoImports: true` as the fix.

### Vite Environment API

`experimental.viteEnvironmentApi: true`. Vite plugins register per environment.

- Detect: `rg -n "extendViteConfig\(|vite:extendConfig|vite:configResolved|addVitePlugin\(" modules layers nuxt.config.ts`
- Fix: replace `extendViteConfig(fn, { server: false })` and `isClient` checks in hooks with a Vite plugin that uses `configEnvironment(name, config)` and `applyToEnvironment(env)`. A plugin added with `{ client: false }` or `{ server: false }` no longer runs its `config` hook.
- An existing `viteEnvironmentApi: false` usually guards a module that breaks. Remove it, build, and read the error. Keep it only with the module named in a comment.
- Opt-out: `experimental.viteEnvironmentApi: false`.

### Case-sensitive routing

`router.options.sensitive: true`. `/About` no longer matches `pages/about.vue`.

- Detect links with capitals: `rg -n "(to|href)=\"/[^\"]*[A-Z]" app` and `rg -n "navigateTo\('/[^']*[A-Z]" app`.
- Detect inbound traffic: for a site in NuxtSEO, check Search Console pages for mixed-case paths with the `nuxtseo` CLI. Load the `nuxtseo-cli` Skill first.
- Fix: correct the link casing. If indexed mixed-case URLs exist, add a server middleware that redirects them with 301 to the lowercase path.
- Opt-out: `router.options.sensitive: false`.

### Typed pages

`experimental.typedPages: true`. Route names and paths in `navigateTo`, `<NuxtLink>`, `useRoute`, and `router.push` are type-checked.

- Detect: run typecheck. Fix each wrong route reference.
- Routes added at runtime need an augmentation of the generated route types.
- Opt-out: `experimental.typedPages: false`.

### Typed `$fetch`

`experimental.routeTypedFetch: true`. `$fetch` and `useFetch` are typed from generated route types, including validated `body`, `query`, and `headers`.

- `params` is no longer accepted. Detect: `rg -n "params:" app server shared` near `$fetch`, `useFetch`, or `useLazyFetch`. Rename to `query`.
- Hand-written `InternalApi` augmentations are ignored. Detect: `rg -n "interface InternalApi" .`. Move them to `ServerRoutes` on `@nuxt/schema`, with `Endpoint` from `nuxt/app`.
- Fix each new typecheck error. Most are real request shape bugs.
- Opt-out: `experimental.routeTypedFetch: false`.

### Error response format

`experimental.inlineErrorRendering: true`. A page error returns the error page. A server route or server middleware error returns JSON. Request headers no longer decide the format.

- Detect server middleware that throws for page routes: `rg -n "createError|throw " server/middleware`.
- Fix: move a check that should show the error page into route middleware in `app/middleware/`.
- Detect code that reads a JSON error body from a page request: `rg -n '\$fetch\(' app`, then read each call to a path outside `/api/`. Read the status instead.
- Opt-out: `experimental.inlineErrorRendering: false`.

### Vue Options API off

`vue.optionsApi: false`. The Options API runtime is compiled out of the client bundle.

- Detect own components: `rg -l -U "export default \{[\s\S]*?(data\s*\(|methods\s*:|computed\s*:\s*\{|watch\s*:\s*\{|mounted\s*\()" app layers --glob "*.vue"` and `rg -n "defineComponent\(\{[\s\S]*?data\s*\(" -U app`.
- Detect dependencies: `rg -l -U "data\(\)\s*\{\s*return|methods:\s*\{" node_modules/<direct dependency>/dist`, for each direct dependency that ships Vue components.
- A component that uses `data` or `methods` renders without them and throws no error. Open every page that uses a flagged component in a browser.
- Fix: convert own components to `<script setup>`. For a dependency, upgrade it, or replace it.
- `defineNuxtComponent` is unaffected.
- Opt-out: `vue.optionsApi: true`, with the dependency named in a comment.

### Comment placeholders for client-only components

`experimental.clientNodePlaceholder: true`. A `.client.vue` component renders `<!--placeholder-->` on the server, so `class` and `style` on it no longer reserve space. This can add layout shift.

- Detect: list client components with `rg --files -g "*.client.vue" app layers`, then find usages that pass `class`, `style`, or a size.
- Fix: wrap the component in `<ClientOnly>` and move the sizing to a `#fallback` element.
- Opt-out: `experimental.clientNodePlaceholder: false`.

### Early return from `navigateTo`

`experimental.navigateToEarlyReturn: true`. A top-level `await navigateTo()` in `<script setup>` stops the rest of `setup()` when it succeeds.

- Detect: `rg -n -A3 "^\s*await navigateTo\(" app layers --glob "*.vue"`.
- Fix: move code that must run before the redirect above it.
- Opt-out: `experimental.navigateToEarlyReturn: false`.

### Payload extraction `'client'`

`experimental.payloadExtraction: 'client'`. A prerendered or cached page inlines its payload in the HTML and fetches `_payload.json` only on client navigation.

- Detect an explicit opt-out: `rg -n "payloadExtraction" nuxt.config.ts layers`.
- Remove `payloadExtraction: true` unless a test or a cache rule depends on `_payload.json` for the first render.
- Opt-out: `experimental.payloadExtraction: true`.

### `clearNuxtState` resets to the initial value

`experimental.defaults.useState.resetOnClear: true`.

- Detect: `rg -n -A3 "clearNuxtState\(" app layers`. Look for checks against `undefined` after the call.
- Fix: compare with the initial value.
- Opt-out: `experimental.defaults.useState.resetOnClear: false`.

### Non-async `callHook`

`experimental.asyncCallHook: false`. `callHook` may return `void`, so `.then()` and `.catch()` on it throw.

- Detect: `rg -n "callHook\([^)]*\)\s*\.(then|catch)" .` with `--glob "!node_modules"`.
- Fix: `await` the call.
- Opt-out: `experimental.asyncCallHook: true`.

### Server-only head composables

`useServerHead`, `useServerHeadSafe`, and `useServerSeoMeta` are no longer auto-imported. `unhead.legacy` is ignored. Capo sorting is always on.

- Detect: `rg -n "useServer(Head|HeadSafe|SeoMeta)\(" app layers` and `rg -n "legacy:" nuxt.config.ts`.
- Fix: wrap `useHead` or `useSeoMeta` in `if (import.meta.server)`, or import the composable from `#app`. Remove `unhead.legacy`.

### PostCSS defaults off

`autoprefixer` and `cssnano` are no longer configured for the Vite builder. Vite minifies CSS already.

- Detect: `rg -n "postcss" nuxt.config.ts package.json`.
- Keep `autoprefixer` only if `browserslist` targets need prefixes. Then name it in `postcss.plugins`.

### Keyed composables need `source`

An `optimization.keyedComposables` entry without a string `source` no longer matches through its auto-import.

- Detect: `rg -n -A6 "keyedComposables" nuxt.config.ts layers modules`.
- Fix: add `source` with the module path that exports the composable.

### Other defaults

These rarely need code changes. Check the detection once.

| Default | Detect | Fix |
| --- | --- | --- |
| `normalizePageNames: true` | `rg -n "<KeepAlive" app` with `include` or `exclude` | Use route names in the filter. |
| `extractSerializablePageMeta: true` | `rg -n "pages:extend" modules nuxt.config.ts` | Expect serialized meta on the route record. |
| `watcher: 'builder'` | `rg -n "watcher:" nuxt.config.ts` | Remove an explicit watcher unless the site watches files Vite ignores. |
| `noUncheckedSideEffectImports` | typecheck errors on `import './x.css'` | Add `declare module '*.css' {}` in `app/types/`. |
| No `baseUrl` in generated tsconfigs | `rg -n "baseUrl" nuxt.config.ts tsconfig.json` | Remove it. Make relative `alias` entries absolute with `fileURLToPath(new URL('./x', import.meta.url))`. |

## Nuxt 5 Preparation On 4.6

Tier 1. Nuxt 5 removes these. They work on 4.6, so change them now.

- **`NUXT_B5023`: a config file loaded through `jiti`.**
  Detect: the warning in build output. The trial on harlanzw.com hit it for `import ... from './build/warnings'` in `nuxt.config.ts`.
  Fix: add the real extension (`.ts`) to relative imports in `nuxt.config.ts`, `modules/`, and layer configs. Replace `enum`, `namespace`, and parameter properties there with plain code.
- **`process.client`, `process.server`, `process.dev`.**
  Detect: `rg -n 'process\.(client|server|dev|browser)\b' app layers modules`.
  Fix: `import.meta.client`, `import.meta.server`, `import.meta.dev`.
- **Removed experimental options.**
  Detect: `rg -n 'externalVue|renderJsonPayloads|parseErrorData' nuxt.config.ts layers`.
  Fix: delete them. With `parseErrorData: false`, also delete `JSON.parse(error.data)`.
- **Redirect route rule `statusCode`.** Keep it on Nuxt 4.
  nitropack v2 reads only `redirect.statusCode`, so a renamed `status` is ignored and the redirect falls back to the default code instead of a 301. Typecheck reports the renamed key as `TS2353`.
  Rename it to `status` only when the site moves to Nuxt 5.
- **`nitro.typescript.tsConfig`.**
  Detect: `rg -n -A3 'typescript:' nuxt.config.ts`, inside `nitro`.
  Fix: move it to `typescript.serverTsConfig`.
- **`.tsx` or `.jsx` files.**
  Detect: `rg --files -g '*.{tsx,jsx}' app layers`.
  Fix: add `@vitejs/plugin-vue-jsx` as a dev dependency.
- **Remote layers.**
  Detect: `rg -n 'extends:.*(github|gitlab|gh):' nuxt.config.ts`.
  Fix: add the layer to `package.json` as a git dependency pinned to a commit. Extend it by package name.
