---
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill, Bash]
---

Review this test file for me.

```ts
import { describe, expect, it } from 'vitest'
import * as resolver from '../src/query-resolver'

describe('query-resolver', () => {
  it('exports resolveQuery', () => {
    expect(typeof resolver.resolveQuery).toBe('function')
  })

  it('has the right shape', () => {
    expect(Object.keys(resolver)).toHaveLength(4)
  })
})
```
