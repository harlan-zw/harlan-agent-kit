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

Use drain before stopping the controller or transferring ownership.
Check `status` and `inspect` for unfinished work.
Stop `serve` with SIGTERM or Ctrl+C.
The controller closes its HTTP server, private socket, and durable state.

## Back up and restore

Create a backup while the controller owns the state:

```bash
octorun backup /srv/octorun-backups/state.sqlite
```

Keep backups outside the state directory's retention area.
Backups include accepted events, run identities, outputs, and GitHub publication identities.
Store credentials separately in your secret manager.

If you need to restore, stop the controller first:

```bash
octorun restore /srv/octorun-backups/state.sqlite
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
Active runs remain available for recovery.
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

If the binary rejects the database schema, use a compatible binary or restore a compatible backup.
Keep the current state copy before attempting recovery.
The controller does not silently discard incompatible state.
