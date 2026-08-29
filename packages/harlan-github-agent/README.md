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

Save the dashboard password in `dashboard-password` beside the config file. Use at least 32 bytes and restrict the file to mode `600`.

Configure your normal global Git profile before starting. The controller uses its identity and commit-signing settings for every commit it creates.

Install the configured GitHub App only on selected repositories. `github.allowed_owners` is the first remote boundary. The service ignores public installations from every other GitHub owner. It then matches allowed repositories to trusted checkouts under `~/pkg` and `~/sites`. Optional repository entries override default policy.

Every tracked pull request authored by `harlan-zw` enters review without approval. An outside contributor receives one automated instruction comment. Adding `harlan-agent-review` approves only the named head commit. The service removes the label after saving the approval.

Every tracked pull request is reviewed. The `harlan-agent-auto-merge` label decides who merges the result. With the label, the service merges the pull request itself after a `READY` review at or above `auto_merge.minimum_confidence`. Without it, the pull request waits for Harlan. The agent that opens a pull request adds the label only when the change carries no judgement, for example a dependency bump. Auto merge stays off until `auto_merge.enabled` is true, and it covers owned repositories and trusted authors only.

No new issue work starts above `max_open_pull_requests` open pull requests. Review, repair, and conflict fixes continue, because they shorten that queue.

Owned repositories selected in the GitHub App enable Issue triage by default. A maintained repository needs an explicit mapping with `issue_work: true`. Without an installation, the controller uses Harlan's authenticated GitHub account. Harlan's valid issues continue into Issue work automatically. An outside contributor's valid issue waits for `harlan-agent-review` or `Approve`. The service removes the label before saving Approval for that exact issue state.

The triage agent resumes its own session, selects the matching installed skills, implements the change, and runs focused checks. The agent chooses the commit message and pull request metadata. The controller commits and pushes the verified result before it opens one pull request ready for review. Conflict fixes also run by default on owned repositories. They remain disabled on maintained repositories.

Review stays read only. Repair starts fresh with every structured finding. It writes each failing regression test before its fix.

Review decides the pull request premise once. A sound premise permits Repair. A wrong premise recommends Dismissal and never starts Repair.

GitHub status, comments, and labels hold durable workflow truth. The local journal coordinates leases, Agent sessions, Recovery, and Review usage.

Every published Repair head SHA gets a fresh Review. A repeated finding stops with Action required.

If Repair stops, the canonical review comment changes to `BLOCKED`. It lists every finding and next action.

History stores each completed Review duration and Agent provider token usage. Older runs show usage as unavailable.

If default branch CI already fails, Repair leaves the reviewed pull request unchanged. One Baseline repair Agent fixes that exact default branch commit in a separate pull request.

Each Worker runs like a normal local agent session inside its own Git worktree. The controller creates each worktree from its mapped checkout with `wt`, so the global Worktrunk path template applies. Workers inherit the global agent context, installed skills, environment, provider login, and authenticated `gh` client. They may read past GitHub issues and pull requests. The controller still owns comments and pushes.

Switching the Agent provider starts new sessions. A saved session belongs to the provider that created it, so no Worker resumes a session from the other provider.

`agent.provider` names the Agent provider the service starts with. A switch from the dashboard or the tray overrides it and survives a restart.

`external_repositories` watches exact issue numbers or all current issues in a public repository. These watches use public GitHub data. They receive no GitHub App token and never add work to the queue.

Grant read access to metadata, contents, issues, checks, commit statuses, and administration. Grant write access to Actions, contents, deployments, issues, and pull requests. The service mints and reuses short-lived, repository-scoped tokens.

A conflict fix also requires an owned repository, an allowed pull request author, an allowed branch prefix, and an unprotected head branch. The service pushes the checked commit from a clean bare Git repository.

Register the dashboard with `./bin/install-portless-alias`.

Open `https://harlan-github-agent.localhost/`. Use `agent` as the dashboard username.

## Webhooks

Set `webhook.enabled` to start a second listener on its own port. It carries one route, `POST /webhook`, and nothing else. Keep the dashboard port on loopback: it can pause agents, approve pull requests, cancel tasks, and eject sessions, so it must never be exposed.

Point a tunnel at the webhook port alone, then set that URL and a shared secret on the GitHub App. Write the same secret to `webhook.secret_path` with mode `0600` and at least 32 characters.

A delivery is a hint, never a payload. It says "read this repository again", and the service answers by running the reconciliation pass it already runs on a timer. The delivery body is never stored and never trusted beyond the repository name, so a missed, duplicated, or forged delivery cannot move the journal anywhere a poll would not.

Deliveries within three seconds of each other cost one pass, so a busy repository cannot spend the rate limit this feature exists to save.

Keep polling on. It is the safety net for a delivery GitHub never sent.

Select `Automatic` in the Agent provider control to pick the provider by remaining capacity. It walks `agent.order` and takes the first provider whose window has more than its `agent.reserve_percent` left.

Codex publishes a seven-day window, read from `codex app-server`. opencode publishes the GLM Coding Plan windows, read from `https://api.z.ai/api/monitor/usage/quota/limit` with the key in `~/.config/opencode/opencode.json`. The plan publishes a five-hour window and a weekly one, and the fuller of the two decides, because a spent five-hour window stalls the fleet for hours whatever the week has left.

A provider that publishes no limit always passes. When no provider may spend, the service stops claiming new Agent Tasks. The System pane shows `Reserve reached`. Active agents and Publications finish.

Use the Agent provider control in the header to switch the Agent provider, model, or reasoning effort. A switch starts the next agent turn. An agent already running keeps the model it started with. Switching the provider returns the model and the reasoning effort to that provider's defaults.

Select `Restart after current work` to restart the service. The Restart request stops new Task claims and lets active Agents finish.
The service owns the request after acceptance. Manual Pause stays unchanged.

Read one pull request's local review history from:

```text
/api/reviews?repository=OWNER%2FREPOSITORY&pull_request=NUMBER
```

Use the `Auto` and `Manual` control in the header to set the Selection mode. `Auto` reviews every eligible pull request. `Manual` waits for you to select each one, whoever opened it. Select a pull request with `Review and repair` in the dashboard, or with the `harlan-agent-review` label on GitHub. The Selection mode persists across restarts, and covers pull requests only.

The dashboard shows `Review and repair` for outside contributors, and for every pull request in `Manual`. One Approval covers read only Review and separate scoped Repair for that head commit.
Use `Eject` on a running agent to stop automation and resume its session in Ghostty. Codex sessions reopen with `codex resume`. opencode sessions reopen with `opencode --session`.
Use `Watch logs` from the System pane to open a read-only live event stream while automation continues.
The System pane stays visible. It shows Agent provider limits, Reserves, and unresolved Incidents.
It separates Harlan GitHub Agent from GitHub Actions. A runner failure never changes the Agent status.
`max_open_pull_requests` stops new issue work while that many pull requests are open. `Manual` Selection mode ignores the limit, because you already select every pull request.

Use `Dismiss` on a board card to never act on that pull request or issue again. A new commit does not undo it. Dismissing cancels the item's running and queued tasks. Restore it from `Dismissed` on the Watching page.

Use `Cancel` to stop an active or queued task. The task stays cancelled for that pull request commit. Closing the pull request uses the same path.

Enable `mutations_enabled` only after the selected repository policy and GitHub App permissions are correct.
