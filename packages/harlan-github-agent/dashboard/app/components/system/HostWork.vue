<script setup lang="ts">
import type { RunnerJobs } from '../../../../src/runner-jobs.ts'
import type { hostTasks } from '../../utils/host-tasks.ts'
import { formatElapsed } from '../../utils/system.ts'

const { tasks, tasksAvailable, jobs, now } = defineProps<{
  tasks: ReturnType<typeof hostTasks>
  tasksAvailable: boolean
  jobs: RunnerJobs
  now: Date
}>()

const showTasks = computed(() => !tasksAvailable || tasks.length > 0)
const showJobs = computed(() => jobs._tag === 'Unavailable' || jobs.jobs.length > 0)
</script>

<template>
  <div v-if="showTasks || showJobs" class="mt-3 space-y-3 border-t border-default pt-3 text-sm">
    <div v-if="showTasks">
      <h5 class="field-label">
        Running Agents
      </h5>
      <p v-if="!tasksAvailable" class="mt-1.5 text-muted">
        Task details unavailable.
      </p>
      <ul v-else class="mt-1.5 divide-y divide-default">
        <li v-for="task in tasks" :key="task.id" class="py-2 first:pt-0 last:pb-0">
          <div class="flex items-baseline justify-between gap-2">
            <a v-if="task.url" :href="task.url" target="_blank" rel="noopener noreferrer" class="entity-link break-words font-medium">{{ task.title }}</a>
            <span v-else class="break-words font-medium">{{ task.title }}</span>
            <span class="shrink-0 font-mono text-muted">{{ task.progress }}</span>
          </div>
          <p v-if="task.detail" class="mt-0.5 break-words text-muted">
            {{ task.detail }}
          </p>
        </li>
      </ul>
    </div>
    <div v-if="showJobs">
      <h5 class="field-label">
        Running GitHub Actions
      </h5>
      <p v-if="jobs._tag === 'Unavailable'" class="mt-1.5 text-muted">
        Job details unavailable.
      </p>
      <ul v-else class="mt-1.5 divide-y divide-default">
        <li v-for="job in jobs.jobs" :key="job.runner" class="py-2 first:pt-0 last:pb-0">
          <div class="flex items-baseline justify-between gap-2">
            <span class="break-words font-medium">{{ job.name }}</span>
            <span v-if="job.startedAt > 0" class="shrink-0 font-mono text-muted">{{ formatElapsed(job.startedAt, now) }}</span>
          </div>
          <a :href="`https://github.com/${job.repository}/actions`" target="_blank" rel="noopener noreferrer" class="entity-link mt-0.5 inline-block break-words text-muted">{{ job.repository }} ↗</a>
        </li>
      </ul>
    </div>
  </div>
</template>
