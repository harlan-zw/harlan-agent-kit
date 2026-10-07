# Agent worker credentials

Provision each host before deploying this change.
Agent providers require Linux, Bubblewrap, and a separate worker home.
Missing configuration stops a turn before any model tool runs.
Service update checks and startup reject missing profiles or unavailable namespaces.
The desktop helper runs the same check before advertising capacity.

## Provision a host

Install `bubblewrap` through the host's administrator account.
On Hogwild, use `hogwild-admin` for installation.
Run the following command as the Service account, from the new checkout.
It copies provider logins, the public GitHub token, Agent instructions, Skills, and Hooks.
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
Mount exact installation directories; never mount a complete home, configuration directory, or Service state directory.
Mounts are read only, except the worker home, worktree, and required Git metadata.
Do not place controller credentials in the worker home or tool directories.

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
Desktop protocol 6 prevents an older desktop from receiving a turn from the new controller.
Worker provider sessions use the separate home; older provider sessions may need a fresh turn.
Provider refreshes update the worker's own login files.
Repeat provisioning only when those files need intentional replacement.

## Boundary and limits

The worker sees its separate home, its worktree, selected instructions, and selected tool installations.
Git receives a generated configuration with a credential-free GitHub origin.
The namespace exposes only shared Git objects, refs, logs, and this task's Git directory.
The host's Git configuration, hooks, extra Git files, and other task indexes remain hidden.
Repository environment files remain available for repository tooling.
Their credentials retain the authority already granted to that repository.

The worker receives private process and network namespaces, plus private `/proc`, `/tmp`, and `/run` mounts.
Controller environment variables do not enter the worker environment.
OpenCode's server and attachment client both run inside the boundary.
Codex enters through a trusted executable adapter before any model tool runs.

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
