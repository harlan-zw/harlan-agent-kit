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
- review and repair in one agent turn, with agent-owned commit messages
- separate Baseline repair pull requests when default branch CI fails
- fixed cutoff date for old issues
- bounded GitHub polling with retry backoff
- authenticated [H3](https://h3.dev) and [srvx](https://srvx.h3.dev) dashboard
- safe merge conflict commits and pushes
- two agent providers: [Codex](https://developers.openai.com/codex/sdk/) and [opencode](https://opencode.ai). Set `agent.provider` to `codex` or `opencode`
- role-specific Codex profiles: `gpt-5.6-sol` with high reasoning for adversarial review, and `gpt-5.6-terra` with medium reasoning for other work
- the opencode profile runs `opencode-go/deepseek-v4-flash` at the high reasoning effort for every role
- switch the Agent provider, model, and reasoning effort from the dashboard or the tray, with no restart
- one global limit of three active agents across reviews, issue work, and pull request fixes
- durable dashboard cancellation for active and queued tasks
- read-only public issue watches outside the GitHub App installation
- conflict fixes push only when the pull request head commit still matches
- repair commits push only when the approved head commit still matches

Still to build: Claude reviews, PR conformance, deployment ownership, and webhooks.

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

Owned repositories selected in the GitHub App enable Issue triage by default. Harlan's valid issues continue into Issue work automatically. An outside contributor's valid issue waits for `harlan-agent-review` or `Approve`. The service removes the label before saving Approval for that exact issue state.

The triage agent resumes its own session, selects the matching installed skills, implements the change, and runs focused checks. The agent chooses the commit message and pull request metadata. The controller commits and pushes the verified result before it opens one pull request ready for review. Conflict fixes also run by default on owned repositories. They remain disabled on maintained repositories.

The review agent repairs its findings before its turn ends. If default branch CI already fails, it leaves the reviewed pull request unchanged. One Baseline repair agent fixes that exact default branch commit in a separate pull request.

Each Worker runs like a normal local agent session inside its own Git worktree. The controller creates each worktree from its mapped checkout with `wt`, so the global Worktrunk path template applies. Workers inherit the global agent context, installed skills, environment, provider login, and authenticated `gh` client. They may read past GitHub issues and pull requests. The controller still owns comments and pushes.

Switching the Agent provider starts new sessions. A saved session belongs to the provider that created it, so no Worker resumes a session from the other provider.

`agent.provider` names the Agent provider the service starts with. A switch from the dashboard or the tray overrides it and survives a restart.

`external_repositories` watches exact issue numbers or all current issues in a public repository. These watches use public GitHub data. They receive no GitHub App token and never add work to the queue.

Grant read access to metadata, contents, issues, checks, commit statuses, and administration. Grant write access to Actions, contents, deployments, issues, and pull requests. The service mints and reuses short-lived, repository-scoped tokens.

A conflict fix also requires an owned repository, an allowed pull request author, an allowed branch prefix, and an unprotected head branch. The service pushes the checked commit from a clean bare Git repository.

Open `http://harlan-github-agent.local/`. Use `agent` as the dashboard username.

Use the Agent provider control in the header to switch the Agent provider, model, or reasoning effort. A switch starts the next agent turn. An agent already running keeps the model it started with. Switching the provider returns the model and the reasoning effort to that provider's defaults.

Select `Pause` before restarting the service. Poll `/api/state` until `agentControl.safeToRestart` is `true`.
Pause persists across restarts. Select `Resume` after the service returns.

Read one pull request's local review history from:

```text
/api/reviews?repository=OWNER%2FREPOSITORY&pull_request=NUMBER
```

Use the `Auto` and `Manual` control in the header to set the Selection mode. `Auto` reviews every eligible pull request. `Manual` waits for you to select each one, whoever opened it. Select a pull request with `Review and repair` in the dashboard, or with the `harlan-agent-review` label on GitHub. The Selection mode persists across restarts, and covers pull requests only.

The dashboard shows `Review and repair` for outside contributors, and for every pull request in `Manual`. One Approval covers review and verified repairs for that head commit.
Use `Eject` on a running agent to stop automation and resume its session in Ghostty. Codex sessions reopen with `codex resume`. opencode sessions reopen with `opencode --session`.
Use `Watch logs` from the system pane to open a read-only live event stream while automation continues.
The system pane shows the `Weekly Codex limit` first, including the remaining percentage and reset countdown.
`max_open_pull_requests` stops new issue work while that many pull requests are open. `Manual` Selection mode ignores the limit, because you already select every pull request.

Use `Dismiss` on a board card to never act on that pull request or issue again. A new commit does not undo it. Dismissing cancels the item's running and queued tasks. Restore it from `Dismissed` on the Watching page.

Use `Cancel` to stop an active or queued task. The task stays cancelled for that pull request commit. Closing the pull request uses the same path.

Enable `mutations_enabled` only after the selected repository policy and GitHub App permissions are correct.
