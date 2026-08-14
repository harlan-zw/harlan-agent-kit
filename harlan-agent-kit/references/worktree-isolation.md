# Worktree isolation contract

Use a live task claim to detect concurrent repository mutation. A worktree's existence does not prove an agent is active.

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
