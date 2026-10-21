# Public release work

These tasks complete the core work's public interface and distribution.
Recommend **U01 first** among independent UX tasks.
Use the [core work list](core-work.md) for dependencies.
Confidence measures audit evidence and design fit. Live product proof remains an acceptance requirement.

| Next step | Impact /100 | Effort S/M/L | Confidence /100 | Why |
| --- | --- | --- | --- | --- |
| U01. Parse explicit commands | 99 | M | 100 | Information and control commands reproduced code-change requests. |
| U02. Authorize repository actors | 99 | M | 98 | Literal owner comparisons cannot authorize organization collaborators. |
| U03. Publish workflow check lifecycles | 94 | M | 98 | Current checks support only running, success, and neutral. |
| U04. Reply within finding threads | 92 | M | 97 | Current replies request a whole review without an in-thread answer. |
| U05. Design the quiet overview | 91 | M | 96 | Several publication surfaces repeat controller state and review detail. |
| U06. Group native findings | 87 | M | 95 | Findings publish individually and only support right-side locations. |
| U07. Add setup and diagnostics | 95 | M | 96 | Existing preflight assumes personal credentials, tools, and dashboard configuration. |
| U08. Build an independent package | 99 | L | 99 | Private workspace dependencies and mandatory dashboard builds block distribution. |
| U09. Remove personal defaults | 98 | M | 99 | Paths, actor trust, instructions, and host tools name Harlan's installation. |
| U10. Define operations and retention | 89 | M | 94 | Durable events and artifacts require bounded storage and recoverable upgrades. |
| U11. Prove a clean installation and release | 99 | L | 94 | Existing source CI does not exercise a packed public installation. |
| U12. Migrate ownership and extract the repository | 96 | L | 91 | Two publishers can duplicate effects or reuse incompatible approval state. |

## U01. Explicit command routing

Dependencies: C01, C02. Read [the interaction contract](github-interactions.md).

- Parse help, status, configuration, review, full review, run, pause, resume, cancel, and explicit repair separately.
- Reject unknown commands before model execution. Preserve command revision and request identity.
- Acceptance: help, status, quotes, code fences, and invalid commands never start code changes.
- Acceptance: webhook, poll, CLI, and native check requests share one command path.

## U02. Actor capabilities

Dependencies: C03, U01.

- Resolve repository permissions through [GitHub](https://github.com) and stable actor IDs. Recheck before privileged effects.
- Separate read access, model spending, code changes, cancellation, and configuration capabilities.
- Acceptance: an organization collaborator can operate the permitted workflow.
- Acceptance: permission revocation blocks the next privileged action; forged associations grant no authority.

## U03. Workflow check runs

Dependencies: C08, U01, U02.

- Publish stable names, run external IDs, direct result links, and complete execution states.
- Separate advisory findings from infrastructure failure. Make merge-blocking findings an explicit repository policy.
- Handle native re-run and requested actions. Verify App ownership and recorded head identity.
- Acceptance: timeout, cancellation, provider failure, and supersession cannot appear as a clean review.
- Acceptance: a fork head with no linked pull request still resolves the correct run.

## U04. Finding conversations

Dependencies: C06, C08, U02.

- Add bounded replies in the existing thread, with finding evidence, current code, and transcript context.
- Keep explanation, focused verification, full review, and repair as separate actions.
- Acceptance: a question produces an answer without branch writes or a full review.
- Acceptance: disputed and dismissed findings retain reasons; resolved threads alone do not prove fixes.

## U05. Overview and message ownership

Dependencies: C08, C10, U01, U03.

- Show result, workflow, head, hold reason, and next action first. Collapse evidence and execution detail.
- Centralize human-facing messages and reuse glossary terms across comments, checks, diagnostics, and docs.
- Edit routine progress. Notify for actionable results, direct replies, and required human decisions.
- Acceptance: empty, skipped, blocked, failed, and paused paths each explain the next action concisely.
- Acceptance: a new head does not repost unchanged findings or duplicate the native review's full content.

## U06. Native review batches

Dependencies: C08, C10, U05.

- Batch findings in a native review. Support LEFT, RIGHT, line ranges, and fallback locations.
- Keep stable finding identities and reconcile partial or unknown publication outcomes.
- Acceptance: ten findings produce one grouped review. Recovery creates no duplicate finding comments.
- Acceptance: removed-code and outside-diff findings have usable evidence locations.

## U07. Setup, preview, and diagnostics

Dependencies: C03, C06, C07, C09, U08, U09.

- Provide CLI setup, configuration checks, doctor, plan preview, poll, run, inspect, logs, and cancel operations.
- Generate required permissions from enabled workflows. Show effective configuration sources and limits.
- Offer webhook and poll-only setup, with explicit selection of existing pull requests for initial processing.
- Acquire a control clone or verify an existing checkout's origin. Configure Worktrunk without personal hooks.
- Acceptance: a new operator reaches one review with one provider and no dashboard or commit identity.
- Acceptance: each setup failure names the failed operation and one concrete remedy, with redacted JSON output available.

## U08. Package boundary

Dependencies: C01, C06. Read [extraction boundaries](extraction.md).

- Build a narrow library and CLI without dashboard, terminal, emergency, or private workspace dependencies.
- Package preset assets, declare runtime requirements, and resolve release dependency versions.
- Acceptance: production-only tarball installation works outside this monorepo and from an unrelated working directory.
- Acceptance: packed files contain every referenced asset and no personal credentials or unresolved workspace references.

## U09. Paths, identity, and instructions

Dependencies: C03, C07, U08.

- Replace fixed home paths, Harlan actor names, global Skills, and external host tools with injected adapters.
- Keep XDG state defaults, explicit checkout roots, protected-path validation, and selected-provider setup.
- Acceptance: an empty non-Harlan home runs fixtures under nonstandard roots with one configured provider.
- Acceptance: App identity follows authenticated metadata. Missing credentials never trigger another account's fallback.

## U10. Operations

Dependencies: C04, C08, U08.

- Provide liveness, readiness, correlated redacted logs, hold reasons, drain, backup, restore, and version reporting.
- Define event, transcript, artifact, and worktree retention without removing active evidence.
- Acceptance: restart preserves accepted work; restore recovers its publication identities.
- Acceptance: an older binary rejects a newer schema. An operator can identify and recover a failed dependency.

## U11. Release gate

Dependencies: C12 and U01 through U10.

- Run clean-home pack/install and real isolation tests in hosted CI using production dependencies.
- Make fixtures independent of real hostnames, personal instructions, and global configuration.
- Exercise one disposable App installation, organization repository, fork, comment command, and native re-run.
- Verify provider failure, token expiry, quota holds, cancellation, and an unknown GitHub write result.
- Document supported platforms, permission matrix, first run, custom tasks, and recovery through verified examples.
- Acceptance: the public repository can build, test, and publish independently with license notices and provenance.
- Check repository and registry name availability before choosing final public identifiers.

## U12. Ownership cutover

Dependencies: U11. Follow [the cutover sequence](extraction.md#cutover).

- Choose a source baseline that includes reviewed repairs. Drain publishers and back up their state.
- Import required comment markers, finding IDs, run boundaries, and approval provenance explicitly.
- Acceptance: one controller owns each repository/workflow. Rollback uses the same ownership transfer.
- Acceptance: Harlan Agent Kit consumes Octorun without retaining another active copy of the engine.
- Acceptance: a new head, re-run, cancellation, reply, and restart work after the repository split.

## Later work

Repair workflows need separate consent, head-bound authority, verification, round limits, and code-write permissions.
Scheduled workflows, dashboard, terminals, remote hosts, releases, and merging follow their own verified milestones.
Do not make those capabilities prerequisites for the initial public review package.
