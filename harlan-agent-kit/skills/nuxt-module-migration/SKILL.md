---
name: nuxt-module-migration
description: Migrate Nuxt modules to Nuxt 4.6 or newer and prepare major releases for Nuxt 5. Remove Nuxt 3 support, adopt portable server APIs, reduce installed dependencies, audit native Node replacements, and separate optional DevTools packages.
license: MIT
compatibility: "Designed for Harlan Agent Kit workflows. Requires repository access and the tools named in this Skill."
---

# Nuxt module migration

Use for a Nuxt module whose next major requires Nuxt 4.6 or newer.
Use for one module or a coordinated collection, including shared packages and the meta module.
Research the exact target release before editing. Nuxt 5 remains a moving target.

## Establish the contract

Read repository instructions, manifests, workspace catalogs, public exports, build configuration, fixtures, and workflow commands.
Read `GLOSSARY.md` before names or documentation. Read `COPY.md` before user-visible strings when present.
Evaluate installed Skills. Load the relevant ones before changing code.
Use the `pr` Skill for repository edits and delivery. Acquire a task-owned Worktree before mutation.

Record the minimum Nuxt release, Node range, supported server builders, deployment targets, and next major for each package.
Record producer and consumer relationships. Include shared runtime packages and optional UI packages.
Separate a research request from authorization to migrate or publish packages.
Preserve published package versions during migration. Bump versions only when the user explicitly authorizes release preparation.

For the Nuxt 4.6.0 baseline:

| Surface | Contract |
| --- | --- |
| Nuxt peer and module metadata | `^4.6.0 || ^5.0.0` |
| Build-time Kit dependency | `@nuxt/kit@^4.6.0`, declared in dependencies |
| Node engine | `^22.22.3 || ^24.15.0 || >=26.0.0` |
| Runtime Unhead | Audit against v3; Nuxt 4.6.0 installs `@unhead/vue@^3.4.2` |
| Runtime Vue and router | Audit against Vue `^3.5.43` and Vue Router `^5.3.1` |

These are release-specific inputs, not permission to add every peer to every package.
Raise existing peers when the package imports or exposes that API.
Nuxt 5 prereleases need deliberate fixture resolution; `^5.0.0` does not accept them through normal semver matching.
Do not widen the supported range to all future majors.

Sources: [published Nuxt manifest](https://github.com/nuxt/nuxt/blob/v4.6.0/packages/nuxt/package.json),
[release notes](https://github.com/nuxt/nuxt/releases/tag/v4.6.0),
[module compatibility](https://nuxt.com/docs/4.x/guide/modules/server-compatibility).

## Audit before replacement

Capture the production dependency graph and packed artifact for each module.
Measure direct dependencies, unique resolved package identities, compressed tarball bytes, and unpacked bytes separately.
Use a clean consumer to measure installed dependencies. A maintainer workspace includes development tools and peer resolutions.
Never add per-module totals together and call that a collection total.

Classify each dependency as build-time, portable runtime, Node runtime, optional integration, or DevTools.
For this migration, prefer native APIs where verified equivalent, even if `pkg-conform` recommends an UnJS dependency.
Trace imports from every public export. A subpath export or dynamic import still installs declared dependencies.
Record concrete removals and shared transitive dependencies that remain reachable.
Do not promise a reduction before comparing clean installations.

Read these references before their corresponding changes:

- [Nuxt API migration](references/nuxt-apis.md): server events, types, Kit APIs, and earlier 4.x features.
- [Native Node APIs](references/native-node.md): replacement candidates and semantic limits.
- [Optional DevTools](references/devtools.md): package boundaries and loading behavior.
- [Verification and release order](references/verification.md): fixtures, runtime proof, and coordinated release requirements.
- [Codemods](references/codemods.md): dry-run manifest automation and safe source-transform boundaries.

## Implement the migration

1. Set the minimum in module metadata, published peers, engines, catalogs, fixtures, and workflows.
2. Remove Nuxt 3 branches, fixtures, adapters, old API paths, and documentation claims.
3. Replace portable server work with explicit `nuxt/server` imports and `RequestEvent` types.
4. Retain explicit Nitro 2 and Nitro 3 implementations where caching, plugins, storage, or tasks require them.
5. Register curated app and server runtime aliases with their generated TypeScript contexts.
6. Remove redundant dependencies and separate optional DevTools code from core installation.

Load `ts-design-patterns` for non-trivial API changes.
Load `unit-tests` before new regression tests. Reproduce bugs with a failing behavior test first.
Use Ripast for mechanical changes spanning files.
Keep expected errors explicit. Avoid casts that hide event or server-builder incompatibility.
Delete compatibility scaffolding only when the remaining imports and behavior prove it unnecessary.

## Verify and hand off

Keep existing tests and workflow structure. Follow the verification reference for version aliases and targeted checks.
Preserve existing CI configuration, including its LTS selector. Change workflows only to fix verified migration blockers.
Exercise meaningful module output, including supported deployment targets affected by the change.
Measure dependency changes in equivalent clean consumers.
Show each removal, retained dependency reason, artifact delta, and remaining untested path.
Open the required pull requests. Keep shared changes ordered before their consumers.
When publication is authorized, use the repository's release workflow and verify registry artifacts.
Do not publish from a research-only request.
