---
name: issue-triage
description: Triage open issues by difficulty and impact. Use when user says "review issues", "triage issues", "what should I work on", "prioritize backlog", "rank issues", "find quick wins", or "what's high priority".
user_invocable: true
context: fork
---

Triage all open issues and rank by difficulty/impact.

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

3. **Parallel batch analysis** (8-10x faster than sequential)
   Split issues into batches of 10 and spawn parallel haiku agents.
   If <=10 issues, use a single agent.

   See [references/heuristics.md](references/heuristics.md) for the full difficulty/impact scales and signal weighting.

   ```
   # Spawn Task agents IN PARALLEL (single message, multiple tool calls)
   Task(model: haiku, prompt: "Analyze these issues: [JSON]. Return JSON array with: number, difficulty (1-5), impact (1-5), hasRepro (bool), needsCodebaseReview (bool), notes")
   ```

4. **Merge results** from all agents into unified list

5. **Display table** sorted by: has repro (yes first), then impact/difficulty ratio (descending)

   | # | Title | Labels | Repro | Diff | Impact | Assigned | Notes |
   |---|-------|--------|-------|------|--------|----------|-------|
   | 42 | Fix CSS regression | bug | yes | 1 | 3 | | 1-line fix |
   | 17 | Add dark mode | enhancement | n/a | 2 | 4 | @dev | PR in progress |

6. **Highlight quick wins** -- low difficulty (1-2), decent impact (2+)

7. **Highlight high priorities** -- impact 4-5 regardless of difficulty

8. **Offer worktree setup** -- prompt user with options:
   - "Create worktrees for quick wins (difficulty 1-2, impact 2+)?"
   - "Create worktrees for high priorities (impact 4-5)?"
   - "Pick specific issues by number?"

   For each selected issue, create an isolated worktree using `wt` (git worktree manager):
   ```bash
   wt switch --create fix/<number>-<slug>
   ```
   Where `<slug>` is a kebab-case short title (first 4-5 words). `wt switch --create` creates a new branch + worktree from current HEAD.

   After creation, list worktrees with `wt list` so user can open them in separate sessions.
