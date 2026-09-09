# Scheduled Routine

Inspect the named repository's complete Sentry backlog from the controller's prepared worktree.
The controller already owns the worktree and the Agent lease.
Do not create, switch, remove, or delegate worktrees.
Keep repository files unchanged. Do not commit, push, open pull requests, or deploy.

## Scope and access

Use the controller's repository mapping as the site inventory for this run.
A separate `SITES.md` is unnecessary. Do not discover or act on other sites.
Match every Sentry project through this repository's tracked configuration or DSN.
Never match by name similarity alone.
If the mapping is ambiguous, report the exact blocker before any Sentry write.

Verify Sentry access with `sentry-cli info` and project discovery.
If the CLI is missing, use `pnpm dlx @sentry/cli`.
The bundled `scripts/sentry_api.py` uses the token from `~/.sentryclirc`.
Missing tools, credentials, or deployment evidence are blockers, not zero-issue results.

## Evidence and history

Use the supplied Routine run ID as `SENTRY_CHECKIN_RUN_ID`.
Keep artifacts outside repositories, under `${XDG_STATE_HOME:-$HOME/.local/state}/sentry-checkin`.
Derive the run directory from the ID so retries retain the original snapshot:

```bash
SENTRY_CHECKIN_STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/sentry-checkin"
SENTRY_CHECKIN_RUN_KEY=$(printf '%s' "$SENTRY_CHECKIN_RUN_ID" | sha256sum | cut -d ' ' -f1)
SENTRY_CHECKIN_RUN_DIR="$SENTRY_CHECKIN_STATE_DIR/runs/$SENTRY_CHECKIN_RUN_KEY"
mkdir -p "$SENTRY_CHECKIN_RUN_DIR"
```

Resolve `SKILL_DIR` to this Skill's absolute directory before running its scripts.
Run `sentry_api.py snapshot` once per mapped project. Reuse existing snapshots after a retry.
Run `ledger.py history` with every snapshot and `--exclude-run "$SENTRY_CHECKIN_RUN_ID"` before inspecting issues.
Fetch `sentry_api.py bulk-bundles` for every snapshot, including small snapshots, to produce audit manifests.
Read each event's stack, release, environment, request path, breadcrumbs, and source context.
Run `ledger.py init` from all manifests. Reuse the existing ledger after a retry.
Keep one evidence-backed row per frozen numeric issue ID.

Use the Skill's dispositions and coverage rules.
If code needs repair, return a Candidate and mark its issue `blocked`, pending that repair.
Never call a proposed repair `fixed`. Include its Sentry IDs in the Candidate claim.
Account for repairs beyond the Candidate file limit in the report and ledger.
Do not propose unrelated repository cleanup.

## Resolve verified fixes

In `report` mode, keep Sentry read only and report eligible resolutions.
In `propose` mode, resolve `already-fixed` rows after proving their fixes reached a deployed release.
Resolve a `covered` row only after its owning `already-fixed` row resolves.
Leave every other disposition open.

Use the exact deployed release with `--in-release VERSION`.
A release record, old event date, successful HTTP response, or commit ancestry alone does not prove deployment.
Tie the deployed release to the fix through deployment records or live release metadata.
If that evidence is unavailable, keep the issue open and name the missing evidence.
Never use `--in-next-release` in a scheduled scan. Never mute issues.

Run `ledger.py audit` against every manifest before resolving anything.
Compare its numeric ID set and checksum with the frozen snapshots.
Run `sentry_api.py resolve` without `--apply`, then apply that same plan in `propose` mode.
Re-read each issue through the API and confirm its resolved status and release.
Keep the plan, response, and verification in the run directory.
If a resolution fails, record the failure and leave it explicit in the report.
There is no Routine `apply` mode. `--apply` belongs to the Sentry helper.

## Record and report

After the complete ledger passes audit, record history in both modes, even when no code changes are proposed.
Use the scheduled date for `RUN_DATE`. Serialize history writes across scheduled sites:

```bash
flock "$SENTRY_CHECKIN_STATE_DIR/history.lock" \
  python3 "$SKILL_DIR/scripts/ledger.py" record \
  --ledger "$SENTRY_CHECKIN_RUN_DIR/ledger.tsv" \
  --run-id "$SENTRY_CHECKIN_RUN_ID" --run-date "$RUN_DATE"
```

Return the complete Markdown report in `report`.
Include frozen issue count, ledger coverage, and `new`, `recurring`, and `unclosed` counts.
List resolved IDs with their releases, unresolved IDs with reasons, and code repair Candidates.
Include snapshot, ledger, audit, resolution evidence, and history paths.
Report missing evidence and script failures explicitly. Never claim a failed step completed.
For zero issues, still audit and record the empty ledger, and report the project query.
