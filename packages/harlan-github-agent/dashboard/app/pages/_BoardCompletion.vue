<script setup lang="ts">
import type { CompletionTask } from '../../../src/take-ownership-store.ts'

const { tasks } = defineProps<{ tasks: CompletionTask[] }>()
const needsAction = computed(() => tasks.some(task => task.state._tag === 'ActionRequired'))
const states = {
  Queued: { label: 'Waiting for delivery checks', tone: 'neutral' },
  Running: { label: 'Checking delivery', tone: 'neutral' },
  Completed: { label: 'Completed', tone: 'success' },
  ActionRequired: { label: 'Action required', tone: 'error' },
} as const
</script>

<template>
  <details :open="needsAction" class="group/completion shrink-0 rounded-md border border-default bg-elevated">
    <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
      <span>Take Ownership</span>
      <StateBadge v-if="needsAction" tone="error" label="Action required" />
      <UIcon name="i-octicon-chevron-right-16" class="ms-auto size-4 text-dimmed group-open/completion:rotate-90" aria-hidden="true" />
    </summary>
    <ul class="max-h-64 divide-y divide-muted overflow-y-auto border-t border-default">
      <li v-for="task in tasks" :key="task.id" class="px-3 py-2">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
          <a class="entity-link font-medium" :href="`https://github.com/${task.repository}/pull/${task.target.pullRequestNumber}`">
            {{ task.repository }} #{{ task.target.pullRequestNumber }}
          </a>
          <StateBadge :tone="states[task.state._tag].tone" :label="states[task.state._tag].label" />
          <code class="text-xs text-muted">{{ task.target.mergeSha.slice(0, 7) }}</code>
        </div>
        <div v-if="task.state._tag === 'ActionRequired'" class="flex flex-wrap items-baseline gap-x-3 gap-y-1 break-words text-sm text-muted">
          <span>{{ task.state.reason }}</span>
          <a v-if="task.state.workflowUrl" class="entity-link" :href="task.state.workflowUrl">View workflow run</a>
        </div>
        <div v-else-if="task.state._tag === 'Completed'" class="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted">
          <a v-for="workflow in task.state.evidence.workflows" :key="workflow.url" class="entity-link" :href="workflow.url">
            {{ workflow.name }}
          </a>
          <a v-for="smoke in task.state.evidence.smoke" :key="smoke.url" class="entity-link break-all" :href="smoke.url">
            {{ smoke.url }} · HTTP {{ smoke.status }}
          </a>
        </div>
        <p v-else-if="task.state._tag === 'Queued' && task.state.reason" class="break-words text-sm text-muted">
          {{ task.state.reason }}
        </p>
      </li>
    </ul>
  </details>
</template>
