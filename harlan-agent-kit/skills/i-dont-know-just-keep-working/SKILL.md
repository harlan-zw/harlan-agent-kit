---
name: i-dont-know-just-keep-working
description: "Find related gaps, opportunities, bugs, and improvements around current work. Use for what's next, anything else worth doing, related improvements, or zooming out after a task. Rank evidence-backed next steps by impact, effort, and confidence."
user_invocable: true
argument-hint: "[current work or related area]"
license: MIT
compatibility: "Designed for Harlan Agent Kit workflows. Requires repository access and the tools named in this Skill."
---

# I Don't Know, Just Keep Working

Find worthwhile changes around the current task. Inspect evidence before proposing work.

## Resolve the request

Use the conversation and `$ARGUMENTS` to resolve the current task, intended result, and relevant repositories.
Read applicable Agent instructions, `VISION.md`, and the current work brief when present.
Preserve explicit exclusions, deferrals, impact thresholds, and action authority.

For a bare "what's next", check unfinished promises and delivery before proposing expansion.
Use [take-ownership](../take-ownership/SKILL.md) for required delivery, completion, or cleanup.
Keep those required steps ahead of optional improvements.

Use [issue-triage](../issue-triage/SKILL.md) when the request is to rank the open issue backlog.
Use [plan-ceo](../plan-ceo/SKILL.md) when a selected proposal needs a product or scope decision.

Ask only when plausible targets mean materially different work. Otherwise state the target and proceed.

## Authority

An expansion request authorizes investigation and recommendations.
It does not by itself authorize implementation, publication, or unrelated changes.
Earlier explicit action authority remains valid. Do not ask again for work already authorized.

If the user also requests implementation, proceed with the selected work within that authority.
Follow the relevant domain Skill and [worktree isolation contract](../../references/worktree-isolation.md).
Use [pr](../pr/SKILL.md) for repository changes. Merge and publication retain their existing rules.

## Inspect one adjacent area

Start from the changed behavior, current findings, or evidence named by the user.
Inspect the nearest relevant consumers, call sites, equivalent paths, tests, and documentation.
Use saved logs, eval traces, measurements, or review findings when they relate to this task.
Read current code or remote state before treating a historical finding as still open.

Look for:

- Other instances of the same defect or an incomplete repair.
- Missing failure handling, misleading success checks, or untested critical paths.
- Related UX or API gaps that impede the intended result.
- Duplicate work, unnecessary cost, or measured performance limits.
- Useful capabilities that the current change makes practical.

Choose relevant categories. Do not run every domain audit or sweep the whole repository by default.
Widen the area only when the user requests it or evidence points to a shared cause.
Stop after one bounded pass unless an unresolved finding needs a specific check.

## Challenge each candidate

For each candidate, identify the concrete trigger, affected user or consumer, and evidence.
Separate a reproduced bug from a suspected gap or a proposed improvement.
Check whether existing code or another work item already solves it.
Check hidden effort: dependencies, migration, public API changes, verification, and rollout.
Try to disprove the benefit and the proposed approach before ranking it.

Drop duplicates, solved findings, style preferences, and proposals that conflict with explicit scope.
If proof is missing, recommend the smallest useful investigation and name the uncertainty.
Do not invent measurements or inflate a score to clear a threshold.

## Rank next steps

Return up to five evidence-backed next steps. Use fewer when fewer survive the challenge.

| Next step | Impact /100 | Effort S/M/L | Confidence /100 | Why |
| --- | --- | --- | --- | --- |

Score each candidate against the current task:

- **Impact:** concrete benefit or avoided harm. State which one the score measures.
  Use 81–100 for major benefit or harm, 51–80 for meaningful local benefit, and 1–50 for limited benefit.
  Treat scores as estimates. Support them with affected paths, reach, frequency, or measured cost.
- **Effort:** include implementation, verification, and rollout.
  S means one focused change. M means several related changes. L means broad or uncertain work.
- **Confidence:** confidence in the finding and proposed next step, based on checks actually performed.
  Name missing evidence in the reason. Source inspection alone cannot prove runtime behavior.

Respect required work and dependencies first. Then prefer high impact and low effort.
Do not divide impact by S/M/L or present a calculated return without real cost data.
Apply a numeric action threshold only when the user or the relevant domain contract supplies one.

Give each row one short reason with evidence or the missing check. Link detailed proof when useful.
Recommend the first action and state why it comes first.
If no worthwhile expansion survives, say so. Do not manufacture a next task.

Keep the reply concise. For a detailed report, follow the user's note and diagram preferences.
End with confidence in the assessment. Name untested paths when required by Agent instructions.
When implementing selected work, report verification-based completion confidence separately.
