---
name: sentry-checkin
description: "Triage and repair all open Sentry issues across Harlan's sites. Use for Sentry check-ins, production error backlogs, and verified repair PRs."
---

# Sentry Check-in

Turn the complete open Sentry backlog into one verified PR per affected site. Account for every issue present at discovery time.

## Routine mode

A Routine names one site and one repository. The turn is read only for that repository. Follow these rules and skip the rest of this file where they conflict.

- Skip the site inventory. The Routine names the site.
- Skip `references/site-agent-contract.md`. It describes delegated site agents. There are none.
- Use the installed `sentry-cli`. Fall back to `pnpm dlx @sentry/cli` only if none is installed.
- Never read `~/.sentryclirc`. `scripts/sentry_api.py` reads it for you. It redacts the output. Its `digest` command reads no token at all.
- Fetch evidence once with `bulk-bundles`. Then run `digest`. Read the digest, not the raw bundles.
- If `all_unchanged` is true, stop. Do not read code. Return `Candidates: []` and give the reason: the issue set and every issue match the last run.
- After the report is complete, run `digest` again with `--record`. That writes local run state. The state is neither a Sentry write nor a repository write. It is what makes the next run cheap.
- Never pass `--record` before the analysis is complete. A run that aborts after recording would hide the backlog from the next run.
- Return one JSON object only. Put no prose before it. Put no prose after it. The Routine parses the answer with `JSON.parse`.
- Put the report text in the `report` field. Use one `fingerprint` from the digest per Candidate, so the same defect keeps one identity.

The Routine command sequence for site PROJECT in org ORG:

```bash
mkdir -p "${XDG_STATE_HOME:-$HOME/.local/state}/sentry-checkin"
RUN_DIR=$(mktemp -d "${XDG_STATE_HOME:-$HOME/.local/state}/sentry-checkin/run-XXXXXXXX")
python3 scripts/sentry_api.py --org ORG snapshot --project PROJECT --output "$RUN_DIR/PROJECT.snapshot.json"
python3 scripts/sentry_api.py --org ORG bulk-bundles --project PROJECT \
  --snapshot "$RUN_DIR/PROJECT.snapshot.json" --output "$RUN_DIR/PROJECT" --workers 4
python3 scripts/sentry_api.py --org ORG digest --project PROJECT \
  --bundles "$RUN_DIR/PROJECT" --run-id "$(basename "$RUN_DIR")" --output "$RUN_DIR/PROJECT.digest.json"
```

The last command of the run, after the report exists:

```bash
python3 scripts/sentry_api.py --org ORG digest --project PROJECT \
  --bundles "$RUN_DIR/PROJECT" --run-id "$(basename "$RUN_DIR")" --record
```

## Worktree isolation

Before site edits, follow the [worktree isolation contract](../../references/worktree-isolation.md). It provides the atomic live-agent claim used below.

An existing worktree alone does not prove another agent is active.

`wt` is the only worktree tool. Never run `git worktree add`, and never use a harness worktree option such as `EnterWorktree` or `isolation: "worktree"`. Those write to `.claude/worktrees/`, which is banned. `wt` places every worktree at `<parent>/<repo>.<branch-slug>`.

Keep each primary site checkout read only. Run `wt list --format=json`. Reuse a worktree only when it belongs to the same frozen site task. Otherwise create one with `wt switch --create <branch> --base <base>`. Read its absolute `path` from the JSON, then pass that path as `workdir` to every later command.

## Load the contracts

Read these files completely before discovery:

1. The site inventory. Check `$SITES_FILE`, `~/SITES.md`, then `~/sites/SITES.md`, in that order.
2. `../unit-tests/SKILL.md`, for bug fix tests.
3. `../pr/SKILL.md`, for worktree, PR, CI, and review rules.
4. `references/site-agent-contract.md`, for the exact delegated workflow.
5. `../../references/code-comments.md`, for the code comment contract.

If no inventory exists, stop before spawning agents or editing repositories. Report every path checked.

## Verify Sentry access

Use the installed `sentry-cli`. Fall back to `pnpm dlx @sentry/cli` only if none is installed.

```bash
sentry-cli info
sentry-cli organizations list
```

Use the sole organization when only one exists. If two or more exist and the request names none, ask which organization is in scope.

Use `sentry-cli` for authentication, project discovery, and issue discovery. Sentry CLI 3.6 does not expose issue or stack details. The bundled `scripts/sentry_api.py` fills that gap. It uses the CLI token from `~/.sentryclirc` and redacts common secrets and personal data.

Never read `~/.sentryclirc` yourself. Never print the token. The script holds the token. The `digest` command gives event and user counts, so nobody needs a raw API call.

Every command in that script reads Sentry only, except `resolve`. `resolve` reports its plan and writes only with `--apply`. `digest` writes one local state file per project. That file is run memory, not a Sentry write.

Create a persistent run directory outside every repository:

```bash
mkdir -p "${XDG_STATE_HOME:-$HOME/.local/state}/sentry-checkin"
SENTRY_CHECKIN_RUN_DIR=$(mktemp -d "${XDG_STATE_HOME:-$HOME/.local/state}/sentry-checkin/run-XXXXXXXX")
```

## Build the site map

1. Parse every site and primary checkout from the inventory's Projects table.
2. List current Sentry projects with the CLI:

   ```bash
   sentry-cli projects list --org ORG
   ```

3. Match each project to a site using the site's tracked Sentry configuration. Search for exact project slugs with `rg` or `git grep`.
4. Group multiple projects that use one checkout into one site. Nuxt SEO normally groups `nuxtseo-site` and `nuxtseo-pro`.
5. Never map a project from name similarity alone. Report unmatched projects and inventory sites before mutations.
6. Exclude inventory exclusions. A Sentry project cannot silently broaden the inventory scope.

## Freeze the issue snapshot

Create one stable JSON snapshot per project before spawning site agents. This helper invokes `sentry-cli`:

```bash
python3 scripts/sentry_api.py --org ORG snapshot --project PROJECT \
  --output "$SENTRY_CHECKIN_RUN_DIR/PROJECT.snapshot.json"
```

The wrapper parses exact numeric and short IDs, writes a checksum, and stops at the CLI row cap. Treat `title_hint` as a hint because the CLI truncates long titles. Issue evidence supplies the complete title.

The CLI paginates a live query, so one issue can appear on two pages. The wrapper keeps the first row per ID and lists every dropped ID in `duplicate_ids_dropped`. Report a non-empty list with the run. `issue_ids_sha256` covers the unique IDs in numeric order, so it compares directly with the `ledger.py audit` checksum.

The snapshot is the run contract. New issues after discovery belong to the next run. Disappearing issues still need a ledger disposition.

## Digest the evidence

Fetch full bundles once per project, then summarize them:

```bash
python3 scripts/sentry_api.py --org ORG bulk-bundles --project PROJECT \
  --snapshot "$SENTRY_CHECKIN_RUN_DIR/PROJECT.snapshot.json" \
  --output "$SENTRY_CHECKIN_RUN_DIR/PROJECT" --workers 4
python3 scripts/sentry_api.py --org ORG digest --project PROJECT \
  --bundles "$SENTRY_CHECKIN_RUN_DIR/PROJECT" \
  --run-id "$(basename "$SENTRY_CHECKIN_RUN_DIR")" \
  --output "$SENTRY_CHECKIN_RUN_DIR/PROJECT.digest.json"
```

Full bundles are the default. `--compact` keeps exception frames only and drops thread and raw frames. Use it only when bundle size is the problem.

The digest lists each issue once: title, culprit, top in-app frames, first and last seen, event and user counts, release, and a stable `fingerprint`. Read the digest before any bundle. Open a raw bundle only when the digest lacks the evidence for one issue.

The digest also compares this run with the last digest for the project:

- `unchanged_since_last_run`: the issue kept its last-seen time and event count.
- `snapshot_unchanged`: the issue ID set matches the last run.
- `all_unchanged`: both hold for every issue.
- `runs_seen`: how many recorded digests saw this issue.

`digest` compares only. It writes the state file only with `--record`. Run `--record` once, after every ledger for the project is complete. An aborted run then leaves no state, and the next run analyses the backlog in full.

## Read the prior dispositions

Every completed run appends to one append-only history at
`${XDG_STATE_HOME:-$HOME/.local/state}/sentry-checkin/history.tsv`. Read it before delegating:

```bash
python3 scripts/ledger.py history --snapshot "$SENTRY_CHECKIN_RUN_DIR/PROJECT.snapshot.json" \
  --output "$SENTRY_CHECKIN_RUN_DIR/PROJECT.history.json"
```

Repeat `--snapshot` to cover every project of a site in one report. It tags every frozen ID:

- `new`: no prior run saw this issue.
- `recurring`: a prior run left it open, accepted, or blocked.
- `unclosed`: a prior run called it `fixed` or `already-fixed`, yet it is still open.

A high `unclosed` count means fixes are landing but Sentry never hears about it. Report the count with the run. An `unclosed` ID this run proves deployed gets resolved, not just re-triaged.

The history is evidence from a past run, not a verdict. It never shortens the ledger: every frozen ID still needs its own row and its own evidence this run.

## Delegate one agent per site

Spawn exactly one agent for every mapped inventory site, including sites with zero open issues. Queue agents when concurrency slots are full. Never spawn two agents for one checkout.

Pass each agent:

- The site name and absolute primary checkout path.
- The organization and all project slugs for that site.
- The snapshot paths and frozen numeric and short IDs.
- The history report path for its projects.
- A site artifact directory under the run directory.
- The absolute path to this skill directory.
- The full contract from `references/site-agent-contract.md`.

Site agents may inspect other repositories for context. They must change only their selected task checkout or worktree.

## Enforce complete coverage

Require one ledger row for every frozen issue ID. Allowed dispositions are:

- `fixed`: the PR contains a tested fix.
- `covered`: another row's root-cause fix covers this issue.
- `already-fixed`: a verified existing commit or release already fixes it.
- `expected`: intended behavior, with evidence and an instrumentation or filtering decision.
- `third-party`: no local fix exists, with dependency evidence and a mitigation decision.
- `blocked`: the exact missing evidence, authority, or external dependency is named.

`ignored` is invalid. Similar titles do not prove one root cause. A `covered` row must name the owning issue, test, and fix.

Require the site agent to run `scripts/ledger.py audit` against every project manifest. Compare its checksum and numeric ID set with the frozen snapshots. If any ID is missing, send the same agent a follow-up task. Do not accept its PR as complete until the sets match.

## PR and Sentry state

Each site with code fixes gets one branch and one PR. If another agent is active in that repository, it also gets one `wt` worktree. The site agent invokes `$harlan-agent-kit:pr` only after focused and repository-required checks pass. The PR skill owns push, metadata, CI, and review follow-up.

If a complete ledger produces no diff, do not create an empty PR. Confirm the branch is clean. If this task created a worktree, run `wt remove <branch>`. Return the verified ledger. If the repository has no PR workflow, state that explicitly and use the complete local gate as evidence.

Never mute a Sentry issue. Muting hides a live defect.

## Close what this run fixed

An open issue that nobody can close is the reason the same IDs return every run. Close them here, using the release as the proof.

Resolve only these dispositions:

- `fixed`: resolve in the next release, after the PR merges into the default branch. Never at PR open. An unmerged PR would let an unrelated release close the issue.
- `already-fixed`: resolve in the release that carries the fix, once this run proved that release is deployed.
- `covered`: resolve with the owning row's mode, after the owning row resolves.

Never resolve `expected`, `third-party`, or `blocked`. None of them is fixed.

Run the plan first, then apply:

```bash
python3 scripts/sentry_api.py --org ORG resolve --project PROJECT \
  --issue ID --issue ID --in-next-release
python3 scripts/sentry_api.py --org ORG resolve --project PROJECT \
  --issue ID --issue ID --in-next-release --apply
```

Use `--in-release VERSION` instead of `--in-next-release` for an `already-fixed` row. The command rejects a version the project does not hold.

`--in-next-release` binds to whichever release appears next. Use it only when CI owns every release for that project. If a local build can create a release, name the release with `--in-release`. A local build with an auth token creates a release that was never deployed, and that release would close the issue early.

Sentry reopens a resolved issue as a regression if the error returns. A fix that stops working still surfaces.

Project auto-resolve is the backstop, not the mechanism. It closes a stale issue when this run has no proof to act on. It never replaces a resolution the evidence supports.

## Record the run

After every site returns a complete audited ledger, append the run to the history:

```bash
python3 scripts/ledger.py record --ledger SITE_ARTIFACTS/ledger.tsv \
  --run-id "$(basename "$SENTRY_CHECKIN_RUN_DIR")" --run-date YYYY-MM-DD
```

Repeat `--ledger` for every site. `record` refuses a ledger with any empty disposition, so run it only after each audit passes. It skips rows already recorded for the same run, so a repeat is safe.

## Return the run

Report each site with its issue count, ledger coverage, PR URL, CI state, and confidence. List zero-issue sites and unmatched projects. Keep blocked rows explicit. Give the run's `new`, `recurring`, and `unclosed` counts, and name the history path.

Name every issue this run resolved, with the release that closed it. Name every `fixed` row left unresolved because its PR is still open. The next run inherits those.
