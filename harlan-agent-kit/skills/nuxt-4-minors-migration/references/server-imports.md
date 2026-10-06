# Server Imports

Tier 0. Do this before you turn on compatibility version 5, or straight after if it is already on.

## Why

On Nuxt 4.6, `future.compatibilityVersion: 5` sets `experimental.nitroAutoImports` to `false`.
Nitro then auto-imports nothing in `server/`: no h3 helpers, no Nitro runtime helpers, no module helpers, and no `server/utils` or `shared/utils` exports.

Two facts make this dangerous. Both were verified on Nuxt 4.6.0.

1. **The build still passes.** A handler that calls an auto-imported `defineEventHandler` builds with exit 0. At runtime it returns 500, because the name is undefined.
2. **Modules hide the gap.** `addServerImports` in `@nuxt/kit` runs `config.imports ||= {}`. That replaces `imports: false`, so any module that calls it turns every server auto-import back on, and the generated types too. `nuxt-site-config`, `@nuxtjs/sitemap`, `@nuxtjs/robots`, and `@nuxt/image` all call it. A site works today by accident. It breaks the day Nuxt fixes this, or the day the site drops its last such module.

[nuxt/nuxt#36468](https://github.com/nuxt/nuxt/pull/36468) makes kit leave `imports: false` alone. Once a release ships it, nothing in `server/` is auto-imported on 4.x under compatibility version 5, module helpers included.

So neither the build nor typecheck is the gate. Make every server import explicit, then prove it with the codemod dry run.

Nuxt 5 behaves differently from 4.6 here. It drops only the h3 and Nitro helper auto-imports, and keeps `server/utils`, `shared/utils`, and module helpers.
The codemod makes `server/utils` and `shared/utils` imports explicit too, because on 4.6 they work only while some module calls `addServerImports`.

## Codemod

`scripts/explicit-server-imports.ts` in this Skill reads the auto-import list Nuxt generated, then adds the explicit import each server file needs.
It keeps behaviour identical: each name comes from the same module the auto-import used.

| Auto-import source | Explicit import |
| --- | --- |
| h3 helpers | `h3` |
| Nitro runtime helpers | `nitropack/runtime` |
| `server/` files | `#server/...` |
| `shared/` files | `#shared/...` |
| A module's runtime file | The module's alias, such as `#site-config/...`, or its package export |
| A layer file outside these aliases | A relative path |

### Run it

Run each step from the Nuxt app root. In a monorepo, run it once per app.

1. If compatibility version 5 is already on, add `experimental: { nitroAutoImports: true }` for now. It guarantees a full auto-import list.
2. Run `nuxt prepare`.
3. Dry run, and read the report:

   ```bash
   node --experimental-strip-types <skill>/scripts/explicit-server-imports.ts --root .
   ```

   Pass `--server-dir` once per server directory. Pass `--shared-dir` once per shared directory. The defaults are `server` and `shared`. Add the server and shared directories of each layer, and the `src/runtime/server` directory of each local module that relies on auto-imports.
4. Apply: add `--write`.
5. Fix every line under "Unmapped auto-imports". See [names the script does not import](#names-the-script-does-not-import).
6. Remove the temporary `nitroAutoImports: true`. Run `nuxt prepare`.
7. Run ESLint with `--fix` on the changed directories only, such as `eslint --fix server shared`. It merges and sorts the new imports. A repository-wide `lint:fix` also rewrites unrelated files, such as Markdown, so revert anything outside the change.
8. Run the dry run again. **It must report `Would change 0 of N files` and exit 0.** This is the gate.

The script uses the project's own TypeScript. It never imports a name the file already binds anywhere, so a rare shadowed name stays missing. Typecheck reports that case as `TS2304`.

### Names the script does not import

The report has two lists.

**"Left as auto-imports"** holds module helpers with no alias and no package export. Whether they keep working depends on the installed `@nuxt/kit`:

- Check for the kit fix: `rg -c "config.imports === false" node_modules/@nuxt/kit/dist`.
- Without it, the module that provides the helper calls `addServerImports`, which turns server auto-imports back on. Leave the helper.
- With it, nothing in `server/` is auto-imported on 4.x under compatibility version 5, so the helper fails at runtime. Ask the module to export it, or keep `experimental.nitroAutoImports: true` with a comment that names the helpers until it does.
- On Nuxt 5, server auto-imports drop only the h3 and Nitro helpers. Helpers that modules register, and `server/utils` and `shared/utils` exports, stay auto-imported. This was checked against `packages/nitro-server/src/index.ts` on `nuxt/nuxt` `main` on 2026-10-06.

Seen on 2026-10-06: `nuxt-auth-utils` (`getUserSession`, `requireUserSession`, `setUserSession`), `@nuxtjs/turnstile` (`verifyTurnstileToken`), `evlog` (`useLogger`), and `@harlan-zw/nuxt-wide-events` (`createWideEvent`).

**"Unmapped auto-imports"** needs a fix by hand. The script exits with code 1 while any remain.

- `nitroPlugin`: use `defineNitroPlugin` from `nitropack/runtime`.
- An `#internal/...` source: find the public export of the same helper, or rewrite the code without it.

If the script refuses with "points at a nitropack install that does not exist", the `.nuxt` directory is stale. Install dependencies, run `nuxt prepare`, and run the script again.

## Move To `nuxt/server`

Tier 2. Do this after the gate passes.

`nuxt/server` (4.6) is the portable server surface. A handler written against it runs unchanged on Nuxt 5 and Nitro v3.
The codemod lists "Portable to `nuxt/server`" files. Every server helper those files use behaves the same there, and they read only `event.req`, `event.url`, `event.res`, and `event.context`.

For each portable file:

1. Change the `h3` and `nitropack/runtime` imports to `nuxt/server`.
2. Replace `useRuntimeConfig(event)` with `useRuntimeConfig()`.
3. Rename `statusCode` and `statusMessage` in `createError` to `status` and `statusText`.
4. Run typecheck. If the file passes `event` to a function typed with `H3Event`, typecheck fails. Then either move that function too, or revert this file to `h3`.

Import `defineEventHandler` from `nuxt/server` in the same file as its helpers. A `nuxt/server` helper that receives an h3 event fails with `NUXT_E8012`.

### Differences From h3 v1

Read this before you move a file that the codemod did not list as portable.

| h3 v1 | `nuxt/server` |
| --- | --- |
| `sendRedirect(event, to)` sends the response. | Return it: `return sendRedirect(event, '/login')`. |
| `getRouterParam(s)` decode values. | They return raw values. Pass `{ decode: true }`. |
| `handleCors` returns `true` for a preflight. | It returns the preflight `Response` or `false`. Return the response. |
| `handleCors` accepts one origin string. | Pass an array of origins. `maxAge` is a string of seconds. |
| `readValidatedBody` and `getValidatedQuery` take a function. | They take a Standard Schema or a function. |
| `createError({ statusCode, statusMessage })` | `createError({ status, statusText })` |
| `isError(error)` | `isNuxtError(error)` |
| `useSession` seals an `h3` cookie with your `password`. | It seals a `nuxt-session` cookie with a secret from `appSecret`. Existing sessions end. Needs approval. |
| `useRuntimeConfig(event)` | `useRuntimeConfig()` |
| Global `$fetch` | `serverFetch(event, path)` for app routes, plain `fetch` for others. |
| `event.path` | `event.url.pathname` |
| `event.node` | `event.req` and `event.res` |
| `getResponseHeader`, `setResponseHeader`, `appendResponseHeader`, `removeResponseHeader` | `event.res.headers.get()`, `.set()`, `.append()`, `.delete()` |
| `getMethod`, `isMethod`, `assertMethod` | Compare `event.req.method`. |
| `readMultipartFormData(event)` | `await event.req.formData()` |
| `readRawBody(event)` | `await event.req.arrayBuffer()` or `.text()` |

Keep a handler on `h3` or `nitropack/runtime` when it needs a helper outside `nuxt/server`: `useStorage`, `defineCachedEventHandler`, `defineNitroPlugin`, `defineTask`, `proxyRequest`, or a module helper typed with `H3Event`, such as `getSiteConfig(event)` or `requireUserSession(event)`.

## Sessions And `appSecret`

Tier 3 unless Harlan approves. `nuxt/server` sessions and `deriveSecret` read `runtimeConfig.appSecret`, set by `NUXT_APP_SECRET`.
Builds never generate it. Each deployed environment needs the secret before any code uses it.
`nuxt-auth-utils` keeps its own session helpers and `NUXT_SESSION_PASSWORD`. Leave them alone.
