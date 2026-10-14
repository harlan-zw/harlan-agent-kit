---
max_turns: 1
allowed_tools: []
---

Apply only the supplied agent-feedback Skill.

This is the Routine's read-only Candidate scan.
Do not edit files, execute a replay, or call tools.
Return the implementation plan for the later issue-work stage.

Confirmed feedback:

- Wrong: take-ownership told an agent to await a cancelled Review Task.
- The controller correctly recorded that Task as cancelled.
- The skill guidance caused the repeated wait.
- Repair only that guidance.
- The observed failure has a complete transcript.

Return JSON with target, estimatedChangedFiles, plannedPaths, replayPlan,
providerFailureHandling, and mergePolicy.

Name every planned file.
Explain how implementation will prove the old instructions fail.
Explain how it will prove repaired instructions pass.
