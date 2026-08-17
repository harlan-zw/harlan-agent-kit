# Plan: scheduled maintenance Routines

Status: proposed. No implementation changes yet. Target package: `packages/harlan-github-agent`.

## Problem

Every Agent today needs an external Item. A [GitHub](https://github.com) issue or pull request must exist before any agent runs.

Daily maintenance work has no such Item. Dead code, duplicated abstractions, useless tests, and layering violations never announce themselves. The service cannot start that work.

## Goal

The service runs named maintenance jobs on a schedule. Each job finds its own work, opens one small pull request per finding, and reports its results in one place.

Existing spine stays unchanged: worktree isolation with `wt`, one agent permit pool, Publication commands with head checks, and adversarial review on every opened pull request.

## Vocabulary additions (needs approval before any code)

`GLOSSARY.md` defines no term for this concept. These are proposals, not decisions.

| Proposed term | Meaning | Displaces |
| --- | --- | --- |
| Routine | One named maintenance job with a schedule, a scope, and a prompt | daily routine, cron job, sweep |
| Routine run | One execution of one Routine against one Repository mapping | run, sweep, pass |
| Candidate | One proposed change found by a Routine run, before any edit | finding, opportunity, hit |
| Candidate ledger | The durable record of every Candidate and its result | history, memory, cache |

Open question: a Routine run has no GitHub issue or pull request, so it is not an Item under the current definition. Decide between a new Item kind and a separate table before item 1.

Customer words: "routine" and "candidate" are safe in dashboard copy. "Candidate ledger" is internal only.

## Work items

### 1. Routine and Candidate state

- [ ] Add `Routine`, `RoutineRun`, and `Candidate` tagged unions to `src/types.ts`.
- [ ] Add `AgentRole` values `routine_scan` and `routine_fix`, with role profiles in `src/agent-profile.ts`.
- [ ] Add `routines`, `routine_runs`, and `candidates` tables to `src/store.ts`.
- [ ] Give each Candidate a stable fingerprint: Routine name, repository, and normalized target. Use a symbol path or file path. Never use a line number.
- [ ] Record one Candidate result per row: `proposed`, `merged`, `rejected` with reason, or `superseded`.

Acceptance: two scans of an unchanged repository produce the same fingerprints.

### 2. Routine configuration

- [ ] Extend `src/config.ts` with a `routines` list.
- [ ] Fields: `name`, `schedule` (cron), `repositories`, `skill`, `prompt_path`, `mode`, `max_candidates_per_run`, `max_open_pull_requests`, `max_changed_files`.
- [ ] `mode` accepts `report` or `propose`. Default to `report`.
- [ ] Reject an unknown skill name at load time. Fail the service start, not the first run.
- [ ] Document every field in `config.example.yml`.

Acceptance: an invalid Routine blocks service start with one clear reason.

### 3. Routine scheduler

- [ ] Add `src/routine-scheduler.ts` beside `src/task-scheduler.ts`.
- [ ] Claim one due Routine run per tick. Respect `Pause` and the existing agent permit pool.
- [ ] Skip a due run when open pull requests for that Routine reach `max_open_pull_requests`. Record the skip with its reason.
- [ ] Never run two runs of one Routine against one repository at the same time.

Acceptance: a slow run does not stack. A paused service starts no run.

### 4. Scan task

- [ ] Run the scan agent in a read-only Git worktree. Deny commits and pushes.
- [ ] Return a schema-checked Candidate list through `src/agent-turn.ts`, like the existing review and triage responses.
- [ ] Each Candidate carries: fingerprint, target, one sentence claim, expected verification command, and estimated changed files.
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
- [ ] Reuse the Issue work path: prepared worktree, agent-owned commit message, controller-owned push through a Publication command.
- [ ] Stop the task when the diff exceeds `max_changed_files`. Record the Candidate as `superseded` with that reason.
- [ ] Label each pull request `routine:<name>`{lang="html"}.

Acceptance: a fix task cannot push without a matching Publication command.

### 7. Verification contract

- [ ] Require the verification gate to pass before any Publication.
- [ ] Require evidence in the pull request body: the exact repro command, before and after output, and a truth table for logic changes.
- [ ] Publish nothing when evidence is missing. Mark the Candidate `needs attention`.
- [ ] Confirm routine pull requests enter adversarial review with no extra Approval, because the author is `harlan-zw`.

Acceptance: a routine pull request with no evidence never reaches GitHub.

### 8. Reporting

- [ ] Upsert one tracking GitHub issue per Routine per repository. Reuse the self identified comment pattern in `src/issue-triage-comment.ts`.
- [ ] Report per run: Candidates found, pull requests opened, merges, rejections, and skips.
- [ ] Add a Routines page to the dashboard, fed by `src/agent-activity.ts`.
- [ ] Show merge rate per Routine over the last 14 days.

Acceptance: one issue thread explains every run without reading logs.

### 9. First Routines

Order by risk, lowest first.

- [ ] `dead-code`: statically unreachable exports and files.
- [ ] `useless-test`: tests that cannot fail, under the `unit-tests` skill.
- [ ] `dup-unifier`: near duplicate abstractions, under `ripast` for the mechanical step.
- [ ] `layering`: Nuxt runtime code importing build-time code.
- [ ] `glossary-drift`: banned terms and undefined concepts, under the `glossary` skill.
- [ ] `flaky-test`: repeated CI failures with an unchanged commit.

Later: migrate `sentry-checkin` to a Routine. It already has a schedule, a ledger, and complete coverage rules.

No crash fuzzer. The equivalent for this stack is a [Playwright](https://playwright.dev) route sweep against the dev server. Treat it as a separate plan.

### 10. Rollout

- [ ] Run `dead-code` in `report` mode against one repository for one week.
- [ ] Grade Candidate precision by hand. Require 70 percent or better before mode change.
- [ ] Switch that Routine to `propose` with `max_open_pull_requests: 1`.
- [ ] Raise the cap only after 10 merged pull requests with no revert.
- [ ] Add the next Routine only after the previous one holds its merge rate. Repeat from step 1.

## Risks

Review capacity is the limit, not agent capacity. A high volume of pull requests only works when rejection costs nothing. `max_open_pull_requests` carries that load, so it starts at 1.

A Routine that proposes the same rejected change every day destroys trust faster than a wrong fix. Item 5 is required, not optional.

A scan agent with write access turns one bad prompt into a repository-wide change. Item 4 must deny writes at the worktree level, not by instruction.
