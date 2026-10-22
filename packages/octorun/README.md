# Octorun for Harlan Agent Kit

Run [Octorun](https://github.com/harlan-zw/octorun) workflows for this repository.
This private package imports the standalone runtime at an exact Git commit.
It adds the existing GitHub App mapping and a Claude subscription provider.

Automatic pull request events select the change summary workflow.
Automatic summaries require an author listed in the Service mapping's `writable_pr_authors`.
Fork pull requests use the same author rule.
The existing Service owns automatic Review, Repair, conflict resolution, and releases.
Use `@octorun review` for an explicit Octorun adversarial review.
Questions inside Octorun findings stay in their threads.
For outside contributors, a repository writer must request an Octorun workflow explicitly.
The existing Service keeps its own Approval path for Review and Repair.

## Run

Use Linux, [Node.js](https://nodejs.org) 24 or newer, and the repository's pinned [pnpm](https://pnpm.io) version.
Install Claude Code and sign in with `claude auth login`.
The default model is `claude-opus-5-5`.

Keep an eligible Harlan Agent Kit mapping in the existing Service configuration.
The host reads its App ID, private key path, allowed owner, repository mapping, and database path.
It discovers repository and installation IDs through the App.
It stores no copied key or provider credential in its configuration.
Configuration and App key files must be owned, private regular files without a final symlink.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm octorun doctor
pnpm octorun plan --pr 7
pnpm octorun run --pr 7 --request-id first-summary-7
```

`doctor` checks App access, workflow configuration, Claude installation, and Claude login without a model turn.
`plan` shows the selected workflow, pinned commits, capabilities, and limits.
`run` processes one pull request and reports its final state or retry hold.
Repeat the same request ID to recover that request without starting another run.

Start continuous processing with:

```bash
pnpm octorun serve
```

The controller polls every minute and exposes a private local control socket.
It requires no public HTTP listener or webhook routing change.
Its first poll records existing pull requests without starting workflows for them.
To process existing pull requests explicitly, run `pnpm octorun poll --backfill existing`.
Use the managed user service for continuous processing.

## Install the user service

Use a Linux host with a systemd user manager and Node.js 24 or newer.
Sign in to Claude on that host before installing.
Keep the Service configuration and App key readable only by your user.
Enable user lingering if the controller must run after logout or reboot.

From a prepared checkout of the merged default branch:

```bash
pnpm install --frozen-lockfile
pnpm octorun:service install origin/main
pnpm octorun:service status
```

The installer accepts only revisions already merged into `origin/main`.
It archives the selected revision into its own private release directory.
It installs frozen dependencies in a separate store and builds the compiled consumer.
It checks App access and Claude login with temporary state before draining the serving controller.
It then enables `harlan-octorun.service` and waits for its private control socket.
The existing Service keeps its own process and database.

If a worktree installed dependencies with scripts disabled, prepare a fresh checkout before running these commands.
Use a separate store for that checkout:

```bash
pnpm install --frozen-lockfile --store-dir "$HOME/.local/share/harlan-octorun-bootstrap-store"
```

The unit pins absolute release and Node paths.
Its explicit `HOME` and `PATH` include `~/.local/bin` for Claude.
It uses private files and restarts after failure.
Its recovery step restores saved admission state once after an interrupted transition.

Use these commands for managed changes:

```bash
pnpm octorun:service update origin/main
pnpm octorun:service restart
pnpm octorun:service stop
journalctl --user -u harlan-octorun.service
```

Updates and restarts drain running work before stopping the controller.
They preserve an existing manual pause.
If startup fails, the manager restores the previous release and admission state.
Prepared releases remain available for inspection and rollback.
Use `pnpm octorun:service update MERGED_COMMIT` to select a previous compatible release.
Back up state before an upgrade that changes its database schema.

| Managed path | Default |
| --- | --- |
| `HARLAN_OCTORUN_HOME` | `~/.local/share/harlan-octorun`, under `XDG_DATA_HOME` when set |
| Release archives and dependencies | `$HARLAN_OCTORUN_HOME/releases` and `$HARLAN_OCTORUN_HOME/store` |
| Selected release | `$HARLAN_OCTORUN_HOME/current` |
| User unit | `~/.config/systemd/user/harlan-octorun.service`, under `XDG_CONFIG_HOME` when set |

Keep the managed root outside checkouts, Octorun state, and the existing Service database directory.
Use an owned state directory without a directory symlink.
Keep the same managed root after installation.
Set `HARLAN_OCTORUN_CONFIG` to select an absolute configuration path for the managed service.

## Operate

Other terminals send commands to the running controller through its private socket:

```bash
pnpm octorun status
pnpm octorun logs
pnpm octorun pause
pnpm octorun resume
pnpm octorun backup /absolute/path/octorun-backup.sqlite
```

Use `pnpm octorun inspect RUN_ID` for a specific run.
Use `pnpm octorun cancel RUN_ID` to cancel it.
`pnpm octorun drain` pauses admission and waits for running work.
Use `resume` to admit work again.
The upstream [operations guide](https://github.com/harlan-zw/octorun/blob/main/docs/guides/operations.md) explains durable state and recovery.

## Configure

| Setting | Default |
| --- | --- |
| `--config PATH` | `~/.config/harlan-github-agent/config.yml`, under `XDG_CONFIG_HOME` when set |
| `OCTORUN_KIT_STATE_DIR` | `~/.local/state/octorun-kit`, under `XDG_STATE_HOME` when set |
| `OCTORUN_KIT_MODEL` | `claude-opus-5-5` |

Use a dedicated state directory outside the Service database directory and repository checkout.
The host resolves symlinks before opening Octorun state.
Each state directory has one controller owner.
Changing the model requires finishing or cancelling runs pinned to the previous provider.

This consumer serves only `harlan-zw/harlan-agent-kit`.
Its Service mapping must remain enabled, owned, and authenticated through the configured App.
The allow-list accepts the whole owner or this exact repository.
It grants no access to other repositories or organizations.
Octorun rechecks this authority before paid work and result publication.
It also rechecks current contributor trust and the exact pull request revision for automatic work.
If the App identity or mapped paths change, restart Octorun after checking the new configuration.

## Provider boundary

The Claude adapter starts one bounded text turn with repository text supplied as data.
It disables tools, MCP servers, user customizations, repository instructions, session persistence, and automatic retries.
Managed Claude policy still applies.
It uses a private temporary directory and removes each prompt after the turn.
It records input, cached input, output, and reported cost.
Octorun reserves a separate allowance for CLI prompt framing before invoking the provider.

The adapter uses the existing subscription login.
It requires no OpenAI-compatible API key.
See the official [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) for these controls.

## Dependency updates

The catalog pins Octorun to an immutable standalone commit.
The `allowBuilds` entry approves only that Git artifact's packaging step.
When updating the pin, update its exact build approval and regenerate the lockfile.
Run the consumer checks before publishing the change:

```bash
pnpm --filter harlan-octorun typecheck
pnpm --filter harlan-octorun test:run
pnpm --filter harlan-octorun build
```
