---
name: pr
description: "Create or update a pull request from current work. Use when work should be branched, committed, pushed, submitted, shipped, or landed on an owned repository."
user_invocable: true
---

Create or update a pull request for the current branch. Idempotent -- safe to run at any stage.

## Markdown-only exception

If every task-owned changed path ends in `.md`, use this exception for a repository Harlan owns or maintains.
Push the change directly to `origin/main`. Never open a pull request for Markdown-only work.

Before editing, follow the [worktree isolation contract](../../references/worktree-isolation.md). Start from the current `origin/main`.

After editing:

1. Check every task-owned changed path.
   If one path does not end in `.md`, use the normal pull request workflow below.
2. Run any checks that cover the changed Markdown.
3. Commit with a Conventional Commit subject.
4. Push without force: `git push origin HEAD:main`.
5. Verify `origin/main` points at the pushed commit.

If the direct push fails, stop and report the refusal. Do not create a pull request as a fallback.
Do not wait for CI or deployment unless its event uses `paths` to include the changed Markdown.

## When to invoke

Invoke on intent, not on phrasing. If the next command you are about to run is `git switch -c`, `git commit`, `git push`, or `gh pr create`, stop: this skill owns that sequence. Run it instead of the raw commands.

None of these are reasons to skip it:

- **The user never said "PR".** Once a fix is written and verified, "fix", "ship it", "land this", or a bare "yes" all mean land it. The trigger list in the description is examples, not a required wording.
- **The change is small.** Except for Markdown-only work above, a one-line fix still needs the repo's template, the AI disclosure, a body with no verification section, and green CI. Size changes none of that.
- **Invoking costs a turn.** Rewriting a hand-made PR body costs more, and a PR pushed without Step 4 can fail CI in front of a reviewer.
- **You already ran the git commands.** Then a PR exists and is probably wrong. Re-enter here anyway -- Step 1 detects the existing PR and Step 5 syncs it in place.

Running the git and `gh` commands by hand is the failure mode this skill exists to prevent.

## Gotchas

- **Never amend published commits** -- CI and reviewers lose context. Always fix-forward with new commits.
- **Never `--force` push** during a PR -- rewrites shared history. Use `git push` (regular) after new commits.
- **Never sync a clean pull request with its base branch:** A newer base alone needs no pull request commit.
  Merge the base into the head only when GitHub reports merge conflicts.
- **Never `--no-verify`** -- if hooks fail, fix the underlying issue.
- **Never move unknown changes** -- primary checkout changes may belong to another task. Copy only changes this task owns.
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

Before any edit, follow the [worktree isolation contract](../../references/worktree-isolation.md). It provides the atomic live-agent claim used below.

An existing worktree alone does not prove another agent is active.

`wt` is the only worktree tool. Never run `git worktree add`, and never use a harness worktree option such as `EnterWorktree` or `isolation: "worktree"`. Those write to `.claude/worktrees/`, which is banned. `wt` places every worktree at `<parent>/<repo>.<branch-slug>`.

Keep the primary checkout read only. Every mutation uses a task-owned `wt` worktree:

1. Run `wt list --format=json`.
2. Reuse this task's existing worktree with `wt switch BRANCH` when one exists.
3. Otherwise derive a branch name such as `feat/add-widget` or `fix/login-bug`.
4. Choose `BASE`. Use `origin/main` for independent work. Use `origin/PARENT` or the exact parent SHA for stacked work.
5. Create it with `wt switch --create BRANCH --base BASE`.
6. Run `wt list --format=json` again. Read the branch's absolute `path`.
7. Pass that path as `workdir` to every later command, including CI repairs.

If this task's changes already exist in the primary checkout, leave that checkout untouched. List every verified task-owned path. Export `git diff --cached --binary -- PATHS` and `git diff --binary -- PATHS` separately. Apply the cached patch with `git apply --index`, then apply the unstaged patch. Copy owned untracked files individually. Compare every owned source path with its destination before continuing. Never reset, clean, stash, or overwrite the source checkout.

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

**Use the repo's effective template if it has one.** Check `.github/PULL_REQUEST_TEMPLATE.md`, `.github/pull_request_template.md`, and `docs/PULL_REQUEST_TEMPLATE.md`. If none exists locally, read `files.pull_request_template` from `repos/OWNER/REPO/community/profile`. This resolves inherited templates from the owner's `.github` repository. Fetch the returned `url`, fill that template, and add only the required AI disclosure. Only use this fallback when the community profile has no template:

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

<!-- why this is needed, then 1 to 2 sentences on what changed -->

> 🤖 AI disclosure: [Harlan Agent Kit](https://github.com/harlan-zw/harlan-agent-kit) modified this description. [My AI open-source policy](https://harlanzw.com/blog/ai-in-open-source).
```

Reproduce that block character for character, including every emoji. Do not restyle it per repo.

Add `### ⚠️ Breaking Changes` and `### 📝 Migration` only when the change actually breaks or needs an operator step. Migration text is for the person running it: the command, the ordering constraint, and what it cannot recover.

### Body rules

These exist because the generated bodies drift the same way every time.

- **Answer why, not how.** The description exists to say why the change is needed. The fix itself gets 1 to 2 sentences. Never walk through the implementation, name the functions you touched, or explain the mechanism; the diff is right there and the code documents itself. A reviewer who reads the method twice is a reviewer you wasted.
- **No verification, testing, or QA section. Ever.** Not `✅ Verification`, not `🧪 Testing`, not a checklist of what you ran. Not a passing mention either: "covered by unit tests only" and "added five e2e cases" are testing details and belong nowhere in the body. CI reports test results and reviewers trust it. Evidence that CI cannot produce belongs in a follow-up comment (Step 5), never the description.
- **Benchmarks when they are relevant and measured.** A performance or caching change earns a real before and after. Never invent, estimate, or infer a figure. If you did not measure it, say nothing, or offer to run it.
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

**Strip AI tells from the title and description** before pushing, run them through `/humanize-writing`. For PRs specifically: no em-dashes, drop the over-explained "this means that..." takeaway, and use specifics (issue numbers, real before/after behaviour, measured figures) instead of vague claims like "improves performance". A PR body that reads as AI-generated erodes reviewer trust.

**Reads-human check.** Before pushing, reread the body and cut anything that exists to show effort rather than to help the reviewer. This is the target shape:

```markdown
### 🔗 Linked issue

Resolves #658

### ❓ Type of change

- [x] 🐞 Bug fix

### 📚 Description

DevTools refresh broadcasts used request and response RPC calls, so disconnected
clients logged a `birpc` timeout for `refreshRouteData` every time the pages
changed. They are notifications now, so a dead client costs nothing.

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
HARLAN_AGENT_PR_SKILL=1 gh pr edit NUMBER --title "TITLE" --body "$(cat <<'EOF'
BODY
EOF
)"
```

**If no PR** -> create it:
```bash
HARLAN_AGENT_PR_SKILL=1 gh pr create --title "TITLE" --body "$(cat <<'EOF'
BODY
EOF
)"
```

Output the PR URL when done. Log to `${CLAUDE_PLUGIN_DATA}/pr-history.log`.

### Let the agent merge it

`harlan-github-agent` reviews every pull request it tracks. Add `harlan-agent-auto-merge` when the change holds no judgement, and the service merges it after a `READY` review:

- comments or wording inside non-Markdown files, with no behaviour change
- dependency bump or lockfile refresh
- formatting, lint autofix, or generated file refresh
- changelog or version bump

Never add the label to a change a reviewer must judge: source behaviour, public API, configuration, CI workflow, authentication, authorization, payments, data handling, or user-visible copy. When unsure, leave it off. A missing label costs one human merge. A wrong label ships an unreviewed change.

Read [references/auto-merge.md](../../references/auto-merge.md) for the exact conditions.

```bash
gh label create harlan-agent-auto-merge --color 0e8a16 --description "Lets harlan-github-agent merge this after a READY review" 2>/dev/null || true
gh pr edit NUMBER --add-label harlan-agent-auto-merge
```

Pass `--label harlan-agent-auto-merge` to `gh pr create` instead when the label already exists. Remove it with `gh pr edit NUMBER --remove-label harlan-agent-auto-merge` when the pull request grows past the change it was added for.

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

### Screenshots

A visible change earns a picture, in that same comment. GitHub only accepts a pasted image through the web UI, so upload the file first and embed the URL it prints:

```bash
"${CLAUDE_SKILL_DIR}/../../scripts/pr-asset.sh" .playwright/after.png
# https://pr.harlanzw.com/<repo>/<branch>/after.png
```

The key is `<repo>/<branch>/<filename>`, so a rerun on the same branch replaces the image and the comment keeps working. The edge caches it for 5 minutes, so a replaced image can take that long to show. `~/.config/harlan-agent-kit/pr-assets.env` holds the bucket and its public host. Without that file the script exits 2 and says what is missing; post the comment without the image rather than blocking the PR.

Take the picture before you need it: [nuxt-frontend-review](../nuxt-frontend-review/SKILL.md) already captures the running page. Two images beat one, labelled `Before` and `After`:

```markdown
| Before | After |
| --- | --- |
| ![before](https://pr.harlanzw.com/nuxt-seo/fix-og-image/before.png) | ![after](https://pr.harlanzw.com/nuxt-seo/fix-og-image/after.png) |
```

Only for a change someone can see: a page, a component, a CLI frame, a rendered email. Never a screenshot of passing tests or a green terminal.

The bucket expires objects after 90 days, so a picture on a very old pull request goes blank. Nothing to clean up by hand, and [close-off](../close-off/SKILL.md) leaves the bucket alone: a merged pull request stays readable while anyone is still likely to open it.

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

`../take-ownership/SKILL.md` wraps this workflow when one agent owns the current work through delivery verification.
