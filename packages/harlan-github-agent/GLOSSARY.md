# Glossary

Canonical vocabulary for `harlan-github-agent`.

## Map

| Term | Storage | Owner | Relationship | Customer word |
| --- | --- | --- | --- | --- |
| Repository mapping | `repositories` | Configuration | 1 to N Subjects | repository |
| Subject | `subjects` | Journal | 1 to N Revisions, Tasks, Workers | issue or pull request |
| Observation | `observations` | Reconciliation | N to 1 Revision | none |
| Revision | `revisions` | Journal | N to 1 Subject, 1 to N Attempts | none |
| Worker | `worker_sessions` | Runner | N to 1 Subject, 1 to N Attempts | agent |
| Task | `tasks` | Scheduler | N to 1 Subject and Revision | task |
| Queue | derived dashboard state | Controller | Orders active Tasks and actionable Subjects | queue |
| Pause | `agent_control` | Controller | Stops new agent Tasks from starting | Pause |
| Eject | dashboard and system pane action | Controller | Transfers one active Codex session to Harlan's terminal | Eject |
| Watch logs | system pane action | Observer | Opens one read-only live Task event stream | Watch logs |
| Weekly Codex limit | live Codex account | System pane | One seven-day usage window | Weekly Codex limit |
| Conflict resolution | `tasks.kind` | Scheduler | One Task kind | conflict resolution |
| Baseline repair | `tasks.kind` | Scheduler | One Task for one failing default branch commit | Baseline repair |
| Issue triage | `worker_tasks.kind` | Scheduler | One Task for one issue Revision | issue triage |
| Issue triage comment | `issue_triage_comment_commands` | Controller | One canonical comment per issue | automated triage |
| Issue work | `tasks.kind` | Scheduler | One authorized Task for one issue Revision | issue work |
| Take Ownership | `repositories.take_ownership` | Controller | One policy per Repository mapping | Take Ownership |
| Publication command | `publication_commands` | Controller | One to one Task | none |
| Attempt | `attempts` | Runner | N to 1 Revision, 1 to N Publications | review |
| Review gate | `attempts.gates` | Adversarial review | Six per review Attempt | gate |
| Review outcome | `attempts.outcome_tag` | Adversarial review | One per review Attempt | READY, WAITING, or BLOCKED |
| Review finding | `attempts.findings` | Adversarial review | N per review Attempt | issue |
| Publication | `review_publications` | Journal | N to 1 Attempt | automated review |
| Approval | `pull_request_approvals` or `tasks.kind = issue_work` | Controller | N to 1 Revision | approval |
| Legacy issue cutoff | `issue_cutoff` | Configuration | One per service | none |
| Needs attention | `tasks.state_tag` | Scheduler | One Task state | needs attention |
| Process finding | `process_findings` | Supervision | N per workflow | none |

Collisions

- "issue" means a GitHub Subject alone. "Review issue" means a Review finding in review copy.

## Terms

### Repository mapping

One explicit connection between a GitHub repository and its trusted local checkout.

Use for configuration, validation, and dashboard copy.

### Subject

One GitHub issue or pull request tracked by the service.

Use for durable internal state. Use `issue` or `pull request` in GitHub-facing text.

Never expose `Subject` in the dashboard, logs, comments, or errors.

### Observation

One immutable snapshot of a subject received from GitHub.

### Revision

One unique canonical state of a subject. Duplicate observations can resolve to the same revision.

Never expose `Revision` in the dashboard, logs, comments, or errors. Say issue state, pull request, head commit, branch, or commit SHA explicitly.

### Worker

One durable agent role assigned to a subject.

### Task

One independently scheduled unit of work for a subject.

### Queue

The ordered dashboard view of active Tasks and actionable Subjects.

Use `Queue` for this view. Do not use backlog or inbox.

### Pause

A durable service control that stops new agent Tasks from starting. Active agents and controller Publications finish.

Use `Pause` in controls and procedures. Never use drain or maintenance mode for this control.

### Eject

Stop one active automated Task, then open its saved Codex session in Harlan's terminal for interactive control.

Use Eject for this transfer. Do not use attach or take over.

### Watch logs

Open one active Task's live Codex event stream in Harlan's terminal. Automation continues unchanged.

Use Watch logs for this view. Do not use Monitor or attach.

### Weekly Codex limit

The remaining Codex allowance in the current seven-day usage window, with its reset countdown.

Use Weekly Codex limit for this system pane status. Do not use weekly usage or quota.

### Conflict resolution

A task that updates an open pull request after its base branch causes merge conflicts.

### Baseline repair

One task that repairs failing CI on an exact default branch commit and opens a separate pull request.

Use Baseline repair. Do not use default branch CI fix or origin main CI fix.

### Issue work

One task that plans, implements, and verifies a change for one exact issue state.

Harlan's valid issues authorize Issue work automatically. An outside contributor's issue requires Approval.

The Issue triage Worker continues its Codex session for Issue work.

### Issue triage

One agent task that assesses one exact issue state.

### Issue triage comment

One self identified automated triage record on an issue. Reruns update the canonical comment.

### Take Ownership

One workflow that remains responsible for current work through its required delivery verification.

Use for repository policy, skill names, and dashboard controls.

Never use PR Owner, PR ownership, or deployment ownership for this workflow.

### Publication command

One durable request for the controller to publish a pinned, verified commit.

The controller verifies the expected remote head before each write. Workers cannot execute Publication commands.

### Attempt

One agent turn for one Worker.

A review Attempt stores its Revision, gate evidence, Review findings, Review outcome, agent version, and timestamps.

### Review gate

One required condition for a review outcome.

Use only head, merge, metadata, review, verification, and CI gates.

### Review outcome

One deterministic result derived from all Review gates.

Use `READY`, `WAITING`, or `BLOCKED`. Only `READY` has confidence.

### Review finding

One material issue found during review.

Use `Fixed` after repair. Use `Open` with the next action while unresolved.

### Publication

One immutable record of a GitHub automated review comment write.

Store the exact Markdown and remote acknowledgement. Store failures with their reason.

### Approval

One local decision for one exact issue or pull request Revision.

For an outside contributor's issue, Approval permits Issue work. Use `harlan-agent-review` on GitHub or `Approve` in the dashboard. Harlan's issues do not require Approval.

For a pull request, Approval permits review and verified repairs in one workflow. Use `Review and repair` for the dashboard action.

A new external Revision requires new Approval. A controller-published repair commit continues the approved workflow.

### Legacy issue cutoff

One fixed date. Ignore issues created before this date. Do not derive it from the current date.

### Needs attention

A subject that requires Harlan's decision or action.

Use instead of `stuck`, `failed`, or `human required` in dashboard copy.

### Process finding

Evidence that a skill, policy, or workflow should change.

## Banned

- job, when referring to a subject or worker
- bot, when referring to a worker
- ticket, when referring to a GitHub issue
- PR Owner, PR ownership, or deployment ownership, when referring to Take Ownership
- journal, lease, fence, mutation, publication, revision, snapshot, subject, or worker in user-visible text
- Use GitHub terms instead: pull request, issue, branch, commit, check, comment, review, push, agent, or Git worktree

## Open questions

- Confirm whether `Subject` should become `Work item` before any public release.
