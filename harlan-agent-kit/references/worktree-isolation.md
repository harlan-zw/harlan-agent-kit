# Worktree isolation contract

Use a live task claim to detect concurrent repository mutation. A worktree's existence does not prove an agent is active.

The primary checkout is a control checkout. Keep it clean on `main`, with `HEAD` equal to `origin/main`. Never edit it. Read-only work may use it. Every mutation uses a task-owned worktree.

## Worktree ownership

`wt` is the only tool that may create, enter, or remove a worktree.

Never run `git worktree add`. Never use a harness worktree feature: Claude Code's `EnterWorktree` tool, an `Agent` call with `isolation: "worktree"`, or a workflow step with `isolation: 'worktree'`. Those write to `.claude/worktrees/`, which is banned. If a harness worktree already exists, do not extend it. Move the work into a `wt` worktree.

`~/.config/worktrunk/config.toml` fixes the location for every repository:

```
<parent>/<repo>.<branch-slug>
```

Example: branch `fix/auth` in `~/pkg/app` resolves to `~/pkg/app.fix-auth`. Never pass an explicit worktree path. Never use `wt switch --clobber`.

`harlan-github-agent` follows the same contract. It creates each agent worktree from the configured repository checkout with `wt`.

The global `pre-switch` hook protects the primary checkout before every Worktrunk switch. It requires `main`, a clean worktree, and an `origin` remote. It fetches and prunes every `origin` ref, then fast-forwards local `main` to `origin/main`. A fetch failure, local commit, divergent branch, or dirty file stops the switch.

## Prepared worktrees

The global `pre-start` hook runs once when `wt` creates a worktree.
It blocks the caller until setup finishes.

For a pnpm repository, the hook runs when both worktrees contain `pnpm-lock.yaml`.
It installs the new worktree's exact dependency graph.
It prefers the shared pnpm store and disables lifecycle scripts.

A successful creation means that `node_modules` is ready for repository checks.
Do not repeat the install only to initialise that worktree.
Run another install when the task changes the dependency graph.

The global hook copies the primary worktree's root `.env` once.
It copies only a regular file that Git ignores in both worktrees.
It never overwrites a file or follows a symlink.
Later changes stay private to each worktree.

The global hook also seeds ignored `.data` and `.wrangler/state` directories.
It copies only from the primary worktree when the destination has no state.
Each worktree receives a private writable copy.
Worktrunk stops setup when the primary state has an open file.
This prevents a torn copy of SQLite or WAL state.
The copy uses filesystem reflinks when available and a normal copy otherwise.

A failed hook stops the worktree handoff.
Do not start an Agent in a partly prepared worktree.

pnpm shares immutable package data through its content-addressable store.
Each worktree keeps its own `node_modules` topology.
Never copy, hard-link, or symlink `node_modules` from another worktree.

Nuxt recreates `.nuxt` from the current worktree.
Generated files can contain absolute worktree paths.
Never copy, hard-link, or symlink `.nuxt` between worktrees.

Nuxt's experimental build cache is also path-specific today.
A project may enable it after a repeated-build smoke test.
Do not share its cache directory across different worktree paths.

## Commands

| Action | Command |
| --- | --- |
| List worktrees and absolute paths | `wt list --format=json` |
| Create from the chosen base | `wt switch --create <branch> --base <base>` |
| Enter an existing worktree | `wt switch <branch>` |
| Remove after merge | `wt remove <branch>` |

Read the absolute `path` from `wt list --format=json`. Pass that path as the working directory to every later command. Never force removal with `--force` or `--force-delete`.

Choose the base independently from the primary checkout. Use `origin/main` for independent work. For stacked work, use `origin/<parent-branch>` when its current remote tip is the intended parent. Use an exact parent SHA when the task freezes that parent commit. The primary checkout stays on `main` for every choice.

## Claim interface

Prefer an active controller's atomic claim when it records the normalized repository, absolute checkout, session owner, and lease. The controller must support acquire, list, renew, and release operations.

Without that interface, use `${CLAUDE_SKILL_DIR}/../../scripts/worktree-claim.sh`. Resolve the same path relative to the active `SKILL.md` when `CLAUDE_SKILL_DIR` is unavailable.

Create one stable session ID with the controller's task ID or `bash SCRIPT new-session`. Reuse it for the entire task.

Before the first edit, run:

```bash
bash SCRIPT acquire --path "$PWD" --session "$TASK_SESSION_ID"
```

The helper normalizes identity through the repository's common Git directory and absolute worktree root. It serializes operations with `flock`. Claims expire after 15 minutes by default. Every operation removes expired claims.

Run `acquire` again before each mutation phase and at least every five minutes to renew the lease. Run `list` to inspect live claims. Run `release` at task completion. Only the owning session can renew or release a live checkout claim.

## Isolation decision

Use the primary checkout only for read-only work and Worktrunk commands. Do not acquire it for mutation.

Before mutation, run `wt list --format=json`. If one worktree already belongs to this task, acquire and reuse it. Otherwise choose the task base, create one with `wt switch --create <branch> --base <base>`, then acquire it.

A live claim in another worktree still proves concurrent repository work. A stale claim or an unclaimed worktree does not.

Never share a mutation worktree between tasks. If claim ownership is missing or ambiguous, stop before editing the selected worktree.

When the task reaches its cleanup point, release its claim. If the task created a worktree, use `wt remove <branch>`. Never force removal.
