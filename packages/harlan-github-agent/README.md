# Harlan GitHub Agent

Local service for Harlan's selected [GitHub](https://github.com) repositories.

Current:

- GitHub App repository discovery with strict local checkout checks
- [SQLite](https://sqlite.org) state and review history
- saved review results, findings, checks, and exact GitHub comments
- outside contributor issue approvals tied to the current issue state
- review and fix approvals tied to the current head commit
- approved issue work resumes the triage agent session and opens a pull request ready for review
- completed issue triage posts one self identified comment and updates it on reruns
- read only Review, followed by a fresh Repair Agent with every material finding
- fresh Review of every published Repair head SHA
- separate Baseline repair pull requests when default branch CI fails
- fixed cutoff date for old issues
- bounded GitHub polling with retry backoff
- optional GitHub webhooks on their own port, which hint a reconciliation instead of carrying state
- authenticated [H3](https://h3.dev) and [srvx](https://srvx.h3.dev) dashboard
- safe merge conflict commits and pushes
- two agent providers: [Codex](https://developers.openai.com/codex/sdk/) and [opencode](https://opencode.ai). Set `agent.provider` to `codex` or `opencode`
- role-specific Codex profiles: `gpt-5.6-sol` with high reasoning for adversarial review, and `gpt-5.6-terra` with medium reasoning for other work
- the opencode profile runs `zai-coding-plan/glm-5.3-flash` at the high reasoning effort for every role
- switch the Agent provider, model, and reasoning effort from the dashboard or the tray, with no restart
- `Automatic` Agent selection picks the provider with capacity left, and keeps a reserve of each published window for your own terminal
- opencode answers on the GLM Coding Plan with `zai-coding-plan/glm-5.3-flash`, and the service reads that plan's live quota
- one global limit of three active agents across reviews, issue work, and pull request fixes
- durable dashboard cancellation for active and queued tasks
- read-only public issue watches outside the GitHub App installation
- conflict fixes push only when the pull request head commit still matches
- repair commits push only when the approved head commit still matches

Still to build: Claude reviews, PR conformance, and deployment ownership.

## Run

Copy `config.example.yml` outside a repository, then restrict it:

```bash
chmod 600 /absolute/path/to/harlan-github-agent.yml
chmod 600 /absolute/path/to/github-app-private-key.pem
codex login          # Codex provider only
codex login status   # Codex provider only
opencode auth list   # opencode provider only
wt --version
pnpm --filter harlan-github-agent dashboard:build
pnpm --filter harlan-github-agent exec node --experimental-strip-types src/cli.ts --config /absolute/path/to/harlan-github-agent.yml
```

The repository owns the Worktrunk configuration and the safe environment file manifest.
Use these commands from the repository root:

```bash
pnpm worktrunk:update                  # Install Worktrunk configuration locally
pnpm service:hogwild:sync-worktrunk   # Install it on Hogwild
pnpm service:hogwild:sync-env         # Copy declared environment files to Hogwild
pnpm service:hogwild:update           # Sync everything, update, then restart
```

Environment files move one way from the desktop checkouts.
Git stores only their paths.
The sync rejects missing files, unsafe symlinks, untrusted paths, and files that Git does not ignore.

The dashboard denies framing. If another page must frame it, list its origin in `server.frame_ancestors`: HTTPS, or `http://localhost` with a port.

Save the dashboard password in `dashboard-password` beside the config file. Use at least 32 bytes and restrict the file to mode `600`.

Configure your normal global Git profile before starting. The controller uses its identity and commit-signing settings for every commit it creates.

Install the configured GitHub App only on selected repositories. `github.allowed_owners` is the first remote boundary. The service ignores public installations from every other GitHub owner. It then matches allowed repositories to trusted checkouts under `~/pkg` and `~/sites`. Optional repository entries override default policy.

Every tracked pull request authored by `harlan-zw` enters review without approval. An outside contributor receives one automated instruction comment. Adding `harlan-agent-review` approves only the named head commit. The service removes the label after saving the approval.

Every tracked pull request is reviewed. The `harlan-agent-auto-merge` label decides who merges the result. With the label, the service merges the pull request itself after a `READY` review at or above `auto_merge.minimum_confidence`. Without it, the pull request waits for Harlan. The agent that opens a pull request adds the label only when the change carries no judgement, for example a dependency bump. Auto merge stays off until `auto_merge.enabled` is true, and it covers owned repositories and trusted authors only. A repository block can set `auto_merge.pull_requests: every` with its own `minimum_confidence` to merge every trusted pull request without the label, for a demo site where a wrong merge costs little.

A repository can instead set `auto_merge.pull_requests: contained`, which lets a low risk code change merge on evidence rather than on a label. Every Review returns a Merge risk: `Contained` when a mistake costs one revert commit, `Reviewable` when a person should read it, `Sensitive` when a mistake is expensive or hard to undo.

Two independent answers produce it. The controller computes a floor from the changed paths and their counts, refusing to contain a pull request that is too large, that deletes or renames a file, or that touches a file an agent reads as instructions. The Review Agent returns its own claim from the diff, which is the only part that sees blast radius: three lines changing a shared default reach every consumer while every path looks small. The more dangerous of the two wins, so `Contained` needs both to agree and a wrong low needs two independent mistakes.

The label keeps working alongside it. `merge_risk.label_overrides_risk: false` makes a `Sensitive` verdict beat a label somebody left on a pull request that has since grown. A labelled pull request still clears the service-wide `auto_merge.minimum_confidence`, never the lower bar a repository sets for Merge risk.

Merge risk routes the merge and never the Review. Every tracked pull request is still reviewed, whatever it says.

No new issue work starts above `max_open_pull_requests` open pull requests. Review, repair, and conflict fixes continue, because they shorten that queue.

Owned repositories selected in the GitHub App enable Issue triage by default. A maintained repository needs an explicit mapping with `issue_work: true`. Without an installation, the controller uses Harlan's authenticated GitHub account. Harlan's issues, and the issues the service files for Routines, go through Issue triage and into Issue work on their own. An outside contributor's issue waits for `harlan-agent-review` or `Approve` before any agent reads it. One Approval names that exact issue state and covers Issue triage and the Issue work that follows when triage says ready. The service removes the label before saving the Approval. Edited issue text is a new state and waits again.

The triage agent resumes its own session, selects the matching installed skills, implements the change, and runs focused checks. The agent chooses the commit message and pull request metadata. The controller commits and pushes the verified result before it opens one pull request ready for review. Conflict fixes also run by default on owned repositories. They remain disabled on maintained repositories.

Review stays read only. Repair starts fresh with every structured finding. It writes each failing regression test before its fix.

Review decides the pull request premise once. A sound premise permits Repair. A wrong premise recommends Dismissal and never starts Repair.

GitHub status, comments, and labels hold durable workflow truth. The local journal coordinates leases, Agent sessions, Recovery, and Review usage.

Pull request triage uses `harlan-agent-review-required` or `harlan-agent-review-skipped`.
The final Review replaces that route with one outcome label: `ready`, `pending`, or `blocked`.
The canonical comment lists every Review gate and the next action.
After GitHub merges or closes the pull request, the comment records that state and Agent labels clear.

Every published Repair head SHA gets a fresh Review. If that Review still finds a defect, the next Repair round starts. It reads every earlier round's commit and report, so it does not repeat a rejected approach.
A pull request gets 3 Repair rounds per contributor commit. A contributor push starts a fresh count. When the rounds are spent, Repair stops with Action required and the comment lists every round.

If Repair stops, the canonical review comment changes to `BLOCKED`. It lists every finding and next action.

History stores each completed Review duration and Agent provider token usage. Older runs show usage as unavailable.

If default branch CI already fails, Repair leaves the reviewed pull request unchanged. One Baseline repair Agent fixes that exact default branch commit in a separate pull request.

Each Worker runs like a normal local agent session inside its own Git worktree. The controller creates each worktree from its mapped checkout with `wt`, so the global Worktrunk path template applies. Workers inherit the global agent context, installed skills, environment, provider login, and authenticated `gh` client. They may read past GitHub issues and pull requests. The controller still owns comments and pushes.

Switching the Agent provider starts new sessions. A saved session belongs to the provider that created it, so no Worker resumes a session from the other provider.

`agent.provider` names the Agent provider the service starts with. A switch from the dashboard or the tray overrides it and survives a restart.

`external_repositories` watches exact issue numbers or all current issues in a public repository. These watches use public GitHub data. They receive no GitHub App token and never add work to the queue.

Grant read access to metadata, contents, issues, commit statuses, and administration. Grant write access to Actions, checks, contents, deployments, issues, and pull requests. The service mints and reuses short-lived, repository-scoped tokens.

The Review also reports on one GitHub check run, `harlan-agent-kit / Review`, so `gh pr checks` shows its progress beside CI. It concludes `success` for a READY Review and `neutral` for every other outcome, never `failure`, so branch protection cannot gate on it. The service skips its own check runs when it reads CI, so the Review never gates on itself. An installation that has not granted Checks write sees every Review publication defer, and the defers clear once the permission lands.

A conflict fix also requires an owned repository, an allowed pull request author, an allowed branch prefix, and an unprotected head branch. The service pushes the checked commit from a clean bare Git repository.

Register the dashboard with `./bin/install-portless-alias`.

Open `https://harlan-github-agent.localhost/`. Use `agent` as the dashboard username.

## Control API and CLI

The dashboard and CLI use the same authenticated Control API.
Every CLI command prints one JSON value.
Expected failures print one tagged JSON error and exit with status 1.
Agents should use the CLI for monitoring and supported service controls.
Use the dashboard for visual inspection.
Call the Control API directly only when no matching subcommand exists.

Use the configuration file on the service host:

```bash
harlan-github-agent control status --config /absolute/path/to/harlan-github-agent.yml
harlan-github-agent control tasks --config /absolute/path/to/harlan-github-agent.yml
harlan-github-agent control incidents --config /absolute/path/to/harlan-github-agent.yml
harlan-github-agent control activity --task TASK_ID --config /absolute/path/to/harlan-github-agent.yml
harlan-github-agent control events --limit 50 --config /absolute/path/to/harlan-github-agent.yml
```

Target another instance with its URL and password file:

```bash
harlan-github-agent control pause --url https://harlan-github-agent.localhost --password-file /absolute/path/to/dashboard-password
harlan-github-agent control resume --url https://harlan-github-agent.localhost --password-file /absolute/path/to/dashboard-password
harlan-github-agent control restart --url https://harlan-github-agent.localhost --password-file /absolute/path/to/dashboard-password
harlan-github-agent control update --url https://harlan-github-agent.localhost --password-file /absolute/path/to/dashboard-password
harlan-github-agent control cancel --task TASK_ID --url https://harlan-github-agent.localhost --password-file /absolute/path/to/dashboard-password
```

The package exports the typed Control API client:

```ts
import { createControlClient } from 'harlan-github-agent'

const client = createControlClient({
  authentication: { _tag: 'Basic', password },
  baseUrl: 'https://harlan-github-agent.localhost',
  fetch,
})
```

## Webhooks

Set `webhook.enabled` to start the separate listener on port 3211.
The public route exposes only `POST /webhook` through Caddy.
Dashboard routes retain their password and Origin checks.
Follow the [public route setup](../../scripts/public-dashboard.md#github-webhooks) to configure the listener and GitHub App subscriptions.

Deliveries request a fresh GitHub read. Their bodies never authorize actions or replace GitHub state.
Signatures authenticate requests. Delivery identities suppress duplicates for one hour, up to 10,000 identities.
The cache clears on restart. Polling recovers missed deliveries.

Deliveries within three seconds share one read.
Deliveries during that read schedule at most one follow-up read.
Keep polling enabled for recovery.

GitHub is the durable Review workflow record. The newest confirmed canonical comment state wins across Review and gate updates. Before finalizing `CLOSED`, the service reads the exact pull request. It then publishes `MERGED` or `CLOSED`, clears Agent labels, and stores completion for restart Recovery.

Select `Automatic` in the Agent provider control to pick the provider by remaining capacity. It walks `agent.order` and takes the first provider whose window has more than its `agent.reserve_percent` left.

Codex publishes a seven-day window, read from `codex app-server`. opencode publishes the GLM Coding Plan windows, read from `https://api.z.ai/api/monitor/usage/quota/limit` with the key in `~/.config/opencode/opencode.json`. The plan publishes a five-hour window and a weekly one, and the fuller of the two decides, because a spent five-hour window stalls the fleet for hours whatever the week has left.

A provider that publishes no limit always passes. When no provider may spend, the service stops claiming new Agent Tasks. The System pane shows `Reserve reached`. Active agents and Publications finish.

Use the Agent provider control in the header to switch the Agent provider, model, or reasoning effort. A switch starts the next agent turn. An agent already running keeps the model it started with. Switching the provider returns the model and the reasoning effort to that provider's defaults.

Select `Restart after current work` to restart the service. The Restart request stops new Task claims and lets active Agents finish.
The service owns the request after acceptance. Manual Pause stays unchanged.

The CLI does not expose Review runs yet. Read one pull request's local review history from:

```text
/api/reviews?repository=OWNER%2FREPOSITORY&pull_request=NUMBER
```

Use the `Auto` and `Manual` control in the header to set the Selection mode. `Auto` reviews every eligible pull request. `Manual` waits for you to select each one, whoever opened it. Select a pull request with `Review and repair` in the dashboard, or with the `harlan-agent-review` label on GitHub. The Selection mode persists across restarts, and covers pull requests only.

The dashboard shows `Review and repair` for outside contributors, and for every pull request in `Manual`. One Approval covers read only Review and separate scoped Repair for that head commit.
Use `Eject` on a running agent to stop automation and resume its session in Ghostty. Codex sessions reopen with `codex resume`. opencode sessions reopen with `opencode --session`.
The desktop tray has separate Agent and GitHub Actions icons.
The Agent menu groups current Agent tasks under Hogwild and Desktop.
Tasks without a current provider turn stay outside those groups.
The menu also shows the desktop's shared memory use and limit.

Set the Actions autostart command in `~/.config/autostart/harlan-github-runner-indicator.desktop`:

```ini
Exec=/usr/bin/env "HARLAN_GITHUB_RUNNER_HOSTS=Hogwild=ssh://hogwild-admin|system:hogwild-github-runner.service,Desktop=unix:///var/run/docker.sock|user:harlan-desktop-github-runner.service" /home/harlan/.local/bin/harlan-github-runner-indicator
```

Keep any existing `HARLAN_GITHUB_RUNNER_REPOSITORIES` setting in that command.
The SSH account needs [Docker](https://docker.com) access and permission to control the runner service.
Restart the tray process after changing its environment. Running jobs continue.

Use `Watch logs` from the System pane to open a read-only live event stream while automation continues.
The System chip stays in the header. It opens the System pane, which shows Agent provider limits, Reserves, and unresolved Incidents.
It separates Harlan GitHub Agent from GitHub Actions. A runner failure never changes the Agent status.
`max_open_pull_requests` stops new issue work while that many pull requests are open. `Manual` Selection mode ignores the limit, because you already select every pull request.

Use `Dismiss` on a board card to never act on that pull request or issue again. A new commit does not undo it. Dismissing cancels the item's running and queued tasks. Restore it from `Dismissed` on the Watching page.

Use `Cancel` to stop an active or queued task. The task stays cancelled for that pull request commit. Closing the pull request uses the same path.

Enable `mutations_enabled` only after the selected repository policy and GitHub App permissions are correct.

## Package releases

Eligible open pull requests get one release checkbox in a bot comment.
Feature titles offer **Release minor after merge**. Fix and performance titles offer **Release patch after merge**.
Select it before merging. Clear it to cancel while the pull request remains open.
The selection survives service restarts. A changed head or release version clears the selection.
After merge, the controller waits for passing default branch push checks before preparing the release.
Pull request checks do not count as default branch checks.
Merged pull requests also retain a release checkbox when no selection exists.
Docs, chores, known breaking changes, and released changes get no checkbox.
If the unreleased range contains features, a fix cannot offer patch.
Use a feature pull request for that minor release.

Harlan can select the checkbox or comment `do release`, `do release patch`, or `do release minor`.
Only a signed GitHub webhook from the authenticated Harlan account grants release authority.
Comment edits cannot create text commands. Duplicate clicks and deliveries cannot publish another version.

Enable the webhook and `github` trigger. Enable repository writes and set Selection mode to Auto.
Add this block to an owned Repository mapping with `pull_request_review: true`:

```yaml
writable_pr_authors: [harlan-zw, 'harlan-github-agent[bot]']
release:
  manifest: package.json
  version_files: [package.json]
  tag_prefix: v
  workflow: release.yml
  checks: [test, build] # Use exact GitHub Actions check names.
  changelog: CHANGELOG.md # Optional. The file must already exist.
```

The policy authorizes stable patch and minor releases, including the release version pull request.
That pull request requires fresh Review at 90% confidence, required checks, and GitHub branch protection.
The general auto-merge label is not required. Source changes still follow their normal merge policy.

Before merge, the controller binds the selection to the pull request head and proposed release version.
After merge, it checks the full unreleased range again and pins the default branch commit.
It never promotes an approved patch to minor. A changed release needs a new selection.
It prepares configured JSON version files, then merges their verified pull request and creates the release tag.
If version changes already merged, it uses that checked commit directly.
The existing tag workflow builds and publishes. The controller verifies the workflow, [npm](https://npmjs.com) versions, and GitHub release.
Progress and failures stay in the release comment. Retries retain the original version.

The first adapter supports one jointly versioned npm package group per repository.
List every synchronized JSON version file. Public package manifests must appear in `version_files`.
It does not execute the repository's release script or arbitrary shell commands.
Do not enable it for independent versions, Cargo synchronization, custom version generators, or other publishing destinations.
Those workflows need their own preparation and verification support.

Only existing stable npm releases qualify. First releases, prereleases, and majors stay manual.
Conventional Commits classify the full range. Missing classification, truncated diffs, and apparent exported API removals suppress the action.
These checks cannot prove semantic compatibility for every possible source change.
If the branch or release policy changes after authorization, the controller stops instead of expanding the approved release.
A failed publishing workflow can be rerun in GitHub for the same tag.

## Weekly dependency updates

Add this entry to `.github/routines.yml` in each opted-in repository:

```yaml
version: 1
routines:
  - name: dependency-updates
    on:
      schedule:
        - cron: '0 8 * * 1'
    timezone: Australia/Melbourne
    mode: propose
    enabled: true
```

Keep other Routine entries when adding this one. This repository enables Monday at 08:00 Melbourne time.
Deploy a service version that supports `dependency-updates` before enabling it in other repositories.
The Routine scans npm dependencies across root manifests, workspaces, and [pnpm](https://pnpm.io) catalogs.
One Candidate becomes one issue. Issue work attempts all updates, including majors, in one pull request.
Blocked upgrades remain unchanged and appear in the result. TypeScript stays on version 6 until Harlan clears its exception.
A version-specific fingerprint prevents repeated proposals. A shared issue marker reuses any open dependency issue.
Scans report existing dependency pull requests instead of creating another. Review and Repair continue the existing pull request.
Registry failures fail the run. Non-registry dependencies appear in the report for follow-up.
The controller retains its normal Review and merge policies.

## Weekly CI review

The `ci-review` Routine reviews seven days of GitHub Actions logs, including successful runs.
This repository enables it each Monday at 10:00 Melbourne time in `propose` mode.
It reviews default-branch runs and runs for open pull requests, up to 100 runs per scan.
Missing logs and limits appear as incomplete coverage. The report explains each warning, including warnings that need no fix.
Reports allow 20,000 characters. If diagnostic dispositions cannot fit, the report marks coverage incomplete and identifies the omitted scope.
Oversized responses fail before the controller stores Candidates or queues the report.
Current repository defects become Candidates for Issue triage and Issue work.
Existing issues, pull request Repair, and Baseline repair retain work they already own.
Issue work reproduces findings and verifies repairs without weakening checks or hiding diagnostics.
Runner operations and GitHub settings appear in the report for their next actor.
The usual Review and merge policies apply. Other repositories enable `ci-review` through their own Routine spec.

## Weekly performance review

The `perf-review` Routine reads a repository's stored Measurements and files one issue per confirmed Regression.
It reads only. The numbers come from the repository's own CI, which measures each merged commit against its parent and stores the result as a git note.
A repository takes part only once it stores Measurements. `harlan-zw/gscdump` is the reference implementation.

A delta becomes a Regression only after it clears two bars.
First it must beat the noise that same measurement recorded, which is the head build compared against itself in the same job.
Then it must persist across three later Measurements.
Below ten usable Measurements for a Benchmark, the Routine judges nothing and says so.
So a repository that has only started storing Measurements reports its coverage and nothing else for several weeks, which is the correct answer rather than a fault.

The Routine also names at most one Opportunity per scan: a Benchmark that drifted while no single commit ever cleared its Threshold, one whose count keeps climbing, or the one that costs the most.
Drift is the valuable case, because the per-commit rule is blind to it by design. Twenty commits at under one percent each never trip a Threshold and still add up.
An Opportunity must come from the stored series. A hunch about the code is not evidence.

Issue work reproduces the delta and repairs its cause.
The pull request's own automated performance comment is the evidence.
It measures the change against its base and reports the result, so the agent never certifies its own work, and a pull request whose comment shows no improvement is closed rather than merged.
The controller refuses any change under `perf/` or `scripts/perf/`, because the cheapest way to remove a Regression is to weaken the Benchmark that found it.
The usual Review and merge policies apply. Other repositories enable `perf-review` through their own Routine spec.
Deploy the supporting service and Skill before enabling that schedule.

## Weekly SEO review

The `seo-review` Routine reads one Site's ranked actions from [NuxtSEO](https://nuxtseo.com) and files one issue per fix this repository owns.
It matches the repository to its Site through the production origin in tracked configuration, never by name.
The scan reads only. It never resolves, dismisses, scans, annotates, or starts live research, so it spends no Lighthouse or research limit.
The agent reads the `nuxtseo-cli` skill that ships inside the installed CLI, so the skill always matches the binary.

The turn needs `nuxtseo` on the service `PATH` and `NUXTSEO_TOKEN` in the repository `.env`.
Without either, the run reports a blocker and proposes nothing.
Actions that need an operational change or a person's decision stay in the report with their next actor.
Issue work repairs the cause and names the action IDs to resolve after deploy. It never resolves an action itself.
The usual Review and merge policies apply. Repositories enable `seo-review` through their own Routine spec.

## Adding a Routine

Built-in definitions live in `src/routines/`. Each definition owns its scan and downstream issue policy.

1. Add a module implementing `RoutineDefinition` from `src/routines/contract.ts`.
2. Reuse `candidateRoutine` and `candidateScanPrompt` for ordinary Candidate scans.
3. Define any custom response parser, preparation, scope limits, or Issue work restrictions in that module.
4. Add its import and name to the table in `src/routines/index.ts`.
5. Test its behavior through the definition and shared worker before adding a repository schedule.

`RoutineName` and accepted YAML names derive from that table. Keep runtime registration and YAML-supplied code disabled.
The scheduler and workers own leases, persistence, report publication, and retries.
Definitions cannot receive a publisher or worktree mutation client through their preparation interface.
Issue work checks a definition's changed-path policy before committing.

Agent feedback keeps its repository restriction and exact Skill target.
[Sentry](https://sentry.io) keeps its required report and mode-specific resolution instructions.
Dependency updates keep one combined Candidate and a shared open-issue fingerprint.
