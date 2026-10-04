# Pull request watching

Use the existing Service as the observer. Keep one submitting Agent responsible for the target.
The CLI streams stored state over an authenticated connection. It does not poll GitHub.
Webhooks trigger the Service's existing repository reconciliation. Recovery polling covers missed deliveries.

## Connect

Use the Service's configuration file and dashboard credentials.
Never print the password. The CLI reads its password file.
On the Service host, use the loopback URL:

```bash
harlan-github-agent control watch-pr \
  --repository OWNER/REPOSITORY --number NUMBER \
  --config /home/harlan/.config/harlan-github-agent/config.yml \
  --url http://127.0.0.1:3210
```

From another host, use the configured Service URL.
Keep the authenticated watch route behind dashboard protection.
It does not use the public webhook route.

If the host lacks the executable, run the repository's CLI from the Harlan Agent Kit checkout:

```bash
pnpm --filter harlan-github-agent dev control watch-pr \
  --repository OWNER/REPOSITORY --number NUMBER \
  --config /home/harlan/.config/harlan-github-agent/config.yml \
  --url http://127.0.0.1:3210
```

The command writes changed states to stderr and one terminal JSON result to stdout.
It follows the pull request through later pushes and repairs. Read the returned head before acting.
The result includes current-head Tasks and the merge commit when GitHub supplies it.
A saved closure needs an exact GitHub confirmation before the command returns `Merged` or `Closed`.

## Wait for Review

For repeated Review waiting, add `--until review`:

```bash
harlan-github-agent control watch-pr \
  --repository OWNER/REPOSITORY --number NUMBER \
  --until review --timeout-seconds 1200 \
  --config /home/harlan/.config/harlan-github-agent/config.yml \
  --url http://127.0.0.1:3210
```

`Ready` requires current Revision evidence and a published Service Review outcome.
A skipped Review does not satisfy this mode.
After readiness, read terminal findings and complete the PR Skill's remaining checks once.
If the Review wait reaches its limit, apply [Review queue capacity](review-queue.md).
Never treat a timeout or connection error as an empty Queue or successful Review.

## Wait for merge

The default stops at merge, closure, Dismissal, or actionable work without an active Service Task.
It keeps waiting while Service Review, Repair, or Publication owns the work.
`--until merged` waits through actionable findings. Use it only when Harlan wants that wait.
`--timeout-seconds` bounds the wait when required. Otherwise it has no time limit.

Run the command in the foreground and await its tool result.
While it runs, keep the original Agent turn active. Resume yielded shell sessions using the shell tool.
This watch cannot wake a chat whose turn already ended.

On `Merged`, use Take Ownership Completion for the returned pull request and merge commit.
Confirm applicable delivery stages before cleanup. Propose additional work without starting it.
On `ActionRequired`, inspect the returned reason and Tasks. Follow the existing repair authority.
On `Closed` or `Dismissed`, report the outcome. Do not delete unintegrated work.

## Recover

If the Service restarts or the connection fails, run the same command again.
The initial event reads the Journal, so a merge during disconnection still returns immediately.
A pull request absent from the Journal receives one bootstrap reconciliation.
A pull request already closed before observation receives one exact GitHub read.
Established watches read only local state. More watchers do not create more GitHub observers.

If the command is unavailable, report the Service version or connection error.
Use the repository's existing Review process. Do not replace the watch with repeated `gh pr view` calls.
After the Service becomes available, resume the same target.
