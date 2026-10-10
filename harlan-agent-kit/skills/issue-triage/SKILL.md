---
name: issue-triage
description: "Prioritize open issues by impact and difficulty. Use for backlog review, quick wins, or deciding what to work on next."
context: fork
license: MIT
---

Triage all open issues and rank by difficulty/impact.

## Worktree isolation

Triage stays read only and may use the primary checkout.
Before follow-on implementation, read and follow the [worktree isolation contract](../../references/worktree-isolation.md).
Keep mutation in a task-owned `wt` worktree with a live claim. Keep the primary checkout read only.

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
   Split issues into batches of 10. This Skill permits read-only classification and verification delegation.
   Use the active provider's available agent tools and configured model policy. Do not require a specific model or orchestration tool.
   Bound parallel work by available slots. If delegation is unavailable, process the batches sequentially in this Agent.

   For 50+ issues, classify and verify each batch before combining results.
   Keep the same schema and verification stages in both parallel and sequential execution.

   See [references/heuristics.md](references/heuristics.md) for the full difficulty/impact scales and signal weighting.

   Each agent returns a JSON array. Every entry has this shape. Reject and rerun malformed batches.
   ```json
   { "number": 123, "difficulty": 2, "impact": 4, "hasRepro": true, "needsCodebaseReview": false, "notes": "Short reason." }
   ```

4. **Merge results** from all agents into unified list.

5. **Adversarially verify the candidate quick wins.** Verify every issue scored difficulty 1-2 AND impact 3+ before presenting.
   Use a separate read-only verifier when available. Otherwise run a separate refutation pass in this Agent.
   Ask it to refute the score: "Read issue #N. Does hidden scope invalidate this difficulty or impact score? Check migration, public API, and shared state. Downgrade uncertain scores."
   Demote any issue the verifier refutes. Skip this pass only when no issue clears the quick-win bar.

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
