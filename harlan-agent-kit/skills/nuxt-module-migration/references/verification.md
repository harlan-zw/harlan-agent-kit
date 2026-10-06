# Verification and release order

## Three Nuxt lanes

| Lane | Dependency | What it proves |
| --- | --- | --- |
| Minimum supported Nuxt | Exact `nuxt@4.6.0` | New APIs work on the declared floor, using Nitro 2 |
| Future defaults | Exact `nuxt@4.6.0`, `future.compatibilityVersion: 5` | Future routing, head, types, and bundler defaults |
| Actual Nuxt 5 | Exact Nuxt 5 nightly or release | Nitro 3, h3 2, and changes the compatibility flag cannot enable |

Discover the Nuxt 5 nightly through `pnpm view nuxt-nightly dist-tags --json`.
Resolve `5x` to an exact version and commit it with the fixture lockfile.
Do not assume `nuxt-nightly@latest` is Nuxt 5.
Record the actual Nuxt, Nitro, h3, Vue, and router versions in test evidence.
Refresh pins before a release rather than silently floating a required check.
Check the nightly's own Node engine before assigning it to a Node lane.

Set `future.compatibilityVersion` at the top level of the Nuxt configuration.
An `experimental.future` object does not enable that lane.
The future flag does not upgrade Nitro on Nuxt 4.
Source: [versioned Nuxt upgrade guide](https://github.com/nuxt/nuxt/blob/v4.6.0/docs/1.getting-started/18.upgrade.md#testing-nuxt-5).

Run the Node 22.22.3 floor and a supported newer LTS for the stable Nuxt lanes.
Run server-only unit tests in Node, rather than a browser emulator.
Node 22's prefix-only `node:sqlite` can fail Vite resolution in browser environments.
Use a supported Node version for the exact Nuxt 5 nightly.
If claiming Windows tooling support, run filesystem and resolution cases there.
Exercise Cloudflare or other supported edge targets where server code changes.
Build packed consumers and serve them through local workerd. Assert real HTTP output and forwarded request context.
Check the local Wrangler version supports the fixture's compatibility date before diagnosing module failures.
Keep local Worker evidence separate from remote production and database adapter evidence.
Use the repository's workflow for production deployment.
Require an explicit opt-in for tests that deploy remotely.
An authenticated CLI alone must not enable a deployment test.

## Packed consumers

Build and pack the producer before testing consumers.
Run packing after checks that rebuild the same package finish.
Concurrent prepack hooks can delete artifacts that another check is loading.
Use isolated fixtures outside the workspace dependency graph.
Install only the tarballs and documented consumer dependencies.
Avoid `link:` fixtures as the only proof of published exports and dependencies.
Remove inherited fixture lockfiles before creating isolated consumers with different dependency specifications.
A stale `link:` resolution can survive a changed `file:` specification and bypass the packed artifact.
Audit every runtime import against published dependencies, including optional feature paths.
Workspace development dependencies can conceal missing runtime declarations.
For bundled modules, test the meta module alone without direct submodule dependencies or explicit registration.
Resolve pinned nightly metadata through the meta package's dependency context when necessary.
Distinguish disabled features from absent packages. Required dependencies remain installed when their features are disabled.
Run packed development SSR and server requests in all three Nuxt lanes.
Production bundling can conceal development externalization and unresolved runtime aliases.
Check Vite transpilation for app runtime code that imports Nuxt virtual aliases.
Check Nitro 2 inline coverage for the full reachable runtime graph, including shared files outside server directories.
Exercise development-only hooks and disabled-module mocks through their public aliases.
Use immutable tarball paths. Record checksums and verify the delivered artifact contains the final source changes.
For pnpm 11 and 12 packing, use `--config.ignore-scripts=true`. Require a successful pack before hashing or copying artifacts.
A reused tarball path can preserve stale package-manager cache entries.
Put temporary tarball overrides in `pnpm-workspace.yaml` with pnpm 12.
Do not assume `package.json#pnpm.overrides` changes the resolved graph.
Pass cross-repository artifacts through `NUXT_TEST_TARBALLS`, a package-to-absolute-path JSON map.
Copy the repository's pinned `packageManager` into isolated fixtures too.
A different pnpm major can enforce a different dependency trust decision.
If resolution hangs, reproduce it with a minimal pinned consumer before changing dependencies.
Nuxt 5 nightly resolution stalled on pnpm 11.2 and completed on 11.22 during the Harlan Nuxt migration.
Pin the affected lane to a verified package manager version that fixes resolution.
Check every lane before changing the repository's package manager pin.
Keep the same supply-chain policy.
Copy the repository's existing trust age policy and approved build scripts into isolated fixtures.
Keep exact approved trust exceptions. Never disable the policy to make tests pass.
Check declaration resolution and the app, server, shared, and Node TypeScript contexts after preparation.
Check ESM package roots through Node 22 `require(ESM)` and Nuxt's Jiti configuration loader.
An import-only exports map can fail those loaders. Add a compatible `default` ESM entry when needed.

Stable `^5.0.0` module metadata excludes Nuxt 5 nightly prereleases.
For the actual-nightly fixture, read each imported module's public `getMeta()` before installation.
Include transitive Nuxt modules, such as shared lifecycle modules, in that allowance.
Include the exact pinned nightly in that fixture's metadata compatibility.
Keep the published peer and metadata contracts unchanged.
Assert actual module behavior. A correct Nitro version can still accompany a disabled module.

All declared support lanes must invoke non-watch test commands through required workflow jobs.
Trace reusable workflows to their actual test command and runtime.
A script named `test:nuxt5` proves nothing if the required command never calls it.
Assert behavior rather than files, symbol existence, or exact key counts.

| Module | Meaningful output |
| --- | --- |
| Site Config | Config isolation across requests, proxy origin, base URL, and i18n |
| Robots | robots.txt, route rules, header and meta directives |
| Sitemap | XML, exclusions, i18n, external and local sources, generate, and caching |
| Schema.org | Valid JSON-LD in SSR and after client navigation |
| SEO Utils | Canonical and metadata, redirects, assets, route groups, and layers |
| OG Image | Image bytes, dimensions, caching, fonts, renderer, and edge output |
| Link Checker | Inspection, crawling, prerender reporting, and DevTools integration |
| Skew Protection | Old and new asset requests, client recovery, headers, and supported adapters |
| AI Ready | Markdown negotiation, llms.txt, sitemap, indexing, and supported database providers |
| Meta module | All modules together, user overrides, disabled modules, and cross-module hooks |

Tests can share fixtures where they exercise the same contract.
Cover optional integrations in targeted lanes rather than multiplying every combination.
Use a failing test first for defects discovered during migration.
Construct a real `Request` when testing a portable body handler.
Legacy `_body` or Node event mocks do not exercise the portable parsing boundary.
Align Vite versions across producers and Nuxt test fixtures before investigating generated type errors.
Different Vite and PostCSS graphs can produce incompatible plugin types.

## Coordinated release

Determine dependency order from manifests and imports.
Prepare shared runtime packages and Site Config before their consumers.
Handle cycles explicitly, including type-only relationships and optional peers.
Audit development installs separately from the published runtime graph. Workspace catalogs can create development-only cycles.
Filtered pnpm installs can still resolve every project through a shared workspace lockfile.
If consumer majors are unpublished, bootstrap an explicit source workspace with relative overrides and its own verified frozen lock.
Preserve supply-chain policy and full consumer CI. Publish only the foundation package allowlist through its release workflow.
Never let a recursive workspace release bump or publish a meta package whose version must stay unchanged.
Prepare DevTools artifacts and their versioned protocol alongside core packages.
Release the meta module after compatible module versions exist in the registry.

Update runtime peers, Kit dependencies, engines, catalogs, locks, examples, and compatibility claims consistently.
Remove obsolete tests and documentation for Nuxt 3 and Unhead 2 where support was dropped.
Keep unrelated renderer and database compatibility unless the release contract explicitly changes it.
Use exact prereleases for cross-repository integration if stable producers are not published yet.
Recheck package graphs and tarballs after the final dependency versions resolve.

Report registry versions and CI evidence from queries, not a permanent prose status file.
Do not claim end-to-end migration from lint or unit tests alone.
