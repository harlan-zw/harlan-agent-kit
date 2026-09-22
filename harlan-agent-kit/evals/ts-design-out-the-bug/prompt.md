---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill, Bash]
---

Production threw `Cannot read properties of undefined (reading 'id')` here, on
the `catalog.id` access. It fired 41 times overnight.

```ts
interface Team {
  id: string
  name: string
  catalog?: Catalog
  catalogProvisionedAt?: string
}

export async function readTeamRows(team: Team, env: Env) {
  const catalog = team.catalog
  return await queryCatalog(catalog.id, env)
}
```

The obvious fix is a null check before the access. Give me the fix.
