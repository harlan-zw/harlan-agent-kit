---
max_turns: 10
allowed_tools: [Read, Glob, Grep, Skill, Bash]
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

List the findings.

Finish with a short numbered list of the blocking defects, so your last
message carries the findings.
