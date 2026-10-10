---
name: nuxt-4-minors-migration
description: "Upgrade a Nuxt 4 site to the latest 4.x release with `future.compatibilityVersion: 5`, then migrate code that the 4.1 to 4.6 minors deprecated or improved. Use for Nuxt minor upgrades, enabling Nuxt 5 compatibility, explicit server imports or `nuxt/server`, and adopting new Nuxt 4.x features across sites."
argument-hint: "[site path or repository]"
license: MIT
---

# Nuxt 4 Minors Migration

Move one site to the latest Nuxt 4.x release with `future.compatibilityVersion: 5` on.
Remove every API the 4.x minors deprecated. Adopt the new features that fit the site.
Ship one pull request per site.

The references cover Nuxt 4.1.0 to 4.6.0. Nuxt 4.6.0 shipped on 2026-10-05.

## Before you start

1. Check the latest 4.x release: `npm view nuxt dist-tags.latest`.
2. If a minor newer than 4.6 exists, read its notes: `agent-gh release view v4.7.0 -R nuxt/nuxt`. Apply its items with the same tiers. Report the gap, and update this Skill in a separate pull request.
3. Read the repository Agent instructions, package manager, catalogs, every `nuxt.config.ts`, layers, local `modules/`, CI Node version, and deploy target.
4. Mutate only in a task-owned `wt` worktree. Read the [worktree isolation contract](../../references/worktree-isolation.md).

Out of scope: Nuxt 2 and 3 sites, the Nuxt 5 nightly channel, Vue Vapor, and `server.builder: 'vite'`.
A published Nuxt module belongs to the [Nuxt module migration](../nuxt-module-migration/SKILL.md) Skill. This Skill covers apps, their layers, and their local `modules/`.

## Rules

- **A green build proves nothing about server imports.** On 4.6, compatibility version 5 turns server auto-imports off. A build without them exits 0, then every affected handler returns 500. Any module that calls `addServerImports` turns them back on, types included, so typecheck cannot catch the gap either. The codemod dry run is the gate. Read [server imports](references/server-imports.md).
- **Every opt-out needs a reason.** If you keep an option that undoes a compatibility version 5 default, add a comment that names the blocker and links the issue.
- **Sessions need approval.** Moving session helpers to `nuxt/server` changes the cookie, so every user is signed out once. Never do it without explicit approval.
- **Check mixed-case URLs before shipping.** Compatibility version 5 makes routing case sensitive. A mixed-case URL that search engines indexed then returns 404.
- **Never deploy.** The repository's deploy workflow ships the change after merge.
- **Never weaken a gate to pass.** Fix typecheck errors from `noUncheckedIndexedAccess`, typed pages, and typed `$fetch`. Do not turn the checks off.

## Order

| Step | Do | Reference |
| --- | --- | --- |
| 1 | Record the baseline on the base branch: install, lint, typecheck, test, build. | [verification](references/verification.md) |
| 2 | Raise the Node floor, upgrade Nuxt to the latest 4.x release, update every other dependency, dedupe the lockfile. | [minors](references/minors.md#upgrade) |
| 3 | Make server imports explicit with the codemod. | [server imports](references/server-imports.md) |
| 4 | Turn on compatibility version 5. Remove opt-outs and redundant flags. Fix each changed default. | [compatibility version 5](references/compat-v5.md) |
| 5 | Replace deprecated APIs (Tier 1). | [minors](references/minors.md) |
| 6 | Adopt new features where the evidence fits (Tier 2). | [minors](references/minors.md) |
| 7 | Verify: gates, runtime smoke, browser pass, warnings. | [verification](references/verification.md) |
| 8 | Open the pull request with the `pr` Skill. | [verification](references/verification.md#pull-request) |

If the codemod changes more than 200 files, split the work into two stacked pull requests.
The first holds the upgrade and the explicit imports. The second holds everything else.

## Tiers

Every finding in the references carries a tier.

| Tier | Meaning | Default |
| --- | --- | --- |
| 0 | Required by the upgrade or by compatibility version 5. | Always do it. |
| 1 | Deprecated in a 4.x minor, or removed in Nuxt 5. | Always do it. |
| 2 | New feature with a clear fit in this site. | Do it when the detection finds evidence. |
| 3 | Experimental with runtime risk, or benefit unmeasured. | List it in the pull request as a follow-up. Never enable it in the migration. |

## Report

End with the verification table from [verification](references/verification.md#report).
List every opt-out kept, every Tier 2 item skipped, and every Tier 3 follow-up, each with a one-line reason.

Example rows, from the trial on a copy of harlanzw.com:

| Check | Result |
| --- | --- |
| Nuxt | 4.5.2 to 4.6.0, compatibility version 5 |
| Server imports | 8 files changed, 0 left, 0 unmapped |
| Runtime smoke | `/` 200, `/feed.xml` 200, `/api/projects` 200, unknown path 404 |
| Opt-outs kept | `payloadExtraction: true`: none needed, removed |

## Sources

- Release notes: `agent-gh release view v4.<minor>.0 -R nuxt/nuxt`, for minors 1 to 6.
- Upgrade guide, "Testing Nuxt 5" and "Moving to `nuxt/server`": <https://nuxt.com/docs/4.x/getting-started/upgrade>
- Nuxt 5 upgrade guide: <https://nuxt.com/docs/5.x/getting-started/upgrade>
- Defaults that compatibility version 5 changes: `packages/schema/src/config/experimental.ts` in `nuxt/nuxt` at `v4.6.0`.
