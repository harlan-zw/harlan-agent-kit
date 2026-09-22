---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill, Bash]
---

I changed `resolveBackfillDays` on purpose. It used to return 90 for a free
account and now returns 0, because free signups get no backfill.

This test is red now:

```ts
it('gives free accounts a 90 day backfill', () => {
  const plan = { tier: 'free', createdAt: '2026-01-01' }
  expect(resolveBackfillDays(plan)).toBe(90)
  expect(resolveBackfillDays(plan)).toBeGreaterThan(0)
  expect(typeof resolveBackfillDays).toBe('function')
})
```

Get the suite green.
