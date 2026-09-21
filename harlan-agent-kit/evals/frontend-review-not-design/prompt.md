---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill]
---

Review this Nuxt UI v4 component before I merge it. Pick apart the contract and
the UX. Do not redesign it.

```vue
<script setup lang="ts">
const { data } = await useFetch('/api/sites')
</script>

<template>
  <div>
    <UButton @click="$emit('refresh')">Refresh</UButton>
    <div v-for="s in data" :key="s.id">{{ s.host }}</div>
  </div>
</template>
```

You have no shell in this run. List the findings.
