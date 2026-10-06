# Native Node dependency replacements

Use the exact engine floor, not the major number alone.
For Nuxt 4.6.0, the floor is Node 22.22.3 within the supported engine range.
Check each candidate on that version and on supported Windows paths.
Keep Node-only APIs out of browser and portable server exports.

| Existing dependency or pattern | Native candidate | Required proof |
| --- | --- | --- |
| `tinyglobby`, `globby` file discovery | `glob` from `node:fs/promises` | Dotfiles, directories, exclusions, symlinks, ordering, and separators |
| Simple file glob checks | `matchesGlob` from `node:path` | File pattern syntax; never assume Nitro route-rule matching semantics |
| `fs-extra`, `rimraf` file operations | `cp`, `mkdir`, `rm` from `node:fs/promises` | Recursive behavior, overwrite rules, and error handling |
| URL-to-file boilerplate | `import.meta.dirname`, `import.meta.filename`, URL utilities | File-module context and TypeScript support |
| Simple package resolution | `import.meta.resolve`, `createRequire(...).resolve` | ESM versus require conditions, package origin, file existence, and optional absence |
| Simple external HTTP reads | Native `fetch`, `Request`, `Response`, `Headers` | HTTP errors, body parsing, timeout, abort, retries, and headers |
| Straight subprocess execution | `spawn`, `execFile` from `node:child_process` | Exit errors, cancellation, environment, executable resolution, and output |
| Simple digests or random identifiers | `node:crypto` or Web Crypto | Stable encoding, persisted cache keys, and deployment support |

Filesystem globbing is stable from Node 22.17.0.
It returns an async iterator, not tinyglobby's array.
Use `Array.fromAsync` or collect with `for await` when the caller needs an array.
Use `withFileTypes` and filter directories when replacing `onlyFiles`.
Node's glob exclusions do not support negation patterns. Compare existing options before replacing them.
The rollout found another mismatch: tinyglobby follows symlink directories that native glob does not traverse.
If asset discovery includes linked layers, retain tinyglobby unless a replacement proves equivalent behavior.
`path.matchesGlob` is stable from Node 22.20.0.

Sources: [filesystem APIs](https://nodejs.org/download/release/v22.22.3/docs/api/fs.html#fspromisesglobpattern-options),
[path matching](https://nodejs.org/download/release/v22.22.3/docs/api/path.html#pathmatchesglobpath-pattern),
[ESM APIs](https://nodejs.org/download/release/v22.22.3/docs/api/esm.html#importmetaresolvespecifier).

`import.meta.resolve` uses the current module's context.
Its second parent argument requires an experimental flag on this baseline.
`createRequire` accepts a parent but resolves require conditions, not arbitrary export conditions.
Do not replace `exsolve` calls using custom `style` conditions with those APIs mechanically.
Check missing-file behavior because a resolved file URL does not always prove a file exists.
Use Kit's resolver when it covers the Nuxt-specific need.

`findPackageJSON` exists from Node 22.14.0, with active-development stability.
It can replace some package discovery, but not configuration parsing or package-manager detection.
Review its resolver limitations before relying on it in public tooling.
Its base represents a containing file. Convert a directory into a file URL before resolving.
Bare package specifiers can find a root manifest hidden by the package's export map.
Absolute file specifiers select the nearest parent manifest.
It uses the default resolver and does not honor custom loader hooks.
Keep missing-package handling distinct from malformed JSON and unexpected filesystem failures.
Use it to confirm an optional package belongs to the consumer before `createRequire` loads it.
CommonJS resolution can find packages through `NODE_PATH` outside that consumer.
Prove missing-package behavior with those environment paths present.
Resolve the owning manifest with `findPackageJSON('./', import.meta.url)` when bundlers move shared chunks.
Relative `../package.json` paths can point into `dist` after packing.

Sources: [module APIs](https://nodejs.org/download/release/v22.22.3/docs/api/module.html#modulefindpackagejsonspecifier-base),
[global fetch](https://nodejs.org/download/release/v22.22.3/docs/api/globals.html#fetch).

## Retain dependencies when semantics require them

`pathe` normalizes separators. `node:path` uses platform-specific semantics.
Prefer Node paths for filesystem operations. Preserve POSIX or URL semantics explicitly where required.
The migration must verify Windows output before removing `pathe` from published tooling.

Native fetch does not replace ofetch's public `FetchOptions` and `FetchError` contracts automatically.
Sitemap source options, local request forwarding, and retry policies need explicit decisions.
Ofetch retries eligible GET failures once by default. Preserve that behavior when replacing it.
Replacing one call does not remove a dependency used by other exports.

`ohash` includes object serialization. `structuredClone` does not replace `defu` merges.
`URL` does not replace all `ufo` utilities. Native logging does not replace Nuxt's logger integration.
Avoid recreating a dependency with more local code and a weaker contract.

Node's SQLite API does not replace Cloudflare D1, remote libSQL, Neon, or PostgreSQL adapters.
Its availability alone does not justify rewriting a module's database interface.
Never enable experimental flags globally just to remove a small dependency.

## Record the result

For each dependency, record the caller, runtime, replacement, tests, and reason for retaining or deleting it.
Measure clean installation again after manifest and lockfile updates.
Report direct removals separately from total transitive reductions.
Keep expensive optional integrations outside the core graph when their behavior permits it.
