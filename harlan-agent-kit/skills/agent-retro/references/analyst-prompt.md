# Analyst prompt

Send one analyst per goal group. Fill every `{placeholder}`. Send all analysts in one message so they run in parallel.

```text
You are analysing agent session transcripts for the goal group **{goal}** ({one line: what this role does and which Agent provider and model ran it}).

Directory: {run_dir}/{goal}/
- INDEX.md: group stats plus one JSON line per exported session (duration, tokens, tool counts).
- ses_*.md: one compact transcript per session. Format: header, USER PROMPT (the controller's prompt), then timestamped lines: `think:` (reasoning), `TOOL <name> (status exit=N): <input>` with an `out>` tail, `ASSISTANT:` text, PATCH lines, and a `## summary` with tool counts, repeated bash commands, and edited files.

Context to read first (read-only, do not edit anything):
- {skill path the role should embody}
- {controller file that builds the prompt for this role}
- You may query the journal on Hogwild read-only: ssh hogwild 'sqlite3 ~/.local/share/harlan-github-agent/state.sqlite "..."'. Never write to it.

Read every transcript in full. Then write a report to `REPORT.md` in that same directory and also return it. Structure, one page, plain words, short sentences:

1. **Sessions**: one line each: id, subject, duration, tokens in/out, outcome, one-phrase description of what it spent its time on.
2. **Redundant work within the group**: work repeated across sessions or within a session that the controller or prompt could supply once. Cite session id + timestamp for each claim.
3. **Waste and failure patterns**: tool errors, retries, long gaps, output-format failures, forbidden commands, wrong approaches. Cite evidence.
4. **Opportunities**, ranked by expected saving, each tagged `prompt` (controller prompt text), `skill` (SKILL.md), `controller` (service code), or `model` (model or reasoning choice). For each: what to change, why the evidence supports it, rough saving.
5. **Measurement gaps**: what you wanted to know that the export did not contain.

Do not speculate beyond the transcripts. If a transcript is incomplete, say so. Do not modify any file except REPORT.md.
```

## Group hints

| Goal | Role | Skill | Controller file | Extra hint |
| --- | --- | --- | --- | --- |
| adversarial_review | Review one PR head, read only, return findings JSON | `skills/adversarial-review/SKILL.md` | `src/review-worker.ts` (search `disproof`) | Flag forbidden full-suite commands |
| review_fix | Repair stored findings in a fresh worktree | `skills/harlan-github-agent/SKILL.md` Repair rules, `skills/unit-tests/SKILL.md` | `src/review-fix-worker.ts`, `src/repair-rounds.ts` | Check failing test first |
| resolve_conflict | Merge base into head, resolve, one commit | `skills/harlan-github-agent/SKILL.md` Resolve conflicts | `src/conflict-worker.ts` | Query `tasks` for repeated subjects |
| baseline_repair | Repair failing default branch CI, open a PR | same as above, Baseline repair | `src/baseline-repair-worker.ts` | Query `tasks` for Superseded rows |
| issue | Issue triage JSON, or Issue work draft PR | `skills/issue-triage/SKILL.md` | `src/issue-triage.ts`, `src/issue-work-worker.ts` | Classify each session by prompt |
| routine | Scheduled Routine runs | `skills/sentry-checkin/SKILL.md`, `skills/agent-feedback/SKILL.md` | `src/routine-worker.ts` | Compare the seven site runs |
| pull_request_triage | No-tool call: does this PR need Review | none | `src/pull-request-triage.ts` | Query `pull_request_triage_runs` for repeats |
