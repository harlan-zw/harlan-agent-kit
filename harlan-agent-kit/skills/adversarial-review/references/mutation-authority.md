# PR mutation authority

Apply this contract before every code, metadata, branch, or comment mutation.

## Allowed base repositories

Allow PR branch, metadata, and bot status mutations only when the base repository is:

1. A non-archived repository whose owner exactly matches the authenticated GitHub login.
2. `unjs/unhead`.

Always exclude `nuxt/nuxt`, every other `unjs/*` repository, and every other organization repository.

GitHub write access does not prove ownership. Broaden this list only after an explicit user instruction names the repository and action.

Recheck the exact base repository before every mutation.

## Writable PR branches

A PR head branch is writable only when at least one condition holds:

1. Its repository owner is the authenticated user.
2. Its repository equals the base repository.
3. `maintainerCanModify` is true.

Continue read only when the head is not writable. Record the permission boundary in the bot status.

Adversarial review authority never permits force pushing, amending published commits, dismissing reviews, approving, merging, or pushing the base branch.

## Ownership merge

The `take-ownership` skill may merge only when every condition holds:

1. The current request explicitly says `$take-ownership`, `/take-ownership`, `get this merged`, or `land this`.
2. The base repository owner exactly matches the authenticated GitHub login.
3. `adversarial-review` reports `PASS` for the exact remote head.
4. Required checks and approvals pass for that same head.
5. The repository's normal merge method or merge queue accepts the change without administrator bypass.

This authority does not let `adversarial-review` merge. It never permits self-approval, force push, branch-protection bypass, or merging maintained and external repositories.

## Default branch repair

Direct default branch repair has a narrower boundary. Allow it only when every condition holds:

1. The base repository owner exactly matches the authenticated GitHub login.
2. The configured canonical checkout is under `~/sites`.
3. PR ownership was enabled before merge.
4. The failure belongs to the merge, deployment, or smoke verification being monitored.
5. The repair is minimal and verified locally.

Never directly push to `nuxt/nuxt`, `unjs/unhead`, another `unjs/*` repository, or any repository owned by another account or organization.

Use a normal commit on the current remote default branch. Never bypass branch protection, force push, or disable hooks.
