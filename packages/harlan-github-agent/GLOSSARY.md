# Glossary

Canonical vocabulary for `harlan-github-agent`.

This service attaches to GitHub's workflow, so **GitHub's word wins wherever GitHub has one**.
Invent a term only for a concept GitHub does not have, and record why GitHub's vocabulary
did not cover it.

## Map

| Term | Storage | Owner | Relationship | Customer word |
| --- | --- | --- | --- | --- |
| Agent provider | `agent.provider` | Configuration | 1 to N Agents | agent provider |
| Agent selection | `agent_selection` | Controller | One per service | Agent selection |
| Follow configuration | `agent_selection.tag` | Configuration | One Agent selection state | Follow configuration |
| Automatic selection | `agent_selection.provider_order` | Controller | One Agent selection state | Automatic |
| Reserve | `agent.reservePercent` | Configuration | One per service | Reserve |
| Reasoning effort | `agent_selection.reasoning_effort` | Controller | One per Agent selection | Reasoning effort |
| Repository mapping | `repositories` | Configuration | 1 to N Items | repository |
| Item | `subjects` | Journal | 1 to N Revisions, Tasks, Agents | issue or pull request |
| Observation | `observations` | Reconciliation | N to 1 Revision | none |
| Revision | `revisions` | Journal | N to 1 Item, 1 to N Review runs | none |
| Agent | `worker_sessions` | Runner | N to 1 Item, 1 to N Review runs | agent |
| Task | `tasks`, `worker_tasks` | Scheduler | N to 1 Item and Revision | task |
| Routine | `routines` | Scheduler | N to 1 Repository mapping, 1 to N Routine runs | Routine |
| Routine run | `routine_runs` | Scheduler | N to 1 Routine | run |
| Lease holder | `tasks.worker_id` | Scheduler | One per Running Task | none |
| Queue | derived dashboard state | Controller | Orders active Tasks and actionable Items | queue |
| Stats | derived from Journal records | Dashboard | N completed records per date range | Stats |
| Pause | `agent_control` | Controller | Stops new agent Tasks from starting | Pause |
| Restart request | `restart_requests` | Controller | N per service, one active | Restart after current work |
| Selection mode | `agent_control.selection_mode` | Controller | One per service | Selection mode |
| Dismissal | `item_dismissals` | Controller | One per Item | Dismiss |
| Eject | dashboard and System pane action | Controller | Transfers one active agent session to Harlan's terminal | Eject |
| Watch logs | System pane action | Observer | Opens one read-only live Task event stream | Watch logs |
| Weekly Codex limit | live Codex account | System pane | One seven-day usage window | Weekly Codex limit |
| Recently finished | derived dashboard state | System pane | Three newest finished Tasks or Review runs | Recently finished |
| Self-hosted runner | Docker container labels | GitHub Actions | N per repository, independent of this service | self-hosted runner |
| Conflict resolution | `tasks.kind` | Scheduler | One Task kind | conflict resolution |
| Baseline repair | `tasks.kind` | Scheduler | One Task for one failing default branch commit | Baseline repair |
| Repair | `tasks.kind` | Scheduler | One Task for the findings of one Review run | repair |
| Context budget | `agent.contextBudget` | Runner | One per agent session | Context budget |
| Stack | `subjects` base ref, `publication_commands.base_ref` | GitHub | A pull request whose base is another pull request's head | stack |
| Issue triage | `worker_tasks.kind` | Scheduler | One Task for one issue Revision | issue triage |
| Issue triage comment | `issue_triage_comment_commands` | Controller | One canonical comment per issue | automated triage |
| Issue triage label | `harlan-agent-ready-to-implement`, `harlan-agent-ready-to-spec`, `harlan-agent-needs-info`, or `harlan-agent-wait-to-implement` | GitHub | One per triaged issue Revision | triage route |
| Issue work | `tasks.kind` | Scheduler | One authorized Task for one issue Revision | issue work |
| Pull request triage | Pull request title, `pull_request_triage` Agent role, or `pull_request_triage_runs` | Controller, Runner | One deterministic or low-cost decision per pull request head commit | pull request triage |
| Take Ownership | `repositories.take_ownership` | Controller | One policy per Repository mapping | Take Ownership |
| Publication command | `publication_commands` | Controller | One to one Task | none |
| Review run | `review_runs` | Runner | N to 1 Revision, 1 to N Publications | review |
| Agent feedback | `agent_feedback` | Controller | One per Review run | Agent feedback |
| Review usage | `review_runs.usage` | Runner | One per Review run | Review usage |
| Review gate | `review_runs.gates` | Controller | Three per Review run | gate |
| Review outcome | `review_runs.outcome_tag` | Controller | One per Review run | READY, PENDING, or BLOCKED |
| Running label | `harlan-agent-running` label | GitHub | One per Item with a Running Task | none |
| Review finding | `review_runs.findings` | Adversarial review | N per Review run | issue |
| Auto merge | `harlan-agent-auto-merge` label | GitHub | One per pull request | auto-merge |
| Publication | `review_publications` | Journal | N to 1 Review run | automated review |
| Approval | `pull_request_approvals` or `tasks.kind = issue_work` | Controller | N to 1 Revision | approval |
| Legacy issue cutoff | `issue_cutoff` | Configuration | One per service | none |
| Action required | `tasks.state_tag` | Scheduler | One Task state | action required |
| Incident | `incidents` | Controller | N to 1 Repository mapping, Task, or the service | incident |
| Recovery | `incidents.recovery` | Controller | One per Incident | Retrying, Retries exhausted, or Action required |
| Process finding | `process_findings` | Supervision | N per workflow | none |

### GitHub terms adopted unchanged

Never paraphrase these. They are GitHub's words for GitHub's concepts, and a reader who
knows GitHub already knows them.

| GitHub term | Means | Never say |
| --- | --- | --- |
| pull request | a pull request | PR in prose, merge request |
| issue | an issue | ticket, bug report, card |
| draft | a pull request not ready for review | WIP, unfinished |
| base branch, base SHA | what the pull request merges into | target branch, destination |
| head ref, head SHA | the pull request's own branch and tip commit | source branch, commit id |
| stack, stacked pull request | a pull request based on another pull request's head | chain, dependent PR, child PR |
| default branch | the repository's default branch | main, master, trunk |
| fork | a fork | copy, mirror |
| mergeable state | GitHub's `clean`, `dirty`, `unknown` verdict | merge status, conflict flag |
| merge conflict | a merge conflict | collision, clash |
| check run, check suite | one GitHub check and its group | CI job, test run, build |
| conclusion | a check's `success`, `failure`, `timed_out`, … result | check status, result code |
| status | a check's `queued`, `in_progress`, `completed` phase | state, phase |
| required check | a check branch protection requires | required test, blocking check |
| branch protection, ruleset | GitHub's merge requirements | merge rules, guard |
| review | a GitHub pull request review | code review, approval |
| review comment | a comment anchored to a diff line | inline comment, annotation |
| comment | an issue or pull request comment | note, message |
| label | a GitHub label | tag, flag |
| installation | a GitHub App installation on an account | app grant, connection |
| auto-merge | GitHub's own merge-when-ready feature | automerge, self merge |
| merge queue | GitHub's merge queue feature | queue, unqualified |
| workflow, job, step | GitHub Actions units | pipeline, stage |
| re-run | GitHub's re-run of a workflow or check | retry, replay |
| runner | the machine one job runs on | executor, box, build agent |

Collisions

- "issue" means a GitHub Item alone. "Review issue" means a Review finding in review copy.
- "queue" unqualified means this service's dashboard Queue. GitHub's feature is always "merge queue".
- "Auto" names a Selection mode. GitHub's merge feature is always written "auto-merge", hyphenated.
- "Automatic" names an Agent selection state and is always written in full. "Auto" alone always means the Selection mode. The two decide different things: `Auto` decides which pull requests to act on, `Automatic` decides which Agent provider answers.
- "Dismiss" is this service's Dismissal. GitHub's own Dismiss applies to alerts, which this service does not touch, so the two never appear together.
- "approval" means this service's local Approval. A GitHub pull request review is always "review" or "approving review".
- "check" means a GitHub check run. This service's own conditions are always "Review gate", never bare "check".
- "job" means a GitHub Actions job. This service's unit of work is a Task.
- "runner" means GitHub's job machine. The Owner column of the Map above uses "Runner" for the internal owner of agent sessions, which is never user-visible.
- "worker" sits on two axes. As the thing that answers a turn it is an Agent. As `worker_id`, the scheduler instance holding a Task lease, it is a Lease holder and keeps the word.
- Storage lags three terms on purpose: Item is stored in `subjects`, Agent in `worker_sessions`, and Lease holder in `worker_id`. Renaming those columns would migrate every foreign key in the journal for a word no user reads.

## Terms

### Agent provider

The one local agent runtime that answers every Agent turn: `codex` or `opencode`.

The Agent provider owns its models, reasoning efforts, sessions, and Eject command. A saved session belongs to the provider that created it.

Use Agent provider. Do not use backend, engine, model provider, or vendor.

### Agent selection

The Agent provider, model, and Reasoning effort in force right now.

An Agent selection is durable. It survives a restart.

An Agent selection either pins an Agent provider or follows the configuration. A pinned selection overrides the Agent provider the configuration names.

**Follow configuration** is the choice that clears a pin. The service then reads the Agent provider from its configuration file again, at every start. The dashboard and the tray both offer it beside the Agent providers.

Follow configuration is not Provider default. Provider default keeps the pinned provider's own model or Reasoning effort. Follow configuration gives the whole choice back to the configuration file.

A model belongs to one Agent provider. Switching the provider therefore returns the model and the Reasoning effort to that provider's own defaults.

A switch starts the next agent turn. An agent already running keeps the model it started with.

Use Agent selection for the control and for the stored choice. Do not use agent config, model config, or model override.

### Automatic selection

The Agent selection state that picks the Agent provider by remaining capacity.

Automatic selection walks the configured preference order and takes the first
Agent provider whose weekly window still has more than the Reserve left. A
provider that publishes no quota always passes, because unknown is not empty.

When no Agent provider may spend, the service stops claiming new agent Tasks and
shows `Reserve reached` in the System pane. Active agents and controller
Publications finish. This is the same stop Pause uses, decided by the account
instead of by Harlan. Reaching a Reserve is expected state, not an Incident.

Automatic selection is durable. It survives a restart.

Use Automatic selection for the state and `Automatic` for the control. Do not
use auto provider, failover, load balancing, or fallback mode.

### Reserve

The share of a published weekly window that unattended work never spends.

The Reserve exists so overnight Routines and unattended reviews cannot drain a
week of Codex before the workday starts. The service cannot see Harlan's own
terminal, so it leaves that share alone rather than competing for it.

Only a provider that publishes a quota has a Reserve. Codex publishes one.
opencode publishes none, so its capacity reads as unpublished and the Reserve
never applies to it.

Use Reserve. Do not use quota, headroom, budget, or safety margin.

### Reasoning effort

How hard a model reasons before it answers: `none`, `low`, `medium`, `high`, `xhigh`, or `max`.

`reasoning effort` is Codex's own name for this setting, so this service uses it for both providers.

Use Reasoning effort. Do not use reasoning variant, thinking level, or effort level.

### Repository mapping

One explicit connection between a GitHub repository and its trusted local checkout.

GitHub's `installation` covers what the App may reach. It does not cover the local checkout, which is why this term exists.

Use for configuration, validation, and dashboard copy.

### Item

One GitHub issue or pull request tracked by the service.

GitHub has no single word for "issue or pull request" outside its GraphQL `IssueOrPullRequest` union, which is unusable in prose. `Item` follows GitHub Projects, where an issue or a pull request on a board is an item.

Use for durable internal state. Use `issue` or `pull request` in GitHub-facing text.

Never expose `Item` in the dashboard, logs, comments, or errors. Never use subject, work item, entity, or record.

### Observation

One immutable snapshot of an Item received from GitHub.

### Revision

One unique canonical state of an Item. Duplicate Observations can resolve to the same Revision.

Never expose `Revision` in the dashboard, logs, comments, or errors. Say issue state, pull request, head SHA, head ref, or base SHA explicitly.

### Agent

One durable agent role assigned to an Item, and the session that runs it.

Use Agent for the role and for the running session. Do not use worker, bot, or job.

### Lease holder

One scheduler instance that currently owns a Running Task, identified by
`worker_id`.

A Lease holder is not an Agent. It is a `randomUUID()` created when the service
starts, and it exists so a Task cannot be run twice. This is the one place
`worker` survives, because the word describes a lease and not an agent.

Never expose Lease holder or `worker_id` in the dashboard, logs, comments, or
errors.

### Task

One independently scheduled unit of work for an Item.

GitHub Actions calls its unit a `job`. This service is not Actions, and a Task outlives a single run and carries its own lease, so Task stays. Never call a Task a job.

### Routine

One named recurring repository check declared in `.github/routines.yml`.

A Routine answers a clock. It has no Item or Revision. Each due instant creates one Routine run.

### Routine run

One durable answer to one exact cron instant for a Routine.

A skipped instant remains a Routine run. This keeps missed work visible.

### Queue

The ordered dashboard view of active Tasks and actionable Items.

GitHub ships a **merge queue**, which this is not. Always write "merge queue" in full when you mean GitHub's feature.

Use `Queue` for this view. Do not use backlog or inbox.

### Stats

The dashboard view of completed work and its useful outcomes for one date range.

Stats derives facts from the Journal. It never replaces the records that support them.

Use Stats for the page and route. Do not use analytics, insights, value score, or impact score.

### Pause

A durable service control that stops new agent Tasks from starting. Active agents and controller Publications finish.

Use `Pause` in controls and procedures. Never use drain or maintenance mode for this control.

### Restart request

One durable request to finish active work, restart the service, and verify the new process.

The service owns an accepted Restart request. It survives the requesting client and a process exit.

A Restart request stops new agent Tasks from starting. Active agents and controller Publications finish.

Pause remains unchanged. A service that was Paused stays Paused after the restart.

Use Restart request for the record and `Restart after current work` for the control. Do not use restart queue or drain mode.

### Selection mode

Whether the service picks pull requests to act on by itself, or waits for Harlan to select each one.

One of `Auto` or `Manual`. A Selection mode is durable. It survives a restart.

In `Manual`, every open pull request requires Approval, whoever opened it. Select one with the `harlan-agent-review` label on GitHub, or `Review and repair` in the dashboard.

`Manual` never comments on a pull request from an author who can write to the repository. It holds the pull request in the Queue and waits.

`Manual` covers pull requests only. Issue triage and Issue work keep their own rules.

`Manual` also lifts the open pull request limit on Issue work. That limit exists to stop the service opening more pull requests than Harlan can read. In `Manual` he already selects every one, so counting them twice only blocks work he asked for.

Switching to `Manual` leaves a running agent alone. A queued review without Approval stops at the next observation, as Pause behaves.

Use Selection mode for the control and for the stored choice. Do not use opt-in, allowlist, gating, or triage mode.

### Dismissal

One durable decision to never act on an Item.

A Dismissal belongs to the Item, not to a head commit. A new commit does not undo it. It ends when Harlan restores the Item, or when GitHub closes the Item.

Dismissing cancels the Item's running and queued Tasks. Leaving an agent running on an Item nobody will act on spends the budget the Dismissal saves.

A dismissed Item leaves the Queue. It stays visible under `Dismissed` in the Watching page, which is the only place `Restore` appears.

A Review Agent may write **Dismissal recommended** when the pull request premise is wrong. Use it when Repair would replace the pull request intent or require an unrelated root architecture rewrite.

Review decides the premise once for the whole pull request. A wrong premise makes every Review finding a Dismissal recommendation. It never starts Repair.

GitHub status, comments, and labels are durable workflow truth. The Journal stores local coordination and observability data.

A recommendation never creates a Dismissal. Harlan decides whether to use `Dismiss`.

Restoring queues nothing by itself. The next observation replans the Item from its current state.

`Dismiss` is GitHub's own word, used for a Dependabot alert and a code scanning alert, where it means the same thing: stop raising this, without fixing it.

Use Dismissal for the record and `Dismiss` for the control. Do not use skip, ignore, delete, mute, or snooze.

### Eject

Stop one active automated Task, then open its saved agent session in Harlan's terminal for interactive control.

Use Eject for this transfer. Do not use attach or take over.

### Watch logs

Open one active Task's live agent event stream in Harlan's terminal. Automation continues unchanged.

Use Watch logs for this view. Do not use Monitor or attach.

### Weekly Codex limit

The remaining Codex allowance in the current seven-day usage window, with its reset countdown.

Use Weekly Codex limit for this System pane status. Do not use weekly usage or quota.

### Self-hosted runner

One local GitHub Actions runner that executes workflow jobs.

A self-hosted runner is independent of Harlan GitHub Agent. Its availability never changes Harlan GitHub Agent status.

Use self-hosted runner. Do not use Agent, worker, executor, box, or build agent.

### Conflict resolution

A Task that updates an open pull request after its base branch causes merge conflicts.

Say "merge conflict", GitHub's word, for the condition.

### Baseline repair

One Task that repairs failing checks on an exact default branch commit and opens a separate pull request.

Use Baseline repair. Do not use default branch CI fix or origin main CI fix.

### Issue work

One Task that plans, implements, and verifies a change for one exact issue state.

An issue with the Ready to implement route authorizes Issue work. An outside contributor's issue also requires Approval.

The Issue triage Agent continues its own session for Issue work.

### Issue triage

One agent Task that assesses one exact issue state.

`Triage` is GitHub's own word, both for the repository role and for the practice.

It selects exactly one route: Ready to implement, Ready to spec, Needs info, or Wait to implement.

### Issue triage label

One GitHub label that records the current Issue triage route.

The four labels are `harlan-agent-ready-to-implement`, `harlan-agent-ready-to-spec`, `harlan-agent-needs-info`, and `harlan-agent-wait-to-implement`.

### Issue triage comment

One self identified automated triage record on an issue. Re-runs update the canonical comment.

### Pull request triage

One routing decision for one exact pull request head commit.

A conventional non-breaking `chore:` title skips Review without starting an Agent.

Every other pull request uses a low-cost Agent decision. It requires or skips an adversarial Review. Any uncertainty requires Review.

`harlan-agent-review` requires Review and is the manual override. `harlan-agent-review-skipped` records a skipped Review.

### Take Ownership

One workflow that remains responsible for current work through its required delivery verification.

Use for repository policy, skill names, and dashboard controls.

Never use PR Owner, PR ownership, or deployment ownership for this workflow.

### Publication command

One durable request for the controller to push a pinned, verified commit or write a comment.

The controller verifies the expected head SHA before each write. Agents cannot execute Publication commands.

### Review run

One agent turn that produces one automated review.

A Review run stores its Revision, Agent report, controller gate evidence, Review outcome, agent version, and timestamps.

Store it before later GitHub reads or writes. A failed controller operation resumes from the Review run.

Named after GitHub's `check run`, which has the same shape: one execution against one commit that reports a conclusion. Do not use attempt, pass, or session.

### Review usage

The total input, cached input, cache write, output, and reasoning tokens one Review run used.

Use `Unavailable` when the Agent provider reports no usage. Never infer usage from text length.

### Agent feedback

One explicit human judgment about one Review run: Useful, Noisy, or Wrong.

Noisy and Wrong need a reason. Useful may include a reason.

Use Agent feedback. Do not use rating, vote, or reaction.

### Review gate

One required condition for a Review outcome.

Use only merge, review, and CI gates. Head stability is an invariant checked before publication.

A Review gate is this service's own condition. GitHub's `required check` is a different thing, so never call a Review gate a check, and never call a GitHub check a gate.

### Review outcome

One deterministic result derived from all Review gates.

Use `READY`, `PENDING`, or `BLOCKED`. Only `READY` shows confidence.

`PENDING` and `BLOCKED` are GitHub's own words: `PENDING` is a check status and a review state, `blocked` is a mergeable state. Do not use waiting, in progress, or failed.

### Running label

One GitHub label, `harlan-agent-running`, that says an Agent holds a Running Task on this issue or pull request now.

A scheduler adds it when it takes the lease and removes it when it gives the lease up. It shares one mutually exclusive set with the Review outcome labels, so a settled verdict removes it and a new Agent removes a stale verdict.

An Item with no Running Task carries no Running label, whatever GitHub still shows. A process that died mid-Task leaves the label behind, and a startup sweep answers that from the Journal.

Do not use active, in progress, working, or busy.

### Review finding

One material issue found during review.

Use `Fixed` after repair. Use `Open` with the next action while unresolved.

GitHub's `annotation` is anchored to a file and line on a check run. A Review finding is prose, so it is not an annotation. Never use annotation for it.

### Publication

One immutable record of a GitHub write: an automated review comment or a pushed commit.

Store the exact Markdown and remote acknowledgement. Store failures with their reason.

### Approval

One local decision for one exact issue or pull request Revision.

This is Harlan authorizing the service to act. It is not a GitHub pull request review, and it never posts one. When you mean GitHub's, write "approving review".

In `Manual` Selection mode, every pull request requires Approval. In `Auto`, only a pull request from an author who cannot write to the repository does.

For an outside contributor's issue, Approval permits Issue work. Use `harlan-agent-review` on GitHub or `Approve` in the dashboard. Harlan's issues do not require Approval.

For a pull request, Approval permits read only Review and separate scoped Repair in one workflow. Use `Review and repair` for the dashboard action.

A new external Revision requires new Approval. A controller-published repair commit continues the approved workflow.

### Auto merge

One GitHub label, `harlan-agent-auto-merge`, that hands a pull request to GitHub's own auto-merge.

Only a user with write access can label a pull request, so the label cannot come from an outside contributor. Without it, the pull request waits for Harlan.

After a published `READY` Review outcome at or above the configured confidence, the service enables GitHub's auto-merge at the exact head SHA. **GitHub performs the merge**, once GitHub's own branch protection is satisfied. A new push cancels it, because GitHub cancels auto-merge on a moved head SHA.

Auto merge never changes whether a pull request is reviewed. Automated review runs either way.

Write GitHub's feature as "auto-merge", hyphenated. Do not use self merge, automatic approval, automerge, or merge tier.

### Legacy issue cutoff

One fixed date. Ignore issues created before this date. Do not derive it from the current date.

### Action required

An Item or Task that requires Harlan's decision or action.

`action_required` is GitHub's own check conclusion for the same situation, so this service reuses it.

Use instead of needs attention, stuck, failed, blocked, or human required in dashboard copy.

### Incident

One named failure the controller observed, shown in the System pane.

Repeats of the same failure raise the occurrence count on one Incident. An Incident closes on its own when the work behind it succeeds.

An intentional shutdown never creates an Incident. Reaching a Reserve never creates one either. Both are normal controller state.

`Incident` is GitHub's own word on their status page, where it carries the same meaning.

Use instead of error, problem, outage, or alert in dashboard copy.

### Recovery

What the controller will do about one Incident without being asked.

One of `Retrying`, `Retries exhausted`, or `Action required`.

### Process finding

Evidence that a skill, policy, or workflow should change.

## Banned

| Never | Use instead | Why |
| --- | --- | --- |
| subject, work item, entity | Item | One concept, and Item follows GitHub Projects |
| worker, for the thing that answers a turn | Agent | Two words for the running agent. `worker_id` keeps the word, because there it means Lease holder |
| attempt as a noun, pass | Review run | Named after GitHub's check run |
| rating, vote, reaction | Agent feedback | One explicit judgment about one Review run |
| annotation | Review finding | GitHub anchors annotations to a line; findings are prose |
| needs attention, stuck, human required | Action required | GitHub's own check conclusion |
| waiting, in progress | PENDING | GitHub's own check status and review state |
| failed, as a Review outcome | BLOCKED | GitHub's own mergeable state |
| job | Task | `job` is a GitHub Actions unit and must keep that meaning |
| scheduled task, cron task | Routine | A Task belongs to an Item. A Routine answers a clock. |
| bot | Agent | Reads as a GitHub App, which the agent is not |
| ticket, card | issue | GitHub's word |
| PR in prose | pull request | GitHub's word |
| target branch, destination | base branch | GitHub's word |
| source branch, commit id | head ref, head SHA | GitHub's word |
| CI job, build, test run | check run | GitHub's word |
| merge status, conflict flag | mergeable state | GitHub's word |
| automerge, self merge, merge tier | auto-merge | GitHub's spelling of its own feature |
| error, problem, outage, alert | Incident | One concept |
| agent config, model config, model override | Agent selection | One concept |
| opt-in, allowlist, gating, triage mode | Selection mode | One concept |
| skip, ignore, mute, snooze, delete | Dismissal | GitHub's own word for the same decision |
| config default, unset, no override, clear | Follow configuration | One Agent selection state, and one label |
| auto provider, failover, load balancing, fallback mode | Automatic selection | One Agent selection state |
| quota, headroom, budget, safety margin | Reserve | One concept |
| reasoning variant, thinking level, effort level | Reasoning effort | Codex's own name for the setting |
| PR Owner, PR ownership, deployment ownership | Take Ownership | One workflow |
| risk level, skip review, review waiver, review exemption | Auto merge | Auto merge never affects whether review runs |
| restart queue, drain mode | Restart request | Queue and Pause already name different service concepts |
| journal, lease, fence, mutation, publication, revision, snapshot, item, agent role | rewrite the sentence | Internal machinery, never user-visible |

## Open questions

Naming calls this file does not settle. Resolve one, fold the answer in, delete the entry.

1. **Does Auto merge need a fallback when a repository has no branch protection?**
   GitHub refuses `enablePullRequestAutoMerge` on a pull request that is already
   mergeable with nothing left to wait for, so a repository with no required
   checks cannot use the feature at all.
   - Fall back to a direct merge at the pinned head SHA, which reintroduces the
     mechanism this term was renamed away from.
   - Refuse, and record an Incident naming the missing branch protection.
   - Require branch protection on every repository that uses the Auto merge label.

2. **Should `Task` become `job` after all?**
   GitHub Actions owns `job`, which is why a Task is not one today. If the
   service ever reports its Tasks to GitHub as check runs, the distinction stops
   being defensible and `job` becomes the honest word.
