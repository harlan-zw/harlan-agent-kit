---
name: issue-triage
description: "Prioritize open issues by impact and difficulty. Use for backlog review, quick wins, or deciding what to work on next."
user_invocable: true
context: fork
---

Triage all open issues and rank by difficulty/impact.

## Worktree isolation

Before follow-on edits, follow the [worktree isolation contract](../../references/worktree-isolation.md). It provides the atomic live-agent claim used below.

An existing worktree alone does not prove another agent is active.

`wt` is the only worktree tool. Never run `git worktree add`, and never use a harness worktree option such as `EnterWorktree` or `isolation: "worktree"`. Those write to `.claude/worktrees/`, which is banned. `wt` places every worktree at `<parent>/<repo>.<branch-slug>`.

Triage stays read only and may use the primary checkout. Every follow-on implementation uses a task-owned worktree. Run `wt list --format=json`. Reuse the task's worktree with `wt switch <branch>`, or create one with `wt switch --create <branch> --base <base>`. Read its absolute `path` from the JSON, then pass that path as `workdir` to every later command.

## Gotchas

- **GitHub API rate limits** -- `gh issue list` with `--limit 100`+ can hit rate limits on busy repos. If you get a 403, reduce the batch size or add `--label` filters.
- **Stale issues** -- issues older than 6 months with no recent activity are likely stale. Flag them separately rather than ranking alongside active issues.
- **Misleading labels** -- "good first issue" doesn't always mean low difficulty. Cross-check against the actual description before trusting the label.
- **Body truncation** -- `gh issue list --json body` truncates long bodies. For issues that need deeper analysis, fetch individually: `gh issue view NUMBER --json body`.
- **Duplicate issues** -- watch for multiple issues describing the same root cause. Group them and note the canonical issue number.
- **Assigned != in progress** -- stale assignments are common. Check if the assignee has recent activity on the issue before skipping it.

## Data Storage

Track triage history to show deltas between runs:

```bash
# After triage, save results
echo "$(date -I) REPO TOTAL_ISSUES QUICK_WINS HIGH_PRIORITY" >> "${CLAUDE_PLUGIN_DATA}/triage-history.log"
```

On subsequent runs, read the log and highlight what changed since last triage.

## Workflow

1. **Determine repo and filters**
   - If `$ARGUMENTS` provided, parse it:
     - Bare value = repo name (e.g., `nuxt/nuxt`)
     - `--label <name>` = filter by label
     - `--limit <n>` = override default 100
   - Otherwise auto-detect: `gh repo view --json nameWithOwner -q .nameWithOwner`

2. **Fetch all open issues**
   ```bash
   gh issue list --repo <repo> --state open --limit <limit> --json number,title,labels,body,createdAt,author,comments,assignees
   ```

3. **Parallel batch analysis**
   Split issues into batches of 10 and spawn parallel `haiku` classification agents (one per batch). Classification is cheap, mechanical extraction — `haiku` is the right tier. If <=10 issues, use a single agent.

   For a large backlog (50+ issues), drive this with the **Workflow tool**: `pipeline` the batches through a classify stage (schema below) then a verify stage, so the schema is enforced and the verify pass runs per batch as it completes. This skill's instructions are the opt-in.

   See [references/heuristics.md](references/heuristics.md) for the full difficulty/impact scales and signal weighting.

   Each agent returns a JSON array. Every entry has this shape. Reject and rerun malformed batches.
   ```json
   { "number": 123, "difficulty": 2, "impact": 4, "hasRepro": true, "needsCodebaseReview": false, "notes": "Short reason." }
   ```

4. **Merge results** from all agents into unified list.

5. **Adversarially verify the candidate quick wins.** A wrong "difficulty 1, impact 4" recommendation costs the user a wasted worktree, so before presenting, spawn a `haiku` verifier per issue scored difficulty 1-2 AND impact 3+. Prompt it to *refute* the score: "Read issue #N. Is this genuinely a <=2-difficulty change with 3+ impact, or is there hidden scope (migration, API surface, cross-cutting state)? Default to downgrading if uncertain." Demote any issue the verifier refutes. Skip this pass for backlogs where no issue clears the quick-win bar.

6. **Display table** sorted by: has repro (yes first), then impact/difficulty ratio (descending)

   | # | Title | Labels | Repro | Diff | Impact | Assigned | Notes |
   |---|-------|--------|-------|------|--------|----------|-------|
   | 42 | Fix CSS regression | bug | yes | 1 | 3 | | 1-line fix |
   | 17 | Add dark mode | enhancement | n/a | 2 | 4 | @dev | PR in progress |

7. **Highlight quick wins** -- low difficulty (1-2), impact 2+; those scored impact 3+ have survived the refutation pass

8. **Highlight high priorities** -- impact 4-5 regardless of difficulty

9. **Offer task setup for implementation** -- every selected issue uses a task-owned `wt` worktree. Prompt user with options:
   - "Create worktrees for quick wins (difficulty 1-2, impact 2+)?"
   - "Create worktrees for high priorities (impact 4-5)?"
   - "Pick specific issues by number?"

   For each selected issue, create an isolated worktree using `wt`:
   ```bash
   wt switch --create fix/<number>-<slug> --base <base>
   ```
   Where `<slug>` is a kebab-case short title (first 4-5 words).

   After creation, run `wt list --format=json`. Give each agent the selected worktree's absolute `path`.
