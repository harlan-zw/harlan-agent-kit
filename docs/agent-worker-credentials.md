# Agent worker credentials

Provision each host before deploying this change.
Agent providers require Linux, Bubblewrap, and a separate worker home.
Missing configuration stops a turn before any model tool runs.
Service update checks and startup reject missing profiles or unavailable namespaces.
The desktop helper runs the same check before advertising capacity.

## Provision a host

Install `bubblewrap` 0.10 or later through the host's administrator account.
The Service update check refuses an older version, because it cannot mount the worker home overlay.
On Hogwild, use `hogwild-admin` for installation.
Run the following command as the Service account, from the new checkout.
It copies provider logins, the public [GitHub](https://github.com) token, Agent instructions, Skills, and Hooks.
For ZAI, it extracts only the named provider API key from OpenCode configuration.
It does not copy the controller's GitHub login, Git helpers, or SSH keys.

```bash
pnpm exec node --experimental-strip-types scripts/agent-worker.ts \
  --source-home "$HOME" \
  --worker-home "$HOME/.local/share/harlan-agent-kit/worker-home" \
  --config "$HOME/.config/harlan-github-agent/worker.json" \
  --codex "$(command -v codex)" \
  --opencode "$(command -v opencode)" \
  --tool-dir "$HOME/.local/bin" \
  --tool-dir "$(dirname "$(readlink -f "$(command -v node)")")" \
  --read-only "$HOME/.local/share/harlan-github-agent/service/harlan-agent-kit"
```

Each provider executable must exist when running this command.
A host may omit a provider login it does not use.
The corresponding provider then needs login before it can serve turns.

Tools with external runtime directories need additional `--tool-dir` or `--read-only` arguments.
For example, mount pnpm's installation directory if its executable imports sibling modules.
A native [pnpm](https://pnpm.io) shim, such as `node`, runs a runtime from pnpm's global directory.
If a tool directory holds such a shim, each turn mounts that runtime package read only.
Mount exact installation directories; never mount a complete home, configuration directory, or Service state directory.
Host mounts are read only, except the persisted worker home paths, worktree files, and selected temporary evidence directories.
Do not place controller credentials in the worker home or tool directories.

## Worker home

Every Agent turn except Review mounts the worker home as an overlay.
Reads come from the shared worker home, so caches stay warm.
Writes outside the persisted paths go to a directory that the turn owns.
The Service deletes that directory when the turn ends.

These persisted paths write through to the shared worker home:
`.codex`, `.local/share/opencode`, `.local/share/pnpm/store`, `.cache/pnpm`, `.npm/_cacache`, `.bun/install/cache`, `.cargo/registry`, `.cargo/git`, `.cache/ms-playwright`, `.dev-browser`, `.local/share/pnpm/package-manager-store`, `.rustup`, and `.local/state/harlan-agent-kit`.
A check-in Routine also keeps the state directory of its own repository.
The sentry-checkin Routine also keeps `.local/state/sentry-checkin`.

Inside `.codex`, Codex reads some files as configuration, instructions, or code.
Each turn gets its own copy of `config.toml`, `.env`, `AGENTS.override.md`, `AGENTS.md`, `hooks.json`, `plugins`, `skills`, `rules`, `prompts`, `shell_snapshots`, and `agents`.
Changes to these paths last one turn.
Codex account plugins are off for Agent turns.
With plugins on, Codex downloads the account's plugins again in every turn.

Codex turns load the kit from the read-only Service checkout, never from the worker home.
The kit Skills mount read only at `.codex/skills/harlan-agent-kit`.
The kit guards in `hooks/codex.json` mount read only in `/etc/codex`.
Codex runs hooks from that system layer without a stored trust.
A turn cannot change either one.

## Keep Agent tools current

On provisioned hosts, context sync installs stable Agent tools.
These tools include GitHub CLI, Codex, OpenCode, [Bun](https://bun.sh), Worktrunk, ripgrep, and fd.
Each host downloads its own Linux archive and checks GitHub's SHA-256 digest.
The installer checks the executable before replacing its previous version.
An unchanged release skips the download.
A failed download or check fails sync and preserves that tool's previous executable.

Run `pnpm sync:context:all` to update both hosts.
Run `pnpm sync:tools` to update local Agent tools alone.
Set `HARLAN_AGENT_TOOLS_UPDATE=0` when only instructions should change.
Node, pnpm, and repository dependencies keep their existing pins.

Managed executables live in `~/.local/share/harlan-agent-kit/tools/bin`.
Each new Agent turn resolves these files again and mounts them read only.
The public GitHub wrapper uses the mounted GitHub CLI before the system CLI.
Running turns keep their existing mounts until they finish.
Provider logins and the controller's credentials remain separate.

## Verify before restart

Run the fake-credential smoke in the new checkout.
It runs the provisioning command with fake logins and creates a real Worktrunk worktree.
It checks host credential files, host Git helpers, inherited tokens, and controller process files.
It also commits a file and confirms the host's Git index agrees.

```bash
pnpm exec vitest run packages/harlan-github-agent/test/agent-sandbox.test.ts
AGENT_EGRESS_LIVE_SMOKE=1 pnpm exec vitest run packages/harlan-github-agent/test/agent-sandbox.test.ts
pnpm build
```

From a linked worktree, run each configured provider's version command before restarting the Service.

```bash
pnpm exec node --experimental-strip-types scripts/agent-worker-check.ts --workspace "$PWD" --provider codex
pnpm exec node --experimental-strip-types scripts/agent-worker-check.ts --workspace "$PWD" --provider opencode
```

Verify every repository's required tooling within an isolated turn.
If a tool cannot resolve a runtime path, add that exact trusted directory and repeat the check.
Never disable isolation to recover availability.

Deploy through the existing Service update path after provisioning both hosts.
The desktop protocol check refuses incompatible desktop helpers.
Worker provider sessions use the separate home; older provider sessions may need a fresh turn.
Provider refreshes update the worker's own login files.
Repeat provisioning only when those files need intentional replacement.

## Boundary and limits

The worker sees its separate home, its worktree, selected instructions, and selected tool installations.
Git receives a generated configuration with a credential-free GitHub origin.
The namespace gives Git private objects, refs, logs, and task data.
Existing host objects enter through read-only alternates.
The worktree's administrative pointers and generated Git configuration remain read only.
After the turn, isolated Git exports a pack capped at 128 MiB.
Host Git validates that pack before updating the approved branch.
The update compares the original head SHA and refuses a newer host head.
Only bounded index, head, and merge data returns to the host.
The host's Git configuration, hooks, extra Git files, and other task indexes remain hidden.
Repository environment files remain available for repository tooling.
Their credentials retain the authority already granted to that repository.

The worker receives private process and network namespaces, plus private `/proc`, `/tmp`, and `/run` mounts.
Controller environment variables do not enter the worker environment.
OpenCode's server and attachment client both run inside the boundary.
The attachment client receives a read-only worktree and never returns Git data.
The server completes Git export before the turn releases its worktree.
Codex enters through a trusted executable adapter before any model tool runs.
Repair recovery runs installation, regression checks, and build commands through the same isolation boundary.
Missing worker configuration stops those commands before repository code runs.

Network traffic leaves through a trusted HTTP proxy over a dedicated Unix socket.
The proxy permits ports 80 and 443 on public IPv4 destinations.
Each connection resolves its destination once and pins the approved numeric address.
Private, loopback, link-local, reserved, and mixed public/private DNS answers are refused.
IPv6 destinations are refused.
Redirects require a new connection and receive the same checks.
Raw tools cannot reach the host loopback network, LAN, tailnet, or metadata services.
OpenCode's controller transport connects only to this turn's isolated server through its dedicated Unix socket.

The runtime configures proxy variables for provider traffic and repository tools.
[Bun honors HTTP proxy variables](https://bun.sh/guides/http/proxy).
[Node enables proxy support through `NODE_USE_ENV_PROXY`](https://nodejs.org/en/learn/http/enterprise-network-configuration).
Tools that ignore those settings need explicit proxy configuration; direct network connections remain blocked.
The smoke proves filesystem, process, environment, and Git isolation with fake credentials.
It also checks direct private connections, proxy refusal, and real public HTTPS when the live flag is set.
Both default providers complete fixture turns through the actual launch and transport paths.
The smoke does not prove live provider login or each production repository's tooling.

## Review proof limits

Review exposes bounded reading, literal search, and one controller-reserved Node proof invocation.
Review launches exclude repository environment files and use controller-selected provider configuration.
Static reads accept byte offsets and return the next offset for each bounded page.
Revision reads expose the complete triple-dot diff and changed file contents at its merge base and head.
The controller collects this immutable evidence using fixed Git reads inside a separate read-only namespace.
Evidence names the supplied base SHA, actual merge base SHA, and head SHA.
The evidence limit is 500 changed paths, 1000000 bytes per blob, and 8000000 bytes total.
Over-limit or binary changes return Unavailable. Revision reads exclude symlinks and submodule contents.
Static evidence never reserves a proof invocation.
The proof supports exported TypeScript APIs without installation, network access, or child processes.
Unsupported preparation is a verification limit.
The proof runs with an empty home, read-only files, and socket and process creation denied.
Its controller-owned user scope limits memory to 512 MiB and disables swap.
Each host requires its Service account's systemd user manager and bus.
Missing scope authority stops verification without a weaker fallback.
The controller retains failed output and cleanup warnings when the invocation ends.
The limit counts one controller invocation, rather than assertions inside that invocation.
