---
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---

I am opening a pull request. It changes the queue consumer, the job dispatcher,
and the per-user D1 provisioner, so a sync failure now releases the job instead
of failing it. Three modules and a retry sequence. Write the description.
