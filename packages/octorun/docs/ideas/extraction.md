# Package extraction

Extract one headless package into `packages/octorun` first.
Make Harlan Agent Kit consume it through explicit adapters.
Prove the packed artifact before moving it into a separate repository.

## Reuse map

Paths refer to the existing `packages/harlan-github-agent/src/` tree.
The [source audit](source-audit.md) pins the inspected revision.

| Treatment | Source | Change |
| --- | --- | --- |
| Generalize | `webhook.ts`, `poller.ts`, `reconcile.ts` | Preserve authentication and reconciliation. Add durable event normalization. |
| Reuse mechanisms | `store.ts`, `task-scheduler.ts`, `worker-task-scheduler.ts` | Extract transactions, fencing, and leases. Keep workflow decisions outside SQL. |
| Reuse mechanisms | `publication-scheduler.ts`, `github-agent-source.ts` | Separate desired mutations, authorization, and remote reconciliation. |
| Generalize | `agent-provider.ts`, provider adapters | Remove closed review-role coupling. Validate only enabled providers. |
| Generalize | `worktree.ts`, `agent-sandbox.ts`, proof isolation | Inject roots and tools. Preserve credential and process restrictions. |
| Review preset | Review path in `item-agent.ts`, `review-*`, `native-review.ts` | Keep findings, proof, review history, and native review publication together. |
| Replace composition | `service.ts`, `config.ts`, `service-preflight.ts`, `index.ts` | Compose optional capabilities. Export a deliberately small public surface. |
| Personal adapters | `agent-context.ts`, `workspace-environment.ts`, host capacity tools | Pass instructions, explicit secrets, roots, and admission policy. |
| Keep in Agent Kit | Desktop, terminals, tray, emergency controls, Caddy, personal deployment | Avoid mandatory host control and native terminal dependencies. |
| Later workflows | Issue work, Batch, Routines, release, Baseline repair, Take Ownership | Register individually after the generic runtime works. |

Do not copy the entire store or expose its application-wide interface.
Start a small Octorun schema for events, definitions, runs, attempts, waits, and publications.
Put review-specific records behind the review preset's store interface.
Keep personal host records in the existing service database.

## Public surface

Expose the workflow definition, task registration, typed results, runner, and adapter contracts deliberately.
Keep the [SQLite](https://sqlite.org) schema, GitHub REST details, and scheduler internals private.
Version public contracts before publishing import paths.
Use static task registration. Avoid import-time effects and repository-selected executable imports.

Build the library and CLI without generating a dashboard.
Exclude Ghostty, PTY bindings, passkeys, emergency binaries, and personal classification services from required dependencies.
Resolve workspace and catalog references into valid release metadata.
Bundle required preset instructions and resolve assets relative to the installed package.
Require no root Skill manifest or global personal instructions.

## Configuration and identity

Use explicit repositories and GitHub App installations for the first release.
Derive the App actor from authenticated metadata.
Use stable GitHub IDs in authorization and storage.
Never fall back silently to the operator's personal [GitHub](https://github.com) account.

Make checkout roots, state, cache, tool paths, and credential references configurable.
Use XDG defaults and validate resolved paths, ownership, and symlink containment.
Validate only selected providers and enabled execution capabilities.
Read-only review does not require a commit identity or dashboard password.

Generate the permission checklist from selected workflows.
Separate repository reads, review publication, check publication, CI reads, and code changes.
Do not request release or merge permissions for the review preset.
Preserve repository-scoped, permission-scoped App tokens.

## Installation experience

Provide one documented Linux path with Node and one supported agent provider.
Support a package-owned control clone or an explicit verified checkout.
Verify repository identity and origin before creating any task worktree.
Require Worktrunk in diagnostics and supply package-owned lifecycle setup.
Do not depend on Harlan's global Worktrunk hooks or local environment seeding.
Detect Bubblewrap, namespaces, process limits, and required user systemd support before accepting executable tasks.
Report each missing dependency with one concrete remedy.
If isolation is unavailable, refuse executable work.

The CLI needs setup, configuration checking, diagnostics, event inspection, manual polling, run, logs, and cancellation.
The implementation contract must define final command syntax for these operations.
Default diagnostics to redacted output. Offer structured JSON and stable exit codes for automation.

Setup should install or connect an App, select a repository, select a preset, and verify delivery.
Offer poll-only operation when no public webhook endpoint exists.
Show the effective workflow and permission limits before the first paid run.
Make an initial run against existing open pull requests an explicit choice.

## Operations

Expose readiness separately from liveness.
Report the installed version, schema version, last successful ingestion, and actionable dependency failures.
Correlate event, workflow run, task attempt, provider turn, publication, and head SHA in redacted logs.
Show queue holds, retry wake times, and the next required human action.

Document graceful drain, shutdown, backup, restore, upgrade, and rollback boundaries.
A package rollback must reject a database schema it cannot read.
Retain bounded events, artifacts, and transcripts. Keep workflow results inspectable after cleanup.
Delete temporary worktrees only after their owning processes stop.
Do not garbage-collect active run inputs or unknown publication outcomes.

## Cutover

1. Build the core and review preset behind adapters in this monorepo.
2. Test the packed artifact in a clean home and unrelated working directory.
3. Run a non-publishing comparison against fixtures and a disposable repository.
4. Drain the old controller for selected repositories and preserve its database backup.
5. Transfer publication identity and the required review history through an explicit import.
6. Give each repository and workflow exactly one active publication owner.
7. Resume events from the recorded cursor and reconcile unknown remote outcomes.
8. Verify summary ownership, findings, cancellation, re-run, and a new head before expanding.
9. Extract the repository with its tests, license, provenance, and independent release workflow.

Treat legacy comment markers, check names, finding IDs, and approvals as authority-bearing data.
Do not adopt another App's comments by matching visible text.
Preserve Harlan's namespace through an adapter during migration.
Use a distinct namespace for new Octorun installations.

Rollback needs the same ownership transfer and drain.
Never run both controllers as publishers for the same workflow.
Select a coherent source revision that includes reviewed fixes before moving files.

## Later capabilities

Keep repairs, continuous repair, releases, and merge operations behind separate explicit capabilities.
Add scheduled workflows after event-driven chains pass their release checks.
Treat remote hosts, a dashboard, macOS, Windows, GitHub Enterprise, and hosted multi-user operation as separate milestones.
The first release must describe its supported platform precisely.
