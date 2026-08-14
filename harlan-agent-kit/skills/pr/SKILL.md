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
- **Never move unknown changes** -- shared checkout changes may belong to another task. Copy only changes this task owns.
- **`gh pr create` fails silently with bad body** -- always use HEREDOC for the body, never inline quotes.
- **CI flakes vs real failures** -- if the same check fails twice with different errors, it's flaky. If same error, it's real. Don't retry flakes more than once.
- **CodeRabbit reviews can be noisy** -- address security/correctness findings, but style suggestions are optional. Don't block the loop on nitpicks.
- **Worktree cleanup** -- if you forget `wt remove`, orphaned worktrees accumulate. Clean up after merge.

## Data Storage

Track PR history for reference across sessions:

```bash
# After creating/updating a PR, log it
echo "$(date -I) $(git branch --show-current) PR_URL" >> "${CLAUDE_PLUGIN_DATA}/pr-history.log"
```

Read previous PRs when context is useful (e.g., finding related PRs, avoiding duplicate work).

## Step 0: Own a Branch

```bash
git status --short
git branch --show-current
```

Before any edit, acquire the controller's atomic task claim for the intended checkout. If no controller exists, acquire an atomic session-owned lock keyed by the repository and absolute checkout path. Treat another live claim in the repository as an active agent. Release the claim when the task ends. If ownership is ambiguous, do not edit the shared checkout.

An existing worktree alone does not prove another agent is active.

Use `wt` only when another agent is actively modifying the same repository. If no other agent is active there, keep the current checkout. If it is on the default branch, create a normal task branch with `git switch -c BRANCH`, then continue to Step 1.

If another agent is active in the repository:

1. Run `wt list --format=json`.
2. Reuse this task's existing worktree with `wt switch BRANCH` when one exists.
3. Otherwise derive a branch name such as `feat/add-widget` or `fix/login-bug`.
4. Create it from the intended base with `wt switch --create BRANCH --base BASE`.
5. Run `wt list --format=json` again. Read the branch's absolute `path`.
6. Pass that path as `workdir` to every later command, including CI repairs.

If this task's changes already exist in a shared checkout, leave that checkout untouched. Copy only verified task-owned changes into the new worktree. Use `git diff --binary` for tracked files and copy owned untracked files individually. Verify the destination diff before continuing. Never reset, clean, stash, or overwrite the source checkout.

Never share a mutation worktree between tasks. Never use `wt switch --clobber` to resolve a path collision.

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

**Use the repo's own template if it has one.** Check `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`, and `docs/PULL_REQUEST_TEMPLATE.md`. If one exists, fill it and add only the required AI disclosure. Only if none exists, use this:

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

<!-- what was wrong or missing, then what changed -->

> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).
```

Reproduce that block character for character, including every emoji. Do not restyle it per repo.

Add `### ⚠️ Breaking Changes` and `### 📝 Migration` only when the change actually breaks or needs an operator step. Migration text is for the person running it: the command, the ordering constraint, and what it cannot recover.

### Body rules

These exist because the generated bodies drift the same way every time.

- **No verification, testing, or QA section. Ever.** Not `✅ Verification`, not `🧪 Testing`, not a checklist of what you ran. CI reports test results and reviewers trust it. Evidence that CI cannot produce belongs in a follow-up comment (Step 5), never the description.
- **No self-ticked checkboxes** beyond the ones the repo's own template asks for. A list of `- [x]` items you wrote and ticked yourself is not evidence, it reads as homework.
- **Delete empty sections.** Never write "None.", "No linked issue.", or "N/A" under a heading. No linked issue means no Linked issue section.
- **Length follows risk.** A fix gets 1 to 3 sentences. Spend more only where a reviewer must understand a behaviour change, a data migration, or a non-obvious tradeoff. Never narrate the diff; the diff is right there.
- **Earn every number.** Include a figure only if a reviewer would act differently for knowing it. `7,438 rows backfilled` earns its place in a migration note. `533 tests passed, 2 skipped` does not.
- **Vary the shape.** Do not open every paragraph with `This `. Do not follow a past-tense problem sentence with a present-tense `This adds…` in every PR. For a small fix, one sentence is the whole description.
- **Disclose AI writing visibly.** If Harlan Agent Kit drafts or edits the description, append the exact AI disclosure after the description. Never hide it in an HTML comment or template metadata.
- **Preserve disclosure.** Keep an existing AI disclosure during every body rewrite. Refuse publication when required disclosure is missing or changed.

### Voice

Modelled on Harlan's hand-written PRs to `nuxt/nuxt`. These are the moves that read human and that generated bodies never make on their own.

- **Write as the person who hit the problem.** First person is correct when there is a story or a judgement: "I had a valid use case for runtime plugin meta, and got a cryptic warning three times", "I honestly had no idea what it meant and could only debug it by reading the Nuxt source". Do not fabricate an experience you did not have; if the work started from an issue, say that instead.
- **Paste the evidence, do not describe it.** Real terminal output before and after, the actual generated code that broke, the config snippet a user would write. A pasted `WARN` line beats a sentence about a warning.
- **Say what you are unsure about.** Real PRs carry loose ends: "I tried making it throw once but hit too many test failures, not sure what went wrong", "Question: should the root element always have a unique id?", "Consider deprecating `teleportId` with these changes". Include the dead end you abandoned, the follow-up you did not take, the design question you want the reviewer to answer. Certainty on every point is the loudest AI tell in a PR.
- **Bullets and fragments are fine.** "Types aren't documented, copied docs from the site" is a complete thought. Prose paragraphs are not mandatory.
- **Motivation before mechanism** for a feature: who needs this, what they do today, what is bad about that, then the change.
- **Do not perform completeness.** Leave the repo template's HTML comments untouched. Tick a checklist box only if it is true. Shipping with boxes unticked is normal and correct.

**Strip AI tells from the title and description** before pushing, run them through `/humanize-writing`. For PRs specifically: no em-dashes, drop the over-explained "this means that..." takeaway, and use specifics (file/function names, issue numbers, real before/after behavior) instead of vague claims like "improves performance". A PR body that reads as AI-generated erodes reviewer trust.

**Reads-human check.** Before pushing, reread the body and cut anything that exists to show effort rather than to help the reviewer. This is the target shape:

```markdown
### 🔗 Linked issue

Resolves #658

### ❓ Type of change

- [x] 🐞 Bug fix

### 📚 Description

DevTools refresh broadcasts used request and response RPC calls, so disconnected
clients logged a `birpc` timeout for `refreshRouteData` when pages changed. Send
these one-way notifications with `asEvent()` and cover route refresh behavior
with a unit test.

> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).
```

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

**Verification evidence goes here, as a comment, not in the description.** Post it directly only on a repo the user owns or maintains, since it is part of submitting their own PR. Anywhere else, show the draft and let them post it. Post one only when you did something CI cannot show: ran a migration against a restored database, exercised the change in a browser, checked an authorization boundary by hand. Skip it entirely when the proof is just lint, typecheck, and the test suite; CI already reports those.

```bash
gh pr comment NUMBER --body "$(cat <<'EOF'
Checked by hand, since CI cannot cover it:
- Backfill on a 5 Aug 2026 live restore produced 7,438 snapshots, rerun added none
- Signed agreement kept the same SHA256 after editing venue, purchaser, and contract ID
- Crafted Staff export request returned 403
EOF
)"
```

Keep it to the checks a reviewer would otherwise have to repeat. Prose lines, not ticked boxes.

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
- If Step 0 selected a worktree, keep every fix and check there.
- After each push, restart from step 1 of the loop.
- **Never post a reply to a review comment yourself.** Fixing the code and pushing is your move; talking to a reviewer is not. If a comment is a question or non-actionable, draft the reply, show it to the user, and let them post it. Continue the loop while you wait; do not block on it.
- If stuck after 3 failed attempts on the same issue, stop the loop and ask the user for guidance.

## Step 7: Cleanup (after merge or user says "finish")

If the PR was created from a worktree (Step 0), clean up:

```bash
wt remove BRANCH_NAME
```

`wt remove` removes the worktree. It deletes the local branch only when the branch is integrated. Never use `--force` or `--force-delete` to bypass this check.

## Related review skill

This skill owns PR creation, metadata, CI monitoring, and review feedback repair.

`../adversarial-review/SKILL.md` exclusively owns the automated adversarial review outcome and marked bot status. Do not create or update that status here.

`../pr-owner/SKILL.md` wraps this workflow when one agent owns a personal site PR through deployment and smoke verification.
