# Plan: scheduled Routines

Status: approved 2026-08-27. Target package: `packages/harlan-github-agent`.

Supersedes the proposed version of this plan. The vocabulary, the Candidate ledger, and the
`report` and `propose` modes survive unchanged. The schedule moved from service configuration
into each repository, and the first Routines changed.

## Problem

Every Agent today needs an external Item. A [GitHub](https://github.com) issue or pull request
must exist before any agent runs.

Scheduled work has no such Item. A daily [Sentry](https://sentry.io) check-in answers a clock. So does a pull request
triage sweep. Dead code and duplicated abstractions never announce themselves either. The service
cannot start any of that work.

The journal spine runs `subjects` to `revisions` to `tasks`, so a clock-triggered run has nothing
to hang from. That is the whole gap.

## Goal

The service runs named Routines on a schedule. Each repository declares its own schedule in its
own source. Each run finds its own work, opens one small pull request per finding, and reports
its results in one place.

The existing spine stays unchanged: worktree isolation with `wt`, one agent permit pool,
Publication commands with head checks, and adversarial review on every opened pull request.

## Vocabulary

`GLOSSARY.md` defines no term for this concept. These terms are approved.

| Term | Meaning | Displaces |
| --- | --- | --- |
| Routine | One named job with a schedule, a scope, and a prompt | daily routine, cron job, sweep |
| Routine run | One execution of one Routine against one Repository mapping | run, sweep, pass |
| Candidate | One proposed change found by a Routine run, before any edit | finding, opportunity, hit |
| Candidate ledger | The durable record of every Candidate and its result | history, memory, cache |

`Routine` avoids GitHub's vocabulary. `workflow`, `job`, and `run` all belong to GitHub Actions
in `GLOSSARY.md`, so none of them was available.

Customer words: "routine" and "candidate" are safe in dashboard copy. "Candidate ledger" is
internal only.

**Resolved.** A Routine run is not an Item and never becomes one. Items stay "one GitHub issue or
pull request", which is the definition every other part of the service relies on. Routine runs get
their own tables. A synthetic Item would put a clock in the Queue and on the Watching page, where
nothing can act on it.

## Decisions taken 2026-08-27

1. **One repository per Routine run.** A Routine that covers several repositories fans out to one
   run each. Each run gets its own worktree, lease, budget, Candidate ledger, and pull request.
   This reuses the existing contract exactly and needs no second execution path.
2. **The schedule lives in the repository.** Not in service configuration. GitHub is the source of
   truth, so the schedule is source code and moves with the repository.
3. **First Routines are `sentry-checkin` and `pr-triage`.** Both are existing skills, already
   trusted by hand. The maintenance Routines from the proposed plan come later.
4. **Both first Routines run in `propose` mode.** They open pull requests from the first run. They
   are proven skills, so the report-only soak does not apply to them. `report` stays in the model
   for the maintenance Routines, which are not proven.

## The repository spec

One file, read from the default branch only.

```yaml
# .github/harlan-agent.yml
version: 1
routines:
  - name: sentry-checkin
    on:
      schedule:
        - cron: '0 7 * * *'
    timezone: Australia/Sydney
    mode: propose
    enabled: true
```

`on.schedule[].cron` copies GitHub Actions exactly, so the spec introduces no new vocabulary.

Routines that belong to no single repository live in `harlan-agent-kit` with `scope: fleet`.

### Trust boundary

The spec is source code, and source code is untrusted input. Two rules, both required.

1. Read the spec from the default branch SHA only. Never from a pull request head. Otherwise any
   pull request schedules local agent work.
2. The spec selects among Routines the service already knows, and that repository policy already
   permits. It may set the schedule, the mode, and enabled. It may never name a command, a model,
   a path, a skill, or any new authority.

Record which spec commit produced each run, the same way every other dispatch pins a SHA.

## Work items

### 1. Routine and Candidate state

- [ ] Add `Routine`, `RoutineRun`, and `Candidate` tagged unions to `src/types.ts`.
- [ ] Add `AgentRole` values `routine_scan` and `routine_fix`, with role profiles in `src/agent-profile.ts`.
- [ ] Add `routines`, `routine_runs`, and `candidates` tables to `src/store.ts`.
- [ ] Give each Candidate a stable fingerprint: Routine name, repository, and normalized target.
      Use a symbol path or file path. Never use a line number.
- [ ] Record one Candidate result per row: `proposed`, `merged`, `rejected` with reason, or `superseded`.

Acceptance: two scans of an unchanged repository produce the same fingerprints.

### 2. Spec reader

- [ ] Read `.github/harlan-agent.yml` from the default branch SHA through the GitHub App contents
      read. Never from the local checkout, and never from a pull request head.
- [ ] Parse it once at the boundary into a precise type. Reject an unknown Routine name, an
      unknown mode, and any key the spec may not set.
- [ ] A malformed spec disables that repository's Routines and records one Incident. It never
      fails service start, because one bad repository must not stop the rest.
- [ ] Store the spec commit on every Routine run.
- [ ] Document the file in `README.md`, with the trust boundary stated.

Acceptance: a spec that names an unknown skill or an extra key is refused with one clear reason.

### 3. Routine scheduler

- [ ] Add `src/routine-scheduler.ts` beside `src/task-scheduler.ts`.
- [ ] Claim one due Routine run per tick. Respect `Pause`, the capacity gate, and the agent permit pool.
- [ ] Skip a due run when open pull requests for that Routine reach `max_open_pull_requests`.
      Record the skip with its reason.
- [ ] Never run two runs of one Routine against one repository at the same time.
- [ ] Catch-up window: store `lastRunAt` per Routine and repository. Run once for a missed instant
      inside the window. Skip and record anything older. Never queue a backlog. At most one run
      per Routine is ever pending.

Acceptance: a slow run does not stack. A paused service starts no run. A machine asleep for two
days runs each Routine once on waking, not twice.

### 4. Scan task

- [ ] Run the scan agent in a read-only Git worktree. Deny commits and pushes at the worktree
      level, not by instruction.
- [ ] Return a schema-checked Candidate list through `src/agent-turn.ts`, like the existing review
      and triage responses.
- [ ] Each Candidate carries: fingerprint, target, one sentence claim, expected verification
      command, and estimated changed files.
- [ ] Drop Candidates over `max_changed_files` before queueing.

Acceptance: a scan makes no working tree change and returns valid structured output.

### 5. Candidate ledger and rejection memory

- [ ] Deduplicate new Candidates against every prior fingerprint for that Routine and repository.
- [ ] Inject prior rejections and their reasons into the next scan prompt.
- [ ] When a routine pull request closes unmerged, store the close comment as the rejection reason.
- [ ] Expire a rejection only when the target file changes.

Acceptance: a rejected Candidate does not reappear in the next run.

### 6. Fix task

- [ ] Queue one fix task per surviving Candidate. One Candidate produces one pull request.
- [ ] Reuse the Issue work path: prepared worktree, agent-owned commit message, controller-owned
      push through a Publication command.
- [ ] Stop the task when the diff exceeds `max_changed_files`. Record the Candidate as `superseded`
      with that reason.
- [ ] Label each pull request `routine:<name>`{lang="html"}.

Acceptance: a fix task cannot push without a matching Publication command.

### 7. Verification contract

- [ ] Require the verification gate to pass before any Publication.
- [ ] Require evidence in the pull request body: the exact repro command, before and after output,
      and a truth table for logic changes.
- [ ] Publish nothing when evidence is missing. Mark the Candidate `needs attention`.
- [ ] Confirm routine pull requests enter adversarial review with no extra Approval, because the
      author is `harlan-zw`.

Acceptance: a routine pull request with no evidence never reaches GitHub.

### 8. Reporting

- [ ] Upsert one tracking GitHub issue per Routine per repository. Reuse the self identified
      comment pattern in `src/issue-triage-comment.ts`.
- [ ] Report per run: Candidates found, pull requests opened, merges, rejections, and skips.
- [ ] Record a skipped run and its reason. A silent skip reads as a run that found nothing.
- [ ] Add a Routines page to the dashboard, fed by `src/agent-activity.ts`.
- [ ] Show merge rate per Routine over the last 14 days.

Acceptance: one issue thread explains every run without reading logs.

### 9. First Routines

- [ ] `sentry-checkin`: the open Sentry backlog for that repository, in `propose` mode.
- [ ] `pr-triage`: the open pull request backlog for that repository, in `propose` mode.

Both already exist as skills with their own coverage rules. Neither needs the report-only soak,
because both are already run by hand and trusted.

Later, in `report` mode first: `dead-code`, `useless-test`, `dup-unifier`, `layering`,
`glossary-drift`, and `flaky-test`. Each earns `propose` by holding 70 percent Candidate precision
over a week.

No crash fuzzer. The equivalent for this stack is a [Playwright](https://playwright.dev) route
sweep against the dev server. Treat it as a separate plan.

### 10. Second machine

- [ ] Add a `triggers` list to service configuration. Default to every trigger.
- [ ] `triggers: [routine]` runs Routines and nothing else. The desktop keeps the GitHub triggers.
- [ ] Document the split in `README.md`.

Disjoint triggers mean no Task is ever visible to both machines, so two independent services need
no lock and no protocol. `hogwild` produces work, GitHub carries it, the desktop reviews it.

This holds until one machine takes GitHub-triggered work the other could also claim. At that
point split by repository instead, which is still disjoint. A single shared pool needs one journal,
so it needs remote runners, and that is a separate plan.

## Risks

Review capacity is the limit, not agent capacity. A high volume of pull requests only works when
rejection costs nothing. `max_open_pull_requests` carries that load.

A Routine that proposes the same rejected change every day destroys trust faster than a wrong fix.
Ship item 5 with the first Routine. It carries this risk alone.

A scan agent with write access turns one bad prompt into a repository-wide change. Item 4 must deny
writes at the worktree level, not by instruction.

Unattended overnight runs spend the same weekly subscription window Harlan does. The Reserve and
`Automatic` Agent selection landed first for that reason. See `src/provider-capacity.ts`.

A repository spec is untrusted input. Without the two trust rules above, a pull request to a
maintained repository schedules local agent work.
