---
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill, Bash]
---

Is this type any good?

```ts
interface SyncResult {
  ok: boolean
  rows?: number
  error?: string
  retryable?: boolean
}

async function sync(siteId: string): Promise<SyncResult> {
  const res = await fetchRows(siteId).catch(() => null)
  if (!res)
    return { ok: false, error: 'failed' }
  return { ok: true, rows: res.length }
}
```
