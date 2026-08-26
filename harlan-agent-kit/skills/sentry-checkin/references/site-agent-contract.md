# Site agent contract

Own one site from frozen Sentry snapshot through one verified PR. Do not delegate this site again.

## Establish isolation

1. Read repository-local `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, and `GLOSSARY.md` before edits.
2. Inspect the main checkout status without changing it. Preserve all existing changes.
3. Follow the [worktree isolation contract](../../../references/worktree-isolation.md). Acquire its atomic claim before checking for another active agent. An existing worktree alone does not prove activity.
4. If none is active, keep the current checkout. Run `git switch -c fix/sentry-checkin-YYYYMMDD-SITE` before the first edit when no task branch exists.
5. If another agent is active, run `wt list --format=json`. Reuse an open `fix/sentry-checkin-*` PR worktree only when it targets the same frozen issues. Otherwise run `wt switch --create fix/sentry-checkin-YYYYMMDD-SITE --base BASE`. Read its absolute `path` from the JSON and pass it as `workdir` to every later command.

All fixes, tests, commits, and PR actions for this site happen in the selected task checkout or worktree. Never use a checkout owned by another active task. Never create a worktree per issue.

## Inspect every issue

For snapshots with at most 25 issues, fetch the latest compact event for each issue:

```bash
python3 SKILL_DIR/scripts/sentry_api.py --org ORG bundle \
  --project PROJECT --issue ISSUE_ID --events 1 --compact
```

For larger snapshots, use the resumable bulk command. Use at most four workers:

```bash
python3 SKILL_DIR/scripts/sentry_api.py --org ORG bulk-bundles \
  --project PROJECT --snapshot PROJECT.snapshot.json \
  --output SITE_ARTIFACTS/PROJECT --events 1 --workers 4
```

Rerun the same command after transient failures. It preserves completed redacted bundles and writes a checksum manifest. Read the latest event stack, release, environment, request path, breadcrumbs, tags, and source context. Fetch up to five events with `bundle` only when the latest event lacks evidence.

Initialize one site ledger from every project manifest before editing:

```bash
python3 SKILL_DIR/scripts/ledger.py init \
  --manifest SITE_ARTIFACTS/PROJECT/manifest.json \
  --output SITE_ARTIFACTS/ledger.tsv
```

Repeat `--manifest` for sites with several projects. Fill every row. Preserve the TSV as the run artifact.

Cluster issues only after stack and release evidence proves one root cause. Keep every issue as its own ledger row.

Read the history report handed to you. It tags each frozen ID `new`, `recurring`, or `unclosed`.

Treat a prior disposition as a lead, never as an answer. It tells you where a past run looked, so you can reach the same evidence faster or find it no longer holds. It never substitutes for this run's evidence, and it never removes a row.

An `unclosed` ID needs care. A past run already proved a commit fixes it, and the issue is open anyway. Do not repeat that proof. Establish which of these is true, and record it as the evidence:

- The fix is deployed and the issue is stale in Sentry. Disposition `already-fixed`, and name the release that carries the fix plus the last-seen time that precedes it. Resolve it in that release.
- The fix is merged but never deployed. Disposition `blocked`, naming the missing deploy.
- The fix does not hold. Treat it as a live defect and fix the category, not the instance.

## Decide each disposition

- Reproduce local defects when practical.
- For bugs and validation logic, write the failing exported-API test first.
- Design out the failure category when a type or boundary change can make recurrence impossible.
- Confirm `already-fixed` against a specific commit and the event's release or last-seen time.
- Never answer an `unclosed` ID with `already-fixed` on the same commit a past run already cited. Name why it stayed open.
- Use `expected` only when the behavior is intended. Improve filtering or context when Sentry still reports it as an error.
- Use `third-party` only after locating the external frame or service boundary. Add a safe local mitigation when one exists.
- Use `blocked` only after exhausting repository, Sentry, history, and dependency evidence.

Do not hide failures with a silent catch. Do not treat an old issue as fixed because it is old.

When a release resembles a commit SHA, verify it with `git cat-file -e RELEASE^{commit}`. Otherwise use `sentry-cli releases list`, deployment time, and the first containing commit. Record the evidence. Never infer a release match from chronology alone.

## Implement the complete site fix

Fix every actionable root cause in the same worktree. Keep unrelated user changes out of the branch. Use repository skills and current framework guidance when they match the code touched. Follow `../../../references/code-comments.md` for every comment you write.

Run focused tests after each root-cause fix. Then run every check required by repository instructions and CI. Record exact commands and results.

If a required check fails, compare it with the untouched base revision. Fix regressions introduced by this branch. Record an identical base failure as baseline debt with its exact command and error. Baseline debt does not justify skipping other checks.

## Open one PR

Audit the ledger first:

```bash
python3 SKILL_DIR/scripts/ledger.py audit \
  --manifest SITE_ARTIFACTS/PROJECT/manifest.json \
  --ledger SITE_ARTIFACTS/ledger.tsv
```

Repeat `--manifest` for every project. Invoke `$harlan-agent-kit:pr` from the worktree after the audit and local checks pass. Include the Sentry short IDs in the PR description only when they help reviewers. Let the PR skill create or update the PR and monitor CI and review feedback.

If the audited ledger produces no code diff, do not create an empty PR. Confirm the selected checkout is clean. If this task created a worktree, run `wt remove <branch>`. Then return the ledger checksum. If GitHub registers no PR checks, report `no PR workflow` after confirming the PR remains mergeable.

Do not deploy. Never mute a Sentry issue.

## Close what you proved

Resolve an issue only on the evidence in your own ledger. Run the plan first, then apply.

```bash
python3 SKILL_DIR/scripts/sentry_api.py --org ORG resolve --project PROJECT \
  --issue ID --in-next-release --apply
```

- `fixed` rows: `--in-next-release`, only after your PR merges into the default branch. If it is still open when you finish, leave the issue open and say so. The next run inherits it.
- `already-fixed` rows: `--in-release VERSION`, naming the deployed release that carries the fix.
- `covered` rows: follow the owning row, after it resolves.
- `expected`, `third-party`, `blocked`: never resolve.

Use `--in-next-release` only when CI owns every release for that project. A local build with an auth token can create a release that was never deployed, and that release would close the issue early. Name the release with `--in-release` instead.

## Return evidence

Return:

1. The PR URL and branch.
2. Exact checks and results.
3. The ledger path, row count, checksum, and one row per frozen numeric issue ID.
4. The issue IDs owned by each test and fix.
5. Any blocked item with the exact next action.
6. Every issue you resolved, with the release that closed it, and every `fixed` row you left open because its PR had not merged.
7. Confidence out of 100, based on verified evidence.

For a zero-issue site, confirm the project query and return without a branch, worktree, or PR.
