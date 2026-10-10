<script setup lang="ts">
import { githubRateLimitRow } from '../../utils/system.ts'

const { snapshot, now } = useDashboard()
const rows = computed(() => snapshot.value.githubRateLimits.map(hold => githubRateLimitRow(hold, now.value)))
</script>

<template>
  <section aria-labelledby="system-github">
    <h3 id="system-github" class="text-base font-medium">
      GitHub rate limits
    </h3>
    <ul v-if="rows.length > 0" class="mt-3 divide-y divide-default border-y border-default">
      <li v-for="row in rows" :key="`${row.credential}:${row.owner}`" class="space-y-2 py-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <span class="break-all font-medium">{{ row.owner }}</span>
          <StateBadge tone="warning" :label="row.limit" />
        </div>
        <p class="text-sm text-muted">
          {{ row.credential }}
        </p>
        <p class="font-mono text-sm">
          {{ row.retry }}
        </p>
        <p class="text-sm">
          {{ row.detail }}
        </p>
        <p class="text-sm text-muted">
          Retry after <time :datetime="row.retryAt">{{ row.deadline }}</time>
        </p>
      </li>
    </ul>
    <p v-else-if="snapshot.generatedAt.length === 0" class="mt-2 text-sm text-muted">
      Checking GitHub rate limits.
    </p>
    <p v-else class="mt-2 text-sm text-muted">
      No controller GitHub requests paused.
    </p>
  </section>
</template>
