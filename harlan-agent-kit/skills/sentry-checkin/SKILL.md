---
name: sentry-checkin
description: Triage and repair every open Sentry issue across Harlan's site inventory. Use when asked to check Sentry, run a Sentry check-in, fix production errors, or clear site error backlogs. Discovers every Sentry project, groups projects by site, delegates one site per agent, requires complete issue coverage, isolates concurrent same-repository work with wt, and opens one PR through $harlan-agent-kit:pr when fixes exist.
---

# Sentry Check-in

Turn the complete open Sentry backlog into one verified PR per affected site. Account for every issue present at discovery time.

## Worktree isolation

Before site edits, follow the [worktree isolation contract](../../references/worktree-isolation.md). It provides the atomic live-agent claim used below.

An existing worktree alone does not prove another agent is active.

`wt` is the only worktree tool. Never run `git worktree add`, and never use a harness worktree option such as `EnterWorktree` or `isolation: "worktree"`. Those write to `.claude/worktrees/`, which is banned. `wt` places every worktree at `<parent>/<repo>.<branch-slug>`.

Use `wt` for a site only when another agent is actively modifying the same repository. Otherwise keep the current checkout. Before concurrent edits, run `wt list --format=json`. Reuse a worktree only when it belongs to the same frozen site task. Otherwise create one with `wt switch --create <branch> --base <base>`. Read its absolute `path` from the JSON, then pass that path as `workdir` to every later command.

## Load the contracts

Read these files completely before discovery:

1. The site inventory. Check `$SITES_FILE`, `~/SITES.md`, then `~/sites/SITES.md`, in that order.
2. `../unit-tests/SKILL.md`, for bug fix tests.
3. `../pr/SKILL.md`, for worktree, PR, CI, and review rules.
4. `references/site-agent-contract.md`, for the exact delegated workflow.

If no inventory exists, stop before spawning agents or editing repositories. Report every path checked.

## Verify Sentry access

Prefer an installed `sentry-cli`. Otherwise use `pnpm dlx @sentry/cli`.

```bash
pnpm dlx @sentry/cli info
pnpm dlx @sentry/cli organizations list
```

Use the sole organization when only one exists. If two or more exist and the request names none, ask which organization is in scope.

Use `sentry-cli` for authentication, project discovery, and issue discovery. Sentry CLI 3.6 does not expose issue or stack details. The bundled `scripts/sentry_api.py` fills only that read-only gap. It uses the CLI token from `~/.sentryclirc` and redacts common secrets and personal data.

Create a persistent run directory outside every repository:

```bash
mkdir -p "${XDG_STATE_HOME:-$HOME/.local/state}/sentry-checkin"
SENTRY_CHECKIN_RUN_DIR=$(mktemp -d "${XDG_STATE_HOME:-$HOME/.local/state}/sentry-checkin/run-XXXXXXXX")
```

## Build the site map

1. Parse every site and main checkout from the inventory's Projects table.
2. List current Sentry projects with the CLI:

   ```bash
   pnpm dlx @sentry/cli projects list --org ORG
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

A high `unclosed` count means fixes are landing but Sentry never hears about it. Report the count with the run.

The history is evidence from a past run, not a verdict. It never shortens the ledger: every frozen ID still needs its own row and its own evidence this run.

## Delegate one agent per site

Spawn exactly one agent for every mapped inventory site, including sites with zero open issues. Queue agents when concurrency slots are full. Never spawn two agents for one checkout.

Pass each agent:

- The site name and absolute main checkout path.
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

Do not resolve or mute Sentry issues when opening a PR. Code is not live yet. Let a verified release resolve issues, unless the user explicitly asks for a Sentry state change after production verification.

## Record the run

After every site returns a complete audited ledger, append the run to the history:

```bash
python3 scripts/ledger.py record --ledger SITE_ARTIFACTS/ledger.tsv \
  --run-id "$(basename "$SENTRY_CHECKIN_RUN_DIR")" --run-date YYYY-MM-DD
```

Repeat `--ledger` for every site. `record` refuses a ledger with any empty disposition, so run it only after each audit passes. It skips rows already recorded for the same run, so a repeat is safe.

## Return the run

Report each site with its issue count, ledger coverage, PR URL, CI state, and confidence. List zero-issue sites and unmatched projects. Keep blocked rows explicit. Give the run's `new`, `recurring`, and `unclosed` counts, and name the history path.
