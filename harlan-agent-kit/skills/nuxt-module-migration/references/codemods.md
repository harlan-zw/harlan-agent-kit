# Codemods

Use automation for repeated changes whose meaning stays fixed.
Keep server behavior changes separate from mechanical changes.

## Manifest support contract

The bundled script updates one published module manifest.
It requires an existing Nuxt peer and rejects private fixture manifests.
It sets Nuxt and existing schema peers, Node engines, and the runtime Kit dependency.
It preserves unrelated peers and package versions.
It preserves Kit catalog references and reports the required catalog change.

Run with Node 22.22.3 or newer, from a task-owned Worktree:

```sh
node /path/to/nuxt-module-migration/scripts/migrate-manifests.ts package.json
node /path/to/nuxt-module-migration/scripts/migrate-manifests.ts package.json --apply
```

The default prints proposed JSON without writing.
Review it before applying. The script refuses writes in a primary checkout.
Update catalogs, module metadata, fixtures, workflows, locks, and documentation separately.
Run the support lanes after installing the new graph.
Do not treat a manifest transform as a completed migration.

## Source transforms

Use Ripast for AST-aware source moves and imported-symbol replacement.
Read its current CLI help. New commands can precede the installed Skill's command table.
Scan first, inspect the dry run, then apply and verify.
If replacing an imported symbol with a project export, include the target during resolution.
Inspect its implementation separately. A replacement that rewrites its own native import can create a recursive self-import.

Repeated opportunities from the rollout:

| Transform | Safe boundary | Exclusions |
| --- | --- | --- |
| Own package metadata reads | A known package.json path and native JSON parsing | Package discovery, config parsing, optional resolution |
| Context-only event types | `Pick<RequestEvent, 'context'>` | Full event consumers and builder-specific hook callbacks |
| Error option names | Literal options passed to portable `createError` | ofetch errors, Node responses, dynamic objects |
| Unhead 2 removal | Nuxt 4.6 host metadata | Unrelated external integration contracts |
| Native Web Crypto | Existing `randomUUID` or `subtle` calls | Hash serialization and persisted key formats |

Do not globally replace h3 imports with `nuxt/server`.
Do not globally rename server auto-import aliases.
Nuxt 4.6 uses `#imports` in its Nitro 2 server context.
The pinned Nuxt 5 Nitro 3 fixture uses `#imports/server` instead.
Prefer explicit module-owned server aliases when both builders expose them.
Nitro cache handlers, websocket handlers, SSE, streaming, and hook events still need builder-specific APIs.
`event.path` includes query data in some contracts. `event.url.pathname` does not.
Returning a redirect or CORS response changes control flow and needs behavior tests.
Never replace `statusCode` globally. It remains valid for Node responses and some fetch errors.
Nuxt exports `NuxtError` and `NuxtErrorLike`, rather than an `HttpError` type.
Choose the type according to creation or caught-error behavior. Skip ambiguous `H3Error` replacements.
Check emitted import specifiers after AST changes. A local `.ts` import can survive into unusable published JavaScript.

Prefer a narrow, proven transform over a general migration recipe.
Add another bundled transform only after matching real call sites and documenting exclusions.
