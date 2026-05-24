---
name: pr
description: Create, make, open, update, submit, or sync a PR / pull request. Use when user says "open a PR", "submit PR", "create pull request", "push this up", "send for review", "make a PR", or "sync PR".
user_invocable: true
---

Create or update a pull request for the current branch. Idempotent -- safe to run at any stage.

## Gotchas

- **Never amend published commits** -- CI and reviewers lose context. Always fix-forward with new commits.
- **Never `--force` push** during a PR -- rewrites shared history. Use `git push` (regular) after new commits.
- **Never `--no-verify`** -- if hooks fail, fix the underlying issue.
- **Patch export on main can fail** -- if there are binary files or complex renames, `git diff` won't capture them. Fall back to `git stash` instead of patch files.
- **`gh pr create` fails silently with bad body** -- always use HEREDOC for the body, never inline quotes.
- **CI flakes vs real failures** -- if the same check fails twice with different errors, it's flaky. If same error, it's real. Don't retry flakes more than once.
- **CodeRabbit reviews can be noisy** -- address security/correctness findings, but style suggestions are optional. Don't block the loop on nitpicks.
- **Worktree cleanup** -- if you forget `wt delete`, orphaned worktrees accumulate. Always clean up after merge.

## Data Storage

Track PR history for reference across sessions:

```bash
# After creating/updating a PR, log it
echo "$(date -I) $(git branch --show-current) PR_URL" >> "${CLAUDE_PLUGIN_DATA}/pr-history.log"
```

Read previous PRs when context is useful (e.g., finding related PRs, avoiding duplicate work).

## Step 0: Branch Check

```bash
git branch --show-current
```

**If on `main`** -> isolate work into a new branch via `wt` (git worktree manager).

`wt` creates parallel worktrees so you can work on branches without touching the main checkout. Key commands:
- `wt switch --create BRANCH` -- create new branch + worktree from current HEAD (changes shell cwd)
- `wt switch BRANCH` -- switch into an existing worktree (changes shell cwd)
- `wt switch main` -- switch back to main worktree

Steps:

1. Derive a branch name from the session's changes (e.g. `feat/add-widget`, `fix/login-bug`). Use `git diff --stat` and `git status` to inform the name.
2. Save uncommitted changes, create worktree, apply patches:
   ```bash
   git diff > /tmp/pr-changes.patch
   git diff --cached > /tmp/pr-staged.patch
   wt switch --create BRANCH_NAME
   git apply /tmp/pr-changes.patch 2>/dev/null
   git apply /tmp/pr-staged.patch 2>/dev/null
   ```
   Note: `wt switch` resets the shell cwd to the worktree directory automatically.
3. Commit the changes in the worktree, then continue from Step 1 **inside the worktree directory**.
4. After PR is created, switch back and clean up:
   ```bash
   wt switch main
   git checkout .
   ```

**If NOT on `main`** -> continue normally.

## Step 1: Detect State

Run IN PARALLEL:

```
Bash: git log main..HEAD --oneline
Bash: git diff main...HEAD --stat
Bash: gh issue list --state open --limit 20 --json number,title
Bash: gh pr view --json number,title,body,url 2>&1
```

Determine what exists:
- **No commits ahead of main** and **no uncommitted changes** -> nothing to do, tell user
- **PR exists** -> we're syncing title/body, skip to Step 4
- **No PR** -> creating fresh, continue to Step 2

## Step 2: Find Related Issues

From the last 20 open issues, match titles against the branch name and commit messages. Use keyword overlap -- no need to be exact. If `$ARGUMENTS` contains an issue number, include that directly.

## Step 3: Build PR Content

See [references/conventional-commits.md](references/conventional-commits.md) for commit format rules.

**Title:** Conventional commit format -- `feat:`, `fix:`, `docs:`, `chore:`, etc. Under 70 chars. Use scopes where
appropriate (e.g., `feat(auth):`, `fix(ui):`).

**Body template:**

```markdown
### 🔗 Linked issue

Resolves #NUMBER
<!-- or "Related to #NUMBER" if not a full fix -->

### ❓ Type of change

- [ ] 📖 Documentation
- [ ] 🐞 Bug fix
- [ ] 👌 Enhancement
- [ ] ✨ New feature
- [ ] 🧹 Chore
- [ ] ⚠️ Breaking change

### 📚 Description

<!-- 2-3 sentences: what problem existed → what we did -->
```

Tick the relevant type checkbox. Fill in the description — be concise, write like a human.

Only add `### ⚠️ Breaking Changes` and `### 📝 Migration` sections if actually breaking.

## Step 4: Verify

Run all checks before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm build
```

Fix any failures before proceeding.

## Step 5: Push & Create or Update

```bash
# Push if remote is behind
git push -u origin HEAD
```

**If PR exists** -> update it:
```bash
gh pr edit NUMBER --title "TITLE" --body "$(cat <<'EOF'
BODY
EOF
)"
```

**If no PR** -> create it:
```bash
gh pr create --title "TITLE" --body "$(cat <<'EOF'
BODY
EOF
)"
```

Output the PR URL when done. Log to `${CLAUDE_PLUGIN_DATA}/pr-history.log`.

## Step 6: Monitor CI & Review Comments

After creating or updating a PR, enter a **fix loop** -- keep watching until CI is green and all review comments are addressed.

### Loop

1. **Wait for CI** -- poll checks until they resolve:
   ```bash
   gh pr checks NUMBER --watch --fail-fast --interval 30
   ```

2. **Fetch review comments** -- check for CodeRabbit, CodeQL, or any reviewer feedback:
   ```bash
   gh pr view NUMBER --json reviews,comments --jq '.reviews[].body, .comments[].body'
   gh api repos/OWNER/REPO/pulls/NUMBER/comments --jq '.[].body'
   ```

3. **Evaluate**:
   - **CI green + no unresolved comments** -> done, report success, exit loop
   - **CI failed** -> read the failing check logs (`gh run view RUN_ID --log-failed`), fix the code, commit, push, go to 1
   - **Review comments exist** (CodeRabbit suggestions, CodeQL security alerts, human reviews) -> address each comment, commit fixes, push, go to 1

### Guidelines

- Fix issues in **new commits** (don't amend) so reviewers can see incremental fixes.
- After each push, restart from step 1 of the loop.
- If a review comment is a question or non-actionable, reply to it via `gh api` and move on -- don't block the loop.
- If stuck after 3 failed attempts on the same issue, stop the loop and ask the user for guidance.

## Step 7: Cleanup (after merge or user says "finish")

If the PR was created from a worktree (Step 0), clean up:

```bash
wt switch main
wt delete BRANCH_NAME
```

`wt delete` removes the worktree directory and deletes the local branch.
