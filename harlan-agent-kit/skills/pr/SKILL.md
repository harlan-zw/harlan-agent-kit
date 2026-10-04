---
name: pr
description: "Create or update a pull request from current work. Use when work should be branched, committed, pushed, submitted, shipped, or landed on an owned repository, and whenever a pull request title or description is written or revised, even if nothing is pushed."
user_invocable: true
---

Create or update a pull request for the current branch. Idempotent -- safe to run at any stage.

## No direct pushes

Every change opens a pull request. Markdown is no exception: a Skill or instruction file changes agent behaviour in every repository, and a README change still earns a review. Never push to `origin/main` directly.

A Markdown-only pull request runs no CI unless a workflow event uses `paths` to include that Markdown. Its review is the whole gate, so treat the review outcome as the check.

## When to invoke

Invoke on intent, not on phrasing. If the next command you are about to run is `git switch -c`, `git commit`, `git push`, or `gh pr create`, stop: this skill owns that sequence. Run it instead of the raw commands.

None of these are reasons to skip it:

- **The user never said "PR".** Once a fix is written and verified, "fix", "ship it", "land this", or a bare "yes" all mean land it. The trigger list in the description is examples, not a required wording.
- **The change is small.** A one-line fix or a docs edit still needs the repo's template, the AI disclosure, a body with no verification section, and green CI. Size changes none of that.
- **Invoking costs a turn.** Rewriting a hand-made PR body costs more, and a PR pushed without Step 4 can fail CI in front of a reviewer.
- **You already ran the git commands.** Then a PR exists and is probably wrong. Re-enter here anyway -- Step 1 detects the existing PR and Step 5 syncs it in place.

Running the git and `gh` commands by hand is the failure mode this skill exists to prevent.

## Gotchas

- **Never amend published commits** -- CI and reviewers lose context. Always fix-forward with new commits.
- **Never `--force` push** during a PR -- rewrites shared history. Use `git push` (regular) after new commits.
- **Never sync a clean pull request with its base branch:** A newer base alone needs no pull request commit.
  Merge the base into the head only when GitHub reports merge conflicts.
- **Never `--no-verify`** -- if hooks fail, fix the underlying issue.
- **`gh pr merge` refuses a pull request that has a child** -- GitHub asks for the stack merge. Use `gh stack merge`, and expect a child to turn CONFLICTING when its parent squash merges alone. Repair steps in [references/stacked-prs.md](references/stacked-prs.md).
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

Keep the primary checkout read only. Mutate only in this task's `wt` worktree with a live claim.
Use `origin/main` for independent work, or the intended parent ref for stacked work.
Read the absolute worktree `path` from `wt list --format=json` and use it for every later command.
The shared contract owns creation, acquisition, renewal, and cleanup.

If this task's changes already exist in the primary checkout, leave that checkout untouched. List every verified task-owned path. Export `git diff --cached --binary -- PATHS` and `git diff --binary -- PATHS` separately. Apply the cached patch with `git apply --index`, then apply the unstaged patch. Copy owned untracked files individually. Compare every owned source path with its destination before continuing. Never reset, clean, stash, or overwrite the source checkout.

Never share a mutation worktree between tasks. Never use `wt switch --clobber` to resolve a path collision.

## Step 1: Detect State

Run IN PARALLEL:

```
Bash: git log main..HEAD --oneline
Bash: git diff main...HEAD --stat
Bash: gh issue list --state open --limit 20 --json number,title
Bash: gh pr list --state open --limit 20 --json number,title,headRefName,baseRefName
Bash: gh pr view --json number,title,body,url 2>&1
```

Determine what exists:
- **No commits ahead of main** and **no uncommitted changes** -> nothing to do, tell user
- **PR exists** -> we're syncing title/body, skip to Step 4
- **No PR** -> creating fresh, continue to Step 2

### Stacked work

Read the open pull requests. If this change does not build, pass, or make sense without one of their diffs, it is stacked work: base the branch on that pull request in Step 0 and target it in Step 5.

Related but independent work is not stacked work. It targets `origin/main`, even when it touches the same files or closes a sibling issue. Independent pull requests merge in parallel; a stack merges in order and every child waits for its parent.

[references/stacked-prs.md](references/stacked-prs.md) has the `gh stack` commands, the ones this skill bans, and the merge and repair steps.

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
- **Length follows risk.** A fix gets 1 to 3 sentences. Spend more only where a reviewer must understand a behaviour change, a data migration, or a non-obvious tradeoff.
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

### Diagram

Before writing the description, decide whether the change earns a diagram. Read the [pr-lens skill](../pr-lens/SKILL.md) and use its threshold: three or more modules, a crossed boundary, or a sequence a reviewer must follow. If it qualifies, author and render the graph document there, then reference the top architecture view from the description with a Markdown image and pass the same path to `--attach` on `gh pr create` or `gh pr edit`. One view is normal. Two is the ceiling unless the change is a large refactor.

A diagram goes in the description, after the why and before the AI disclosure. Never in a trailing comment.

Before pushing, load the installed Brundlefly `write-human` Skill for the title and description.
Preserve this Skill's body rules, template, and disclosure.

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

Run `check` before pushing (lint, typecheck, tests). Add `pnpm build` when the package publishes a build. Fix any failures before proceeding.

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

For stacked work, add `--base PARENT_BRANCH` to `gh pr create`, then link it with `gh stack link` as the reference says: it only appends to the top of a stack. Open the description with `Stacked on #PARENT_PR.` Read [references/stacked-prs.md](references/stacked-prs.md) before either command.

When Step 3 rendered a diagram, add `--attach .pr-lens/<view>-dark-<hash>.svg` for each image the body references. GitHub CLI rewrites the Markdown path to the uploaded asset.

Record the pull request URL. Continue to Step 6 after creation or update.
Log the URL to `${CLAUDE_PLUGIN_DATA}/pr-history.log`.

For an Agent-submitted pull request in a repository tracked by `harlan-github-agent`, add `harlan-agent-review`.
This requests Review in Manual Selection mode and prevents prose classification from skipping it in Auto mode.
Read the matching Service Item with its authenticated `/api/items/pull-request-status?repository=OWNER%2FREPO&number=NUMBER` endpoint.
If it returns `dismissed: true`, leave the request label unset and report the Dismissal to Harlan.
A Dismissal survives new head commits.
If this step just created the pull request, a 404 can mean the Service has not observed it yet.
Add the Review request label, then wait for exact Item status before any fallback Review.
For an existing pull request, retry a 404 after the next Service observation.
Report a continuing 404 as missing Service state. For other responses, require `dismissed: false` before adding the label.
If the label is absent, create it with `gh label create harlan-agent-review --color 8250df --description "Requests automated Review and repair"`.
Then add it to the pull request:

```bash
HARLAN_AGENT_PR_SKILL=1 gh pr edit NUMBER --add-label harlan-agent-review
```

Record the UTC time of this Review request for the current head SHA in the session scratchpad.
Reset that time after every later push that changes the head.
Do not add the label to an outside contributor's pull request. Never treat the label as a Review outcome.

### Let the agent merge it

`harlan-github-agent` reviews every pull request it tracks. Add `harlan-agent-auto-merge` when the change holds no judgement, and the service merges it after a `READY` review:

- comments or wording inside non-Markdown files, with no behaviour change
- Markdown that nothing executes: a README, docs, or a blog post
- dependency bump or lockfile refresh
- formatting, lint autofix, or generated file refresh
- changelog or version bump

Never add the label to a change a reviewer must judge: source behaviour, public API, configuration, CI workflow, authentication, authorization, payments, data handling, or user-visible copy. Markdown an agent reads as instructions counts as source behaviour: Skills, `agent-context/`, `CLAUDE.md`, `AGENTS.md`, `GLOSSARY.md`, and `.github` templates. When unsure, leave it off. A missing label costs one human merge. A wrong label ships an unreviewed change.

Read [references/auto-merge.md](../../references/auto-merge.md) for the exact conditions. A repository whose service block sets `auto_merge.pull_requests: every` needs no label; the service merges every trusted pull request there after a `READY` review at that repository's minimum confidence.

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

### Screenshots and video

For a visible change, read and follow [media](references/media.md) before capture, inspection, or upload.
Keep verification evidence in a self-identified Agent comment. Do not attach screenshots of passing checks.

## Step 6: Wait for CI and Review

Keep ownership after submitting or updating the pull request. Complete this step for the **current head SHA**.
Green CI alone does not finish an Agent-submitted pull request tracked by `harlan-github-agent`.
If the Service controller publishes the pull request from an implementation Agent's result, that Agent returns first.
The controller owns Review, Repair, and this wait; waiting inside its implementation Task would stop Review from starting.

1. Read the current head SHA with `gh pr view NUMBER --json headRefOid --jq .headRefOid`.
2. Wait for GitHub Actions check runs. Use `gh run list --commit HEAD_SHA --limit 100` to find this head's runs.
   Use `gh run watch RUN_ID` for each pending run, then confirm every applicable run passed.
   Do not use `gh pr checks --watch` while Review is queued; the service's own check run can keep it waiting.
   A Markdown-only pull request may have no check runs. Confirm that its workflows exclude the changed paths.
3. Read the trusted `harlan-github-agent` marked comment and matching Review outcome label.
   Read issue comments with `gh api repos/OWNER/REPO/issues/NUMBER/comments --paginate`.
   Match `<!-- harlan-agent-kit:pr-triage -->` and `<!-- reviewed-sha: HEAD_SHA -->`.
   Trust only the GitHub App or a repository owner, member, or collaborator, as the [review contract](../adversarial-review/references/review-contract.md) requires.
   `REVIEWING` and `harlan-agent-review-required` mean Review has not finished.
   `harlan-agent-review-skipped` does not satisfy an Agent-submitted pull request. Confirm the Review request was recorded and wait for Review.
   The service may consume the request label before it posts the outcome.
   If Review is `QUEUED`, or no current-head Task appears, check capacity and elapsed time before waiting again.
   Respect a trusted `PAUSED`, stopped, or cancelled Review. Do not start another review for that head.
4. Read every finding in the terminal comment, plus other review and inline comments:
   ```bash
   gh pr view NUMBER --json reviews,comments --jq '.reviews[].body, .comments[].body'
   gh api repos/OWNER/REPO/pulls/NUMBER/comments --paginate --jq '.[].body'
   ```
5. Read each scored finding from `/api/reviews?repository=OWNER%2FREPO&pull_request=NUMBER`.
   Leave findings at 80/100 or below Logged. They do not require a code change.
   If the resolution is `Dismissal`, report the `BLOCKED` outcome and ask Harlan to decide whether to Dismiss the pull request.
   Do not repair or request another Review for a Dismissal finding.
   Act on findings with resolution `Repair`. If the service owns a current-head Repair Task, let it finish before editing.
   This includes `Queued`, `Running`, and `Publishing` Tasks. If its Queue is saturated, hand off to that durable Task.
   Otherwise reproduce the finding, fix it in this task's worktree, run focused checks, commit, and push.
   If a finding is false positive or not applicable, post one self-identified Agent comment naming the finding, its classification, and concrete evidence.
   That comment cannot change the service outcome. Ask Harlan to decide whether to dismiss or rerun the Review.
   Do not change the marked comment or Review outcome label yourself. A `BLOCKED` outcome remains blocked until the service publishes a new outcome.
6. After a push by the submitting Agent, check the targeted Service Item endpoint for Dismissal again.
   If dismissed, report it and stop. Otherwise add `harlan-agent-review` for the new head and record a new Review request time.
   The Service consumes that label per head in Manual Selection mode. Then restart at step 1.
   A Service Repair commit keeps its own Approval; do not add the label for that commit.
   Never reuse CI or Review evidence from the old head SHA.
   Report success only when current-head CI passes or is correctly absent, the current-head Service Review is `READY` or a stopped Service Review has a completed subagent assessment, and other material comments are handled.
   If a finding remains `BLOCKED` after an evidence-backed false positive or not applicable comment, report that outcome and the comment link.

Count review-driven repair pushes by this submitting Agent across the entire pull request.
After three, stop Agent-authored refinements and report remaining findings above 80/100 to Harlan.
Do not reset the count because a new head commit starts a new Review. CI repair attempts keep their separate limit below.
At that limit, do not start another fallback subagent Review.
If an active Service Review Task owns the current head, hand off to that Task.
If its Review is stopped, report the stopped Review and outstanding human decision. Never wait for a cancelled Task.

### Review queue capacity

If Review is queued or its current-head Task is missing, read and follow [Review queue capacity](references/review-queue.md).
That Reference owns the capacity snapshot, fallback thresholds, exact-head stop, and independent subagent assessment.
Never delegate fallback Review before its stop and authority checks pass.
A stopped exact-head Review stays stopped. Report the independent assessment separately from Service `READY`.

Fix CI failures from the failing check logs (`gh run view RUN_ID --log-failed`).
Use new commits, never amend published commits. After three failed repairs for one cause, ask the user for guidance.
If the service cannot publish Review, report the exact blocker and keep the pull request open.
For a repository the service does not track, use CI and the available reviewers; state that automated Review was unavailable.

Do not post replies to other reviewers without approval. Draft a reply for a question or non-actionable comment and show it to the user.

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
