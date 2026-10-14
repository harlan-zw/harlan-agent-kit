# Local Agent terminals

Run Codex, Claude Code, and opencode through their native terminals in the Dashboard.
The browser shows Projects, Agent session tabs, two terminals, and read-only file diffs.
Closing a tab or browser keeps its Agent session running.

## Prepare the host

Use a Linux host with [Node.js](https://nodejs.org) 24 or newer and the repository's configured [pnpm](https://pnpm.io) version.
Install Git, Worktrunk (`wt`), Bash, `flock`, Bubblewrap (`bwrap`), and a working systemd user manager.
Native `node-pty` compilation requires Python and a C++ build toolchain.
Keep the same Node.js version for installation, building, and running.

Install the shared host capacity command at `/usr/local/bin/wolfstar-host-capacity` through the host's capacity setup.
Use the root broker from [runner pull request 18](https://github.com/wolfstar-project/hogwild-gh-runner/pull/18).
Set its root configuration's `maintenanceReserve` to `1` for GitHub Agent compatibility.
Set `maintenanceMemoryGiB` to the memory required by one maintenance Agent.
Install it on each participating host before rolling out the GitHub Agent Service update.
The Service requires an exact slot policy acknowledgement before startup.
If the broker refuses that policy, the Service stops startup.
Its `status` command must return a JSON result tagged `Status`.
It must coordinate every participating account, including maintenance Agents and GitHub Actions.
Use the same host authority on Hogwild. Do not create a separate terminal capacity directory.
Unavailable capacity prevents new Agent sessions.

Install each Agent provider and authenticate through its normal CLI on this host.
The terminal uses these existing credentials. It does not copy browser credentials or provide another login flow.
Provider spending limits remain external. A terminal connection does not increase them.

Use a task-owned repository Worktree for the application build.
Run these commands from its root:

```bash
pnpm install --frozen-lockfile
pnpm --filter wolfstar-github-agent build
pnpm --filter wolfstar-github-agent exec node -e "import('node-pty').then(() => console.log('node-pty loaded'))"
systemctl --user show-environment
wt --version
/usr/local/bin/wolfstar-host-capacity status
```

The build verifies the checked Ghostty artifacts. Ordinary installation does not require Zig or [GitHub](https://github.com) source downloads.
Explicit Ghostty source regeneration uses the pinned toolchain and source checksums in `packages/ghostty-terminal-bindings`.
The Dashboard build generates `packages/wolfstar-github-agent/dashboard/.output/public`.
It includes Hubot Sans and JetBrains Mono through Nuxt Fonts. Preserve the whole generated directory.

## Configure and start

Save this JSON outside the repository. Replace every `/absolute/...` path with its actual host path.
Find provider paths with `command -v codex`, `command -v claude`, and `command -v opencode`.
Use existing Project control checkouts with an `origin/main` branch.

```json
{
  "directory": "/absolute/private/terminal-state",
  "origin": "http://localhost:43177",
  "hostLabel": "Desktop",
  "projects": [
    {
      "id": "wolfstar-agent-kit",
      "name": "Wolfstar Agent Kit",
      "path": "/absolute/control-checkout/wolfstar-agent-kit"
    }
  ],
  "providers": {
    "codex": { "executable": "/absolute/bin/codex", "argv": [] },
    "claude": { "executable": "/absolute/bin/claude", "argv": [] },
    "opencode": { "executable": "/absolute/bin/opencode", "argv": [] }
  },
  "helperSource": "/absolute/app-worktree/packages/wolfstar-github-agent/dist/terminal-helper.mjs",
  "admissionCli": "/usr/local/bin/wolfstar-host-capacity",
  "claimScript": "/absolute/app-worktree/wolfstar-agent-kit/scripts/worktree-claim.sh",
  "staticDirectory": "/absolute/app-worktree/packages/wolfstar-github-agent/dashboard/.output/public",
  "memoryGiB": 4
}
```

Configure all three provider entries. A missing provider executable appears unavailable in the Dashboard.
Project IDs must be unique. Project paths and file paths must be absolute.
`memoryGiB` sets each helper's systemd memory limit, from 1 through 64 GiB.
`directory` stores authentication, Agent session records, and the helpers' pinned artifacts.
Keep it private and outside repositories. Do not share it between hosts.
`protectedPaths` optionally lists additional absolute paths that Agents must not access.
The origin must use `http://localhost` with an explicit port. The listener binds only to `127.0.0.1`.
Numeric loopback links redirect to the canonical localhost address before sign-in.

Restrict the configuration, then start from the application Worktree root:

```bash
chmod 600 /absolute/private/terminal.json
node packages/wolfstar-github-agent/dist/terminal-cli.mjs --help
node packages/wolfstar-github-agent/dist/terminal-cli.mjs /absolute/private/terminal.json
```

The command prints a pairing link. Open that exact link in the browser on this host.
The link expires after five minutes and works once. Restart the command to obtain another link.
Keep pairing links private. Pairing grants access to this host's terminals.
The browser saves local authentication and removes the pairing code from its address.
Select `Manage Passkeys`, then `Add Passkey`, after opening the pairing link.
Use `Sign in with Passkey` on later visits. Each Passkey belongs to this address.
If you lose a Passkey, use a new pairing link. Removing a Passkey revokes its signed-in sessions.
Signing out closes authenticated terminal streams. The Agent session keeps running.
The CLI starts from a configuration filename. It provides no install or uninstall subcommands.

Each new Agent session creates a `terminal/<session-id>` Worktree through `wt`.
The configured claim script protects that Worktree while its Agent runs.
Bubblewrap gives the Agent writable access to its Worktree and its normal provider files.
Host control files and configured protected paths stay inaccessible.
The helper runs in a separate systemd user unit with a memory limit.
Keep the systemd user manager running when the browser or terminal command closes.

## Connect the remote Service

Add this optional configuration to show a remote Wolfstar GitHub Agent Service:

```json
{
  "controller": {
    "origin": "https://your-service.example",
    "passwordFile": "/absolute/private/dashboard-password"
  }
}
```

Use the exact HTTPS origin, without a path, query, or trailing slash.
The password file must contain the remote Dashboard password. Restrict it with `chmod 600`.
The host reads it directly. The browser and local Agents do not receive it.
Remote Service controls remain read only. Local terminals keep their own providers, credentials, and capacity.
A remote connection failure does not stop local Agent sessions.
Watching opens read-only pull request diffs for the selected base and head commits.
History and Watch logs remain read only. Start new interactive work through the terminal.

## Use the terminal

Choose a Project and Agent provider, then select `New session`.
Provider model controls, approvals, and prompts appear in its native terminal interface.
Select an Agent session to open its tab. `Split terminal` shows at most two terminals.
Tabs and the selected Project persist in this browser. They do not control process lifetime.
`Close tab` only closes that view. Use `Stop Agent` to stop the process.
`Show diff` opens the active Worktree's working or staged file changes.
The diff is read only. On narrow screens it occupies the main view.

| Input                      | Behavior                                                   |
| -------------------------- | ---------------------------------------------------------- |
| Ctrl+C                     | Sends the terminal interrupt key                           |
| Shift+Enter                | Uses the Agent provider's native multiline behavior        |
| Ctrl+Shift+C, or Command+C | Copies selected terminal text                              |
| Ctrl+Shift+V, or Command+V | Uses browser paste into the terminal                       |
| Ctrl+V                     | Sends the native terminal key when the browser delivers it |

Pasted text must fit within 64 KiB of UTF-8 data. Paste smaller sections when refused.
Browser shortcuts can intercept keys, including Ctrl+W. Use terminal tab controls when closing an Agent view.
If another browser controls the terminal, release it there before selecting `Use terminal` here.
If input delivery is unknown, inspect the terminal before sending again. The host does not replay uncertain input.

## Stop or remove the local application

Ctrl+C in the hosting command closes its API and refuses new launches.
Active helpers and their Worktrees remain. Browser disconnects also preserve them.
Restart with the same configuration and state directory to reconnect.

For removal, first use `Stop Agent` for every active Agent session.
Wait until every process shows it exited or was interrupted. Investigate any unconfirmed process ownership before proceeding.
Then close the hosting command. Remove application files only after every helper has stopped.
Keep Worktrees containing useful work. Inspect them with `wt list --format=json` from each Project.
Remove only reviewed, unnecessary Worktrees with `wt remove <branch>` from their Project.
Stop releases the Worktree claim. It does not delete the Worktree or its branch.
Keep the state directory and application files while any helper remains active.
Do not remove the shared capacity command, provider credentials, or unrelated maintenance Service files.

The terminal CLI installs no persistent application service and provides no uninstall command.
If you create an autostart entry, remove that entry separately after stopping the Agent sessions.
