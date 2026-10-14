---
max_turns: 12
allowed_tools: [Read, Glob, Grep, Skill]
---

Use plan-ceo to review this bug-fix plan. Hold the existing scope.
An exported parser currently returns Ok for an empty identifier.
We will reproduce that failure, parse identifiers at the boundary, and return a tagged Err for empty input.
Callers already handle that Err. Do not implement. Do not expand product scope.
Use only the supplied plan. Flag assumptions that need code evidence.
