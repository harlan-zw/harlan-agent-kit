# Operate Octorun

One controller owns each state directory.
The default directory is `$XDG_STATE_HOME/octorun`.
If `XDG_STATE_HOME` is unset, it uses `~/.local/state/octorun`.
A relative `stateDir` resolves beside the operator configuration file.

`serve` exposes signed webhook ingestion, liveness, and readiness over HTTP.
Operator commands use a private Unix socket in the state directory.
The socket has mode `600`, and its directory has mode `700`.
Run operator commands as the controller's filesystem owner.

## Inspect and control work

```bash
octorun status
octorun inspect
octorun inspect RUN_ID
octorun logs RUN_ID --limit 100
octorun cancel RUN_ID
```

Use the run ID returned by `run` or listed by `inspect`.
`cancel` records cancellation before signalling active task execution.
A cancelled run cannot dispatch new GitHub writes.
A GitHub request already in flight may still complete and requires reconciliation.

Pause and resume automatic admission for a repository:

```bash
octorun pause --repository your-org/your-repository
octorun resume --repository your-org/your-repository
```

Use `--pr 7` to pause one pull request.
Use `--target TARGET_KEY` for another target reported by inspection.
A target pause holds automatic work that has not started.
It does not cancel an active run.
Use `cancel` when you need to stop a specific active run.

```bash
octorun drain
```

Drain pauses new task admission across the controller.
Active attempts finish, while queued tasks and later tasks remain held.
Use it before stopping the controller or transferring ownership.
Check `status` and `inspect` for unfinished work.
Stop `serve` with SIGTERM or Ctrl+C.
The controller closes its HTTP server, private socket, and durable state.
The admission pause survives restart.

To resume queued work after drain, run:

```bash
octorun resume
```

Without `--repository`, `pause` and `resume` control admission across the controller.
Repository and target pauses remain separate.
If a repository still has a pause, resume that scope too.

## Back up and restore

Create a backup while the controller owns the state:

```bash
mkdir -p "$HOME/octorun-backups"
octorun backup "$HOME/octorun-backups/state.sqlite"
```

Keep backups outside the state directory's retention area.
Backups include accepted events, run identities, outputs, and GitHub publication identities.
Store credentials separately in your secret manager.

If you need to restore, stop the controller first:

```bash
octorun restore "$HOME/octorun-backups/state.sqlite"
octorun serve
```

Restore refuses a running controller.
It checks the backup schema before replacing state.
Do not run two controllers against the same repository and workflow during an ownership transfer.
See the [cutover design](../ideas/extraction.md#cutover) for legacy service migration constraints.

## Retain completed evidence

```bash
octorun prune --before 2026-01-01T00:00:00Z
```

The command removes eligible completed evidence older than the supplied timestamp.
It scrubs embedded event data, task outputs, and confirmed GitHub comment, review, and check text.
It keeps run identities, usage, configuration, and GitHub result identities.
Active runs remain available for recovery.
Expired review context is unavailable for later finding conversations.
Choose a retention interval that supports your audit and recovery needs.

## Diagnose a hold or failure

`inspect` shows the run state and each task's state.
A waiting task records its reason and wake time.
Admission holds do not consume execution attempts.
A configuration or authorization failure needs an operator change.
Transient failures retry within the configured task and workflow limits.

If App permissions changed, run `doctor --online`.
If credentials expired or were rotated, update the referenced environment values and restart the controller.
If a provider rejects a model or endpoint, check `provider.model` and `provider.baseUrl`.
Use `--json` with any command to collect machine-readable output.
Error output excludes credential values.

Accepted tasks pin the provider, endpoint, model, timeout, input limit, and response limit.
Before changing these settings, drain the controller and inspect unfinished runs.
Finish or cancel waiting work before changing the configuration.
API key rotation does not change this pin.

After a restart, incompatible pending tasks fail with a configuration error.
If inspection reports an unavailable task implementation, check for changed provider settings or a changed package version.
Choose the required settings and restart the controller.
If you drained admission, run `octorun resume` before submitting a new manual run.
A failed run keeps its original result.
Do not reuse its manual request ID for the new run.

```bash
octorun run --repository your-org/your-repository --pr 7
```

The command creates a new request ID when you omit `--request-id`.
For scripts, `run` exits with code 1 for Failed, Cancelled, or Superseded results.
Waiting work exits with code 0 because the controller accepted it.
Read the output state before treating acceptance as completion.

Before a paid request, Octorun records a conservative token reservation in SQLite.
Confirmed provider usage replaces that reservation.
A timeout or crash can leave the provider's actual usage unknown.
That reservation remains charged against the run's budget after restart.
Inspect the run's usage and the provider's request history before authorizing another attempt.
If the remaining budget cannot cover another request, submit a new manual run only when you authorize a separate budget.
The previous run remains part of your usage history.

If the binary rejects the database schema, use a compatible binary or restore a compatible backup.
Keep the current state copy before attempting recovery.
The controller does not silently discard incompatible state.
