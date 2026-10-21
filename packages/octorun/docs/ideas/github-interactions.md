# GitHub interactions

Make the pull request the main interface.
Use one updated overview, findings beside code, direct replies, and explicit controls.
Keep ordinary repository work usable without a dashboard.

## CodeRabbit reference

CodeRabbit documents incremental review, full review, and pull-request pause and resume commands.
It separates informational commands, fixes, and ongoing Autofix.
Its walkthrough sections and review noise are configurable.
Sources: [commands](https://docs.coderabbit.ai/reference/review-commands), [review controls](https://docs.coderabbit.ai/guides/commands), [walkthroughs](https://docs.coderabbit.ai/pr-reviews/walkthroughs), [configuration](https://docs.coderabbit.ai/reference/configuration).

Adopt these interaction patterns for Octorun.
Keep the workflow name, result, and next action clear.
Do not turn the first release into a copy of every CodeRabbit feature.

## Pull request journey

1. An eligible event selects a repository workflow from trusted configuration.
2. The overview shows the workflow name, head SHA, and current phase.
3. Queue holds name the cause: capacity, quota, paused operation, or required permission.
4. Findings appear in a grouped native review, with a short overview linking the result.
5. A clean review states that it found no actionable findings.
6. A later commit supersedes unfinished work and starts the configured next review.
7. A reply receives an answer in its existing thread.

Edit phase changes into the same overview.
Collapse evidence, configuration provenance, and execution history.
Keep the first screen focused on results and the next human action.
Use actual phase names. Never fabricate progress percentages.

## Commands

Use the installation's configured handle and parse commands before requesting an agent turn.
Treat the following syntax as the proposed interaction contract.

| Command | Effect | Default authority |
| --- | --- | --- |
| `help` | List enabled commands and workflows | Repository read access |
| `status` | Show current head, workflow, hold, and next action | Repository read access |
| `configuration` | Show redacted effective configuration and provenance | Repository read access |
| `review` | Request incremental review | Policy permits model spending |
| `review full` | Request a full review of the current head | Policy permits model spending |
| `run <workflow>` | Start a configured workflow | Workflow-specific capability |
| `pause` | Stop future automatic runs for this pull request | Repository write access |
| `resume` | Resume automatic runs | Repository write access |
| `cancel` | Cancel the current run and revoke publication | Run owner under policy, or repository write access |
| `repair <finding>` | Request a separately enabled repair workflow | Repository write access and repair capability |

A pull request pause holds automatic runs that have not started. An active run continues.
Use cancel to stop current work. Operator-wide admission pause has its own task-level scope.

Unknown commands return concise help without starting repair or spending model capacity.
Ignore quoted commands, fenced examples, other App handles, and the App's own comments.
Record the actor, source comment, inputs, authorization, and resulting run ID.
Repeated delivery of one accepted command returns its original result.
Edited commands need a new accepted revision. Deletion does not reverse completed actions.

Resolve repository permission through [GitHub](https://github.com).
Do not authorize an organization repository by comparing a user login with the organization name.
Recheck authority before code changes or other privileged effects.
Treat public conversation, paid execution, code changes, and configuration as separate capabilities.
Default outside-contributor model spending to disabled unless the operator enables bounded access.

## Review, reply, and repair

The review preset publishes findings without changing code.
A question about a finding starts a bounded conversation task.
It carries the finding, reviewed SHA, current SHA, code location, and thread history.
It answers in that thread without starting repair.

A dispute can request focused verification and record supporting evidence.
Track accepted, disputed, fixed, and dismissed findings separately from GitHub's resolved flag.
Resolved alone does not prove that code changed or a defect disappeared.
Avoid repeating a dismissed finding unless materially new evidence warrants reconsideration.
Fetch an old thread root by ID when it falls outside recent comment pages.

Repairs require a separate workflow and visible authorization.
Bind that authority to the workflow version, head SHA, findings, and bounded repair rounds.
Explain whether repair pushes a commit or opens another pull request.
Keep continuous repair opt-in, with explicit cost and round limits.

## Check runs

Give each workflow a stable check name and each run an external ID.
Bind every check to its head SHA and owning App.
Expose queued, in-progress, and completed execution states.
Map cancellation, timeout, infrastructure failure, and missing authority to their corresponding conclusions.
Never report a clean review when the provider failed.

Keep the default finding policy advisory.
Let a repository explicitly configure confirmed findings to fail its required review check.
Show a direct result link and human next action in the check output.
Handle native re-run and requested-action events through the same authorized command path.
Ignore check events from other Apps, even when check names match.
Resolve fork heads through recorded run identity when GitHub returns no linked pull request.
Sources: [check runs](https://docs.github.com/en/rest/checks/runs), [check events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#check_run).

## Findings and notifications

Group findings into one native review when practical.
Support both diff sides, line ranges, and file-level fallback locations.
Place unanchored findings in the overview with evidence links.
Use stable fingerprints across runs. Keep per-finding reconciliation when a batch outcome is unknown.
Sources: [review publication](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request), [thread replies](https://docs.github.com/en/rest/pulls/comments#create-a-reply-for-a-review-comment).

Notify for a new actionable result, a required human decision, or a direct reply.
Edit routine progress and transient retry details into the overview.
Do not repeat unchanged findings on every push.
Avoid posting the same full findings in both the overview and a native summary.
Bound comment size and finding count. Link additional detail when necessary.

## Configuration and controls

Show which event selected the workflow and which trusted commit supplied its configuration.
Explain skips for drafts, branches, paths, author policy, and budgets.
Offer redacted configuration inspection and validation errors with exact paths.
Keep natural-language output concise and localizable through one owned message layer.

Provide comment and CLI equivalents for run, pause, resume, cancel, and status.
Treat checkboxes as optional shortcuts that require reliable edit-event coverage.
A lost webhook must leave a usable recovery command.
Polling cannot identify a checkbox editor from its current text alone.

The source audit reproduced the existing parser's information-command gap.
See [source evidence](source-audit.md) and the [public work list](public-release-work.md).
