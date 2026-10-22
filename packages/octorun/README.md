# Octorun for Harlan Agent Kit

Run [Octorun](https://github.com/harlan-zw/octorun) workflows for this repository.
This private package imports the standalone runtime at an exact Git commit.
It adds the existing GitHub App mapping and a Claude subscription provider.

Automatic pull request events select the change summary workflow.
The existing Service owns automatic Review, Repair, conflict resolution, and releases.
Use `@octorun review` for an explicit Octorun adversarial review.
Questions inside Octorun findings stay in their threads.

## Run

Use Linux, [Node.js](https://nodejs.org) 24 or newer, and the repository's pinned [pnpm](https://pnpm.io) version.
Install Claude Code and sign in with `claude auth login`.
The default model is `claude-opus-5-5`.

Keep an eligible Harlan Agent Kit mapping in the existing Service configuration.
The host reads its App ID, private key path, allowed owner, repository mapping, and database path.
It discovers repository and installation IDs through the App.
It stores no copied key or provider credential in its configuration.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm octorun doctor
pnpm octorun plan --pr 7
pnpm octorun run --pr 7 --request-id first-summary-7
```

`doctor` checks App access and workflow configuration without generating text.
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
Keep `serve` running through your process manager for continuous processing.

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
