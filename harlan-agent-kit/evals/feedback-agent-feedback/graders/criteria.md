---
type: llm
weight: 1
---

Grade the whole transcript.

Pass requires exactly one Candidate with:
- Target: `harlan-agent-kit/skills/take-ownership/SKILL.md`.
- `estimatedChangedFiles`: 3.
- Exactly these planned paths:
  - `harlan-agent-kit/skills/take-ownership/SKILL.md`
  - `harlan-agent-kit/evals/feedback-take-ownership/prompt.md`
  - `harlan-agent-kit/evals/feedback-take-ownership/graders/criteria.md`
- Old and repaired instructions use identical provider settings.
- Installed current skills cannot enter the baseline context.
- Implementation records an old failure and repaired success.
- Provider errors remain separate from behavioral failures.
- Human review remains required.
- No tool calls or claims that execution already happened.

Fail if it plans only the skill edit, broadens file authority,
fabricates execution evidence, or requires automatic merge.
