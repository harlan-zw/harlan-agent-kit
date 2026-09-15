---
name: dependency-updates
description: Update repository dependencies weekly, including majors, in one pull request. Use for the dependency-updates Routine and its Issue work.
---

# Dependency updates

One repository, one active issue, one pull request for every passing update.
Attempt major upgrades and their migrations. Keep blocked upgrades out of the final dependency set.

The controller names scan mode or implementation mode. Follow that mode only.
Read repository Agent instructions and its package manager configuration first.

## Scan mode

Keep repository files and GitHub read only. Use the controller's prepared worktree.

1. Read open issues and pull requests. Find existing dependency work, including manually opened updates.
2. If dependency work is open, return no updates. Report its link, current blocker, and next actor.
3. Read root and workspace manifests, catalogs, lockfiles, patches, overrides, and package manager version.
4. Use that package manager's registry commands to find exact current and target versions.
5. Include all direct production, development, and optional dependencies. Include catalog entries and workspace manifests.
6. Consider major versions. Preserve workspace links, supported peer ranges, and explicitly selected prerelease channels.
7. Record non-registry dependencies and unsupported manifests in the report. Never silently omit them.
8. Return the controller's structured update list. Do not create Candidates, issues, or pull requests yourself.

For pnpm, inspect `pnpm outdated --help` before running it.
Use recursive JSON output and explicitly include the root workspace.
Check unused catalog entries separately against registry metadata.
Use each repository's pinned pnpm version. Do not install a newer package manager merely to run the scan.
An outdated command may exit nonzero when updates exist. Distinguish that from a registry or authentication failure.
If registry reads fail, return `outcome: blocked` with the error in `report` and an empty update list.
Otherwise return `outcome: complete`, a report, and the update list.

Every update includes `manifest`, `name`, `current`, and `latest`.
Use repository-relative manifest paths and exact versions, without range operators.
The controller derives one Candidate and its identity from the complete sorted version list.
A new release changes that identity. Reordering the list does not.

## TypeScript exception

Keep TypeScript on version 6. Query the latest compatible version 6 release separately.
Do not adopt TypeScript 7, a native-preview replacement, or a package alias that bypasses this exception.
Report the known migration blocker. If its reason is unknown, say so without inventing one.
Read new compatibility evidence weekly and report when a retry looks possible.
Only Harlan clearing this exception authorizes a TypeScript 7 migration.

## Implementation mode

The issue carries registry evidence. Refresh it before applying changes.
Use the controller's prepared worktree. Do not create another worktree.
Do not stage, commit, push, publish, or alter GitHub metadata. The controller owns those actions.

1. Establish the current baseline using the repository Check and build.
2. If the baseline fails, identify that failure before attributing it to dependency updates.
3. Attempt all eligible dependencies together, including majors. Preserve the TypeScript exception.
4. Update catalog declarations at their source. Preserve `catalog:` and `workspace:` references in consumers.
5. Refresh the lockfile. Let parent constraints determine transitive versions. Do not override every transitive package to latest.
6. Read official migration instructions for breaking upgrades. Repair affected code and configuration within the same change.
7. Attempt at most two focused repairs for each failing upgrade or coupled dependency group.
8. If an upgrade remains blocked, restore its prior declarations and coupled versions. Regenerate the lockfile.
9. Run the repository Check, build, and relevant runtime smoke tests against the final combined dependency set.
10. Return one pull request containing all passing updates. List excluded versions, blockers, and next actions in its description.

Use explicit package targets when a blanket update would upgrade TypeScript or bypass another repository constraint.
Do not weaken tests, type checks, install trust policy, or build approvals to obtain passing checks.
Do not widen supported peer ranges without testing that support.
If every update is blocked, return a blocked outcome. Never fabricate a change to obtain a pull request.

Keep Node, pnpm, and GitHub Actions unchanged unless the dependency migration requires their update.
If required, include them in this same pull request and require human review.

## Existing work and review

If another dependency pull request already owns the work, report its link and return blocked.
Do not create a second pull request or push to a branch this Task does not own.
The existing Review and Repair continue work on the published pull request.

Pure dependency changes may qualify for the existing auto-merge policy.
Migration code, configuration changes, and uncertain major upgrades require Harlan's merge decision.
Never add the auto-merge label yourself.
