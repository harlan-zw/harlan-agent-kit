# Events and recovery

Persist an event before acknowledging it.
Recover workflow runs through durable state and fenced task leases.

The current webhook implementation intentionally uses events as reconciliation hints.
That works for current-state review decisions.
Arbitrary workflows also need event identity and selected event data.
See [source evidence](source-audit.md).

## Ingestion contract

For webhooks, verify the signature over the raw request body.
Bound request size, validate event type and action, and verify the installed repository.
Persist the authenticated envelope and bounded, schema-checked event data in one transaction.
Deduplicate by [GitHub](https://github.com) host, App identity, and delivery ID.
Return success only after durable storage succeeds.
Process workflows asynchronously.

GitHub asks receivers to respond within ten seconds.
It does not automatically redeliver failed deliveries.
Provide delivery recovery alongside state reconciliation.
Sources: [webhook practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks), [failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries).

Retain only fields required by supported selectors and task inputs.
Encrypt retained private payloads when the deployment requires it.
Expose retention and deletion settings. Never store credentials in payloads or logs.
Keep rejected event diagnostics without retaining unauthorized repository content.

## Polling contract

Polling and webhook processing share normalization and workflow selection.
Polling creates observations of current state and newly discovered durable GitHub objects.
It cannot reproduce every intermediate label, edit, or deleted comment.
Declare which workflow selectors support polling.
Reject or explain an unsupported selector when configuring poll-only operation.

Use an initial baseline that avoids reviewing every historical pull request without consent.
Offer explicit backfill selection for existing open pull requests.
Persist pagination progress, high-water marks, and stable GitHub object IDs.
Use overlap windows and deduplication to cover timestamp ties and interrupted pages.
Advance a cursor only when its observations commit.
Use conditional requests and rate-limit reset evidence.

Comment commands require their own ingestion path and cursor.
Do not infer command delivery from the latest repository comments alone.
Use webhook delivery recovery for exact events when GitHub retains them.
Explain remaining history gaps to the operator.

## Execution identity

Separate delivery deduplication from workflow-run deduplication.
Two deliveries can describe the same repository revision.
Two intentional re-runs on that revision must remain distinct.

Use a semantic run key for automatic triggers: repository, workflow ID, revision, and trigger generation.
Include the definition digest and selector identity in that key.
Revision-triggered workflows may coalesce by head SHA.
Label, comment, and action triggers preserve occurrence identity when the head stays unchanged.
Commands share identity across transports: comment ID, source version, and operation.
Use the comment's updated timestamp and body digest as its source version.
Store the accepted target snapshot separately. A new head must not replay an old command.
Give manual requests a caller-supplied or generated request ID.
Record the originating delivery or observation on each selected run.
Reject request-ID reuse with different inputs.

Use stable repository IDs. Names can change after a transfer or rename.
Scope every query and capability to the installation and repository.

## Concurrency and cancellation

Default review concurrency groups to repository, pull request, and workflow.
A newer head supersedes unfinished automatic reviews in that group.
Independent workflows keep their own groups.
Make queue, replace, and reject behavior explicit in configuration.
Serialize conflicting mutations across workflows that share one pull request.
Apply fair admission across repositories and bound concurrent model spending.
Record causal run IDs on generated commits and publications.
Use that lineage to prevent feedback loops while allowing other workflows to react.

Persist cancellation before signalling an agent provider.
Revoke publication authority immediately.
Confirm process termination before reusing its worktree or capacity.
Block new write dispatches after durable cancellation.
An already dispatched GitHub request may still succeed. Reconcile and record that result without unauthorized retries.
Prevent stale workers from committing results with a lease fence and run generation.
Before publishing review results, recheck the open pull request and current head.
Other workflows check their target's own publication preconditions, including closed or merged targets when configured.
Every publication rechecks cancellation and intersects pinned authority with current operator and installation policy.
App removal or repository access loss revokes pending effects and invalidates cached tokens.

A pull request pause holds automatic runs that have not started. An active run continues.
An operator admission pause blocks new task attempts, including later tasks in active runs.
Already running attempts continue unless explicitly cancelled.
A stop cancels a named run or task scope.
An edited or deleted command cannot silently undo an accepted action.
Record the authorized command snapshot and its result.

## Retry and waiting states

Use distinct states for runnable, waiting, running, succeeded, failed, cancelled, skipped, and superseded work.
Waiting records its reason and wake condition.
Do not hold an agent slot while waiting for CI, quota, approval, or provider capacity.
Do not consume execution attempts for admission holds.

Classify configuration and authorization failures as actionable terminal results.
Retry transient transport failures within an attempt, elapsed-time, and cost budget.
Use provider retry timing when available. Add bounded jitter for shared outages.
Keep task failures separate from provider health failures.
A task's invalid model configuration must not open a service-wide provider circuit.

Record usage even when cancellation or failure interrupts a task.
Unknown cost remains unknown. A token estimate cannot prove a currency budget.
Enforce token and duration limits when a provider lacks reliable cost data.

## Publication

Store the desired GitHub mutation before attempting it.
Bind it to workflow run, task, typed target snapshot, run generation, and output identity.
Keep one publication owner for each summary or check run.
Represent native review comments with stable finding fingerprints and anchor metadata.

Remote writes and local commits cannot form one atomic transaction.
If a timeout leaves the result unknown, read GitHub before repeating the write.
Match recorded remote IDs, App identity, and hidden markers.
Never promise exactly-once external effects.
Target duplicate-resistant effects through idempotency and reconciliation.

## Restart and upgrade

On startup, recover expired leases and unknown publication results.
Hold an exclusive controller lock before startup recovery.
A second controller must refuse the same state directory.
Continue from durable outputs. Do not repeat completed effects merely because a process restarted.
Keep stopped and superseded work stopped.
Run database migrations under an exclusive lock after a verified backup.
Reject incompatible task implementations until a compatible version or explicit migration exists.

Test crashes before acknowledgement, after admission, during a task, and after a remote write.
Assert that recovery produces one intended visible effect and preserves the original run identity.
