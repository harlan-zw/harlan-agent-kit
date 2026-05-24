---
name: pkg-conform
description: Use when user asks to "conform package", "check standards", "sync package", "audit project config", "update catalogs", "add github actions", "setup eslint", "configure vitest", "init package", "create npm package", "scaffold project", "init nuxt module", "create nuxt module", "scaffold module", "sync nuxt module", "add playground", "setup test fixtures", "configure @nuxt/test-utils", or needs help with pnpm workspace catalogs, obuild config, standard npm package architecture, Nuxt module architecture, runtime vs build-time code, addImports, addServerHandler, or nuxt-module-builder.
user_invocable: true
---

# Package Conform Skill

Conform a package to standardized architecture, or scaffold a new one.

## Usage

```
/pkg-conform              # conform existing project
/pkg-conform my-package   # scaffold new package
```

## Behavior

1. **New project**: scaffold with all standards below
2. **Existing project**: compare and offer to sync each component

## Detection

Check for `package.json` in cwd to determine new vs existing.
Check for `packages:` in `pnpm-workspace.yaml` to detect monorepo vs single repo.
Check for `@nuxt/module-builder` in devDependencies to detect Nuxt module -> apply Nuxt-specific patterns.

### Project Type Detection

Determine project type from the **absolute path** of the working directory:

| Path pattern | Type | Description |
|-------------|------|-------------|
| `*/pkg/*` | **Package** | Published library/module -- needs exports, build, release |
| `*/sites/*` or `*/site/*` | **Site** | Nuxt app -- private, no exports, deploy not publish |

If path doesn't match either pattern, fall back to heuristics: `private: true` + `nuxt` in deps -> Site, otherwise Package.

**IMPORTANT:** The project type determines which rules apply. Do NOT apply Package-only rules (exports, obuild, test:attw, prepack, release) to Sites, and do NOT apply Site-only rules (nuxi scripts, generate, preview) to Packages.

---

## Gotchas

- **Catalog version conflicts** -- when migrating deps to `catalog:`, check that the catalog version satisfies all consumers in the monorepo. A single `catalog:` entry shared across packages with different version requirements will break.
- **obuild vs tsc** -- obuild doesn't do type-checking. If you remove `tsc` from the build, types won't be validated. Always keep `typecheck` as a separate script.
- **`module: preserve` in tsconfig** -- this is correct for packages built with obuild, but breaks Nuxt apps that need `module: esnext` or defer to `.nuxt/tsconfig.json`. Don't apply package tsconfig rules to sites.
- **ESM-only exports trap** -- removing CJS exports breaks consumers that haven't migrated to ESM. For public packages, confirm the audience before dropping `.cjs`.
- **`pnpm install` after catalog changes** -- lockfile must be regenerated. If you edit `pnpm-workspace.yaml` catalogs, always run `pnpm install` before running any other commands.
- **Nuxt module `dev:prepare` order** -- must run before `typecheck` or `test`. Missing this causes confusing "module not found" errors from auto-generated types.
- **Site vs Package misdetection** -- path-based detection (`*/pkg/*` vs `*/sites/*`) can fail for unusual directory structures. Always verify the detected type before applying rules.

---

## UnJS Conventions

Always prefer UnJS ecosystem packages over Node.js builtins:

| Instead of | Use | Import |
|------------|-----|--------|
| `path` | `pathe` | `import { join, resolve } from 'pathe'` |
| `console.log/warn/error` | `consola` | `import { consola } from 'consola'` |
| `fetch` | `ofetch` | `import { $fetch } from 'ofetch'` |
| `fs.readFile` (JSON) | `pkg-types` | `import { readPackageJSON } from 'pkg-types'` |
| `Object.assign` defaults | `defu` | `import { defu } from 'defu'` |
| `require.resolve` | `mlly` | `import { resolveImports } from 'mlly'` |
| `EventEmitter` | `hookable` | `import { createHooks } from 'hookable'` |
| `yargs/commander` | `citty` | `import { defineCommand } from 'citty'` |
| `cosmiconfig` | `c12` | `import { loadConfig } from 'c12'` |
| `git clone` templates | `giget` | `import { downloadTemplate } from 'giget'` |

**Principles:** ESM-only, minimal deps, full TypeScript, universal (Node/browser/edge)

---

## Package.json

### Package (single repo / monorepo)

See `references/pkg-package-json.md` for single repo and monorepo root templates.

### Site (Nuxt app)

See `references/site-package-json.md` for template, optional scripts, and rules.

See `references/site-structure.md` for Nuxt 4 directory layout.

See `references/site-configs.md` for nuxt.config.ts, tsconfig, eslint, .npmrc, .gitignore templates.

---

## Test Structure

```
test/
  unit/           # unit tests
    *.test.ts
  e2e/            # e2e/integration tests
    *.test.ts
  fixtures/       # test data
```

---

## Nuxt Module (when `@nuxt/module-builder` detected)

### Build-time vs Runtime

| Context | Location | Access | Registration |
|---------|----------|--------|--------------|
| Build-time | `src/module.ts` | `@nuxt/kit`, nuxt config | runs during `nuxi build` |
| App runtime | `src/runtime/app/` | Vue, `useNuxtApp()` | `addPlugin()`, `addImports()` |
| Server runtime | `src/runtime/server/` | H3, Nitro | `addServerHandler()`, `addServerPlugin()` |
| Shared | `src/runtime/shared/` | Pure JS only | import via alias |

See `references/nuxt-module-template.md` for full module.ts template with registration examples.

See `references/nuxt-module-structure.md` for directory layout and runtime rules.

---

## References

See `references/` for detailed templates:
- `references/pkg-package-json.md` - single repo and monorepo package.json templates
- `references/catalogs.md` - pnpm workspace catalogs
- `references/configs.md` - package config file templates (eslint, vitest, tsconfig, obuild)
- `references/github-actions.md` - CI/CD workflows

**Site references** (when project type is Site):
- `references/site-package-json.md` - package.json template, rules, optional scripts
- `references/site-structure.md` - Nuxt 4 directory layout and conventions
- `references/site-configs.md` - nuxt.config.ts, tsconfig, eslint, npmrc, editorconfig, gitignore

**Nuxt module references** (when `@nuxt/module-builder` detected):
- `references/nuxt-module-structure.md` - directory layout and runtime rules
- `references/nuxt-module-template.md` - full src/module.ts template
- `references/nuxt-configs.md` - vitest, tsconfig, build.config, package.json for Nuxt
- `references/nuxt-test-patterns.md` - playground, fixtures, e2e tests

---

## Sync Checklist

### Shared (all project types)

1. [ ] `pnpm-workspace.yaml` - default catalog, `ignoredBuiltDependencies`, `shellEmulator`
2. [ ] `package.json` - `type: module`, migrate deps to `catalog:`, add `packageManager`
3. [ ] `.github/workflows/test.yml` - action versions (checkout@v6, setup-node@v6)
4. [ ] `.editorconfig` - standard config
5. [ ] `.gitignore` - standard patterns
6. [ ] ESLint config - antfu + `eslint-plugin-harlanzw`. Package: `eslint.config.mjs`; Site: `eslint.config.js`
7. [ ] `tsconfig.json` - Package: `module: preserve`, `moduleDetection: force`; Site: `extends .nuxt/tsconfig.json`
8. [ ] Git hooks - `lint-staged` in devDeps, `pre-commit` runs `lint-staged`

### Package-only (when in `*/pkg/*`)

9. [ ] `vitest.config.ts` - coverage config, projects if unit + e2e
10. [ ] `tsconfig.json` - add `types: ["node", "vitest/globals"]`
11. [ ] `build.config.ts` - obuild with explicit entry points
12. [ ] Package exports - ESM-only (`.d.mts` + `.mjs`), no CJS
13. [ ] Package scripts - `obuild`, `dev:prepare`, `test:attw`, `lint:fix`, `prepack`, `release`
14. [ ] `.github/workflows/release.yml` - action versions, `bumpp --output=CHANGELOG.md`

### Site-only (when in `*/sites/*` or `*/site/*`)

9. [ ] `package.json` - `private: true`, `engines.node` set to latest stable even-numbered Node (e.g. `>=22.0.0`, `>=24.0.0`), no `exports`/`main`/`types`/`files`
10. [ ] Scripts - `dev` (nuxi dev), `build` (nuxi prepare && nuxi build), `postinstall` (nuxt prepare), `lint`, `lint:fix`, `typecheck` (nuxt typecheck)
11. [ ] `pnpm.overrides` - `vite` set to `^8.0.0`
12. [ ] `nuxt.config.ts` - `future.compatibilityVersion: 5`, `compatibilityDate`, standard module stack
13. [ ] `tsconfig.json` - just `{ "extends": "./.nuxt/tsconfig.json" }`
14. [ ] `eslint.config.js` - antfu config with `node/prefer-global/process` and `node/prefer-global/buffer` off
15. [ ] `.npmrc` - `shamefully-hoist=true`
16. [ ] `.gitignore` - includes `.nuxt/`, `.output/`, `.data/`, `.wrangler/`, `wrangler.toml`
17. [ ] `.editorconfig` - 2-space indent, LF, UTF-8, trim trailing whitespace (except `.md`)
18. [ ] `content.config.ts` - Zod schemas for content collections (if using `@nuxt/content`)
19. [ ] `app/` directory - Nuxt 4 structure (`app.vue`, `pages/`, `layouts/`, `components/`, `composables/`)

### Additional Nuxt Module Checklist

When `@nuxt/module-builder` detected, also check (extends Package checklist):

**Structure:**
15. [ ] `src/module.ts` - main module entry exists
16. [ ] `src/runtime/app/` - client/SSR code directory
17. [ ] `src/runtime/server/` - Nitro server code directory
18. [ ] `src/types.ts` - module options types
19. [ ] `playground/` - nuxt.config.ts, app.vue, pages/
20. [ ] `test/fixtures/basic/` - nuxt.config.ts

**Config:**
21. [ ] `pnpm-workspace.yaml` - add `nuxt:` catalog
22. [ ] `package.json` - nuxt module exports, peerDependencies
23. [ ] `tsconfig.json` - extends `.nuxt/tsconfig.json`
24. [ ] `vitest.config.ts` - use `defineVitestProject` for e2e
25. [ ] `build.config.ts` - nuxt externals including `#imports`
26. [ ] `eslint.config.mjs` - ignore fixtures/playground
27. [ ] `.gitignore` - nuxt build dirs

**Scripts:**
28. [ ] `typecheck` - uses `nuxt typecheck` (not `tsc`)
29. [ ] `dev:prepare` - prepares module + playground
30. [ ] `prepare:fixtures` - prepares test fixtures
31. [ ] `.github/workflows/test.yml` - includes prepare step

## Sync Process (Parallelized)

### Phase 0: Detect Project Type
Determine from cwd path whether this is a **Package** (`*/pkg/*`) or **Site** (`*/sites/*`, `*/site/*`).

### Phase 1: Parallel Config Review
Spawn these IN PARALLEL (single message, multiple tool calls):

```
Task(Explore): "Read and compare: pnpm-workspace.yaml, package.json deps. Report differences from standards."
Task(Explore): "Read and compare: .github/workflows/*.yml. Check action versions against v6 standards."
Task(Explore): "Read and compare: eslint.config.js, vitest.config.ts, tsconfig.json. Report missing options."
Task(Explore): "Read and compare: .editorconfig, .gitignore. Report missing settings."
```

**If Package**, add in parallel:
```
Task(Explore): "Read and compare: build.config.ts, package exports, release scripts. Report missing settings."
```

**If Site**, add in parallel:
```
Task(Explore): "Read and compare: nuxt.config.ts, app structure (pages/, layouts/, components/). Report missing settings."
```

**If Nuxt module** (Package + `@nuxt/module-builder`), add in parallel:
```
Task(Explore): "Review src/module.ts: check registration methods, resolver usage, module options. Report issues."
Task(Explore): "Review src/runtime/app/: check composables export, plugins mode, imports registration."
Task(Explore): "Review src/runtime/server/: check server handlers, Nitro plugins, middleware. Verify no Vue deps."
Task(Explore): "Review playground/ and test/fixtures/: check nuxt.config, prepare scripts, test patterns."
```

### Phase 2: Apply Changes
Based on parallel review results, apply necessary updates using the appropriate checklist (Package or Site).

### Phase 3: Parallel Verification

**Package** verification:
```
Bash(background): pnpm install
Bash(background): pnpm lint
Bash(background): pnpm typecheck
```
Then sequentially (depends on install):
```
Bash: pnpm build
Bash: pnpm test --run
```

**Site** verification:
```
Bash(background): pnpm install
Bash(background): pnpm lint
Bash(background): pnpm typecheck  # Uses nuxt typecheck
```
Then sequentially:
```
Bash: pnpm build  # nuxi build
```

**Nuxt module** verification:
```
Bash: pnpm dev:prepare && pnpm prepare:fixtures
Bash(background): pnpm lint
Bash(background): pnpm typecheck  # Uses nuxt typecheck
Bash: pnpm test:run
```
