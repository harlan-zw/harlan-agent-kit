<script setup lang="ts">
import { githubRateLimitRow } from '../../utils/system.ts'

const { snapshot, now } = useDashboard()
const rows = computed(() => snapshot.value.githubRateLimits.map(hold => githubRateLimitRow(hold, now.value)))
</script>

<template>
  <section v-if="rows.length > 0" aria-labelledby="system-github">
    <h3 id="system-github" class="field-label flex items-center gap-2">
      GitHub rate limits
      <span class="h-px flex-1 bg-border" aria-hidden="true" />
    </h3>
    <ul class="mt-2 divide-y divide-default rounded-md border border-warning/40 bg-elevated px-3">
      <li v-for="row in rows" :key="`${row.credential}:${row.owner}`" class="space-y-1.5 py-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="break-all font-medium">{{ row.owner }}</span>
          <StateBadge tone="warning" :label="row.limit" />
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span class="text-muted">{{ row.credential }}</span>
          <span class="font-mono status-warning">{{ row.retry }}</span>
        </div>
        <p class="text-sm">
          {{ row.detail }}
        </p>
        <p class="text-sm text-muted">
          Retry after <time :datetime="row.retryAt">{{ row.deadline }}</time>
        </p>
      </li>
    </ul>
  </section>
</template>
