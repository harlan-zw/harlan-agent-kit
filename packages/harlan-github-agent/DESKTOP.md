# Desktop execution

Hogwild owns observation, the Queue, and every GitHub write.
Desktop runs Agent turns only after Hogwild fills its local Agent capacity.
A saved desktop session stays on desktop until its work ends.

Each Agent accounts for 8 GiB. Hogwild's effective Agent limit also respects its service memory limit.
The desktop shares a configurable 16 GiB with GitHub Actions through `harlan-desktop-capacity`.

## Install

First install `desktop-capacity` from `harlan-zw/hogwild-gh-runner`.
Update the Hogwild controller and the desktop service checkout to this revision.
The desktop uses its existing provider login, tools, and repository environment files.

Install the desktop client:

```bash
install -Dm644 scripts/desktop-agent.service ~/.config/systemd/user/harlan-desktop-agent.service
systemctl --user daemon-reload
systemctl --user enable --now harlan-desktop-agent.service
```

That is a first install only. `pnpm service:hogwild:update` reinstalls the unit,
moves the desktop checkout, and restarts the client on every later deploy.

The client reads `~/.config/harlan-github-agent/dashboard-password` for the Hogwild controller.
If it differs, set `HARLAN_GITHUB_AGENT_PASSWORD_FILE` in `~/.config/harlan-github-agent/desktop.env`.
That file can also override `HARLAN_GITHUB_AGENT_CONTROLLER_URL`.
Keep the password file private.

Desktop makes outbound HTTPS requests. It needs no inbound SSH service.
The System pane shows desktop connection, activity, and shared memory.
Memory changes persist. An offline desktop receives a saved change when it reconnects.

## Work and cancellation

The controller transfers the exact commit, tracked edits, and regular untracked files.
Desktop creates a Worktrunk-owned Worktree, runs the provider, and returns its changes.
The controller checks the original Worktree before importing a result.
It refuses late results from completed or cancelled turns.

The desktop checks the turn every three seconds. Cancellation or connection loss stops its Agent scope.
Eject shows a desktop command for desktop sessions. Their Worktrees stay on desktop for session recovery.

GitHub credentials and dependency directories do not transfer between hosts.
Ignored files stay local, except pull request diagrams under `.pr-lens`.
The desktop seeds repository environment files from a matching local checkout.
An untracked symlink needs a commit before transfer.
