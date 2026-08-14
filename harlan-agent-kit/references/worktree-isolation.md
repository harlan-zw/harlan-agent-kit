# Worktree isolation contract

Use a live task claim to detect concurrent repository mutation. A worktree's existence does not prove an agent is active.

## Worktree ownership

`wt` is the only tool that may create, enter, or remove a worktree.

Never run `git worktree add`. Never use a harness worktree feature: Claude Code's `EnterWorktree` tool, an `Agent` call with `isolation: "worktree"`, or a workflow step with `isolation: 'worktree'`. Those write to `.claude/worktrees/`, which is banned. If a harness worktree already exists, do not extend it. Move the work into a `wt` worktree.

`~/.config/worktrunk/config.toml` fixes the location for every repository:

```
<parent>/<repo>.<branch-slug>
```

Example: branch `fix/auth` in `~/pkg/app` resolves to `~/pkg/app.fix-auth`. Never pass an explicit worktree path. Never use `wt switch --clobber`.

`harlan-github-agent` follows the same contract. It creates each agent worktree from the configured repository checkout with `wt`.

## Commands

| Action | Command |
| --- | --- |
| List worktrees and absolute paths | `wt list --format=json` |
| Create from a base | `wt switch --create <branch> --base <base>` |
| Enter an existing worktree | `wt switch <branch>` |
| Remove after merge | `wt remove <branch>` |

Read the absolute `path` from `wt list --format=json`. Pass that path as the working directory to every later command. Never force removal with `--force` or `--force-delete`.

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

If the selected checkout already belongs to this task, reuse it.

If the shared checkout claim succeeds with `other_active: false`, work there. Do not create a worktree.

If another session owns the shared checkout, or a successful shared claim reports `other_active: true`, do not edit there. Release any claim owned by this session. Run `wt list --format=json`. Reuse this task's worktree or create one with `wt switch --create <branch> --base <base>`. Acquire the new checkout before editing it.

A live claim in another worktree still proves concurrent repository work. A stale claim or an unclaimed worktree does not.

Never share a mutation worktree between tasks. If claim ownership is missing or ambiguous, stop before editing the shared checkout.

When the task reaches its cleanup point, release its claim. If the task created a worktree, use `wt remove <branch>`. Never force removal.
