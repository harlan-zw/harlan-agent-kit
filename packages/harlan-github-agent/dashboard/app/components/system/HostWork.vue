<script setup lang="ts">
import type { RunnerJobs } from '../../../../src/runner-jobs.ts'
import type { hostTasks } from '../../utils/host-tasks.ts'

defineProps<{
  tasks: ReturnType<typeof hostTasks>
  tasksAvailable: boolean
  jobs: RunnerJobs
}>()
</script>

<template>
  <div class="mt-4 space-y-4 text-sm">
    <div>
      <h5 class="field-label">
        Agents
      </h5>
      <p v-if="!tasksAvailable" class="mt-2 text-muted">
        Task details unavailable.
      </p>
      <p v-else-if="tasks.length === 0" class="mt-2 text-muted">
        No Agent tasks running.
      </p>
      <ul v-else class="mt-2 divide-y divide-default">
        <li v-for="task in tasks" :key="task.id" class="py-2 first:pt-0">
          <a v-if="task.url" :href="task.url" target="_blank" rel="noopener noreferrer" class="block break-words font-medium hover:underline focus-visible:outline-2 focus-visible:outline-primary">{{ task.title }}</a>
          <span v-else class="font-medium">{{ task.title }}</span>
          <p v-if="task.detail" class="mt-1 break-words text-xs text-muted">
            {{ task.detail }}
          </p>
          <p class="mt-1 break-words text-xs text-muted">
            {{ task.progress }}
          </p>
        </li>
      </ul>
    </div>
    <div>
      <h5 class="field-label">
        GitHub Actions
      </h5>
      <p v-if="jobs._tag === 'Unavailable'" class="mt-2 text-muted">
        Job details unavailable.
      </p>
      <p v-else-if="jobs.jobs.length === 0" class="mt-2 text-muted">
        No GitHub Actions jobs running.
      </p>
      <ul v-else class="mt-2 divide-y divide-default">
        <li v-for="job in jobs.jobs" :key="job.runner" class="py-2 first:pt-0">
          <span class="block break-words font-medium">{{ job.name }}</span>
          <a :href="`https://github.com/${job.repository}/actions`" target="_blank" rel="noopener noreferrer" class="mt-1 block break-words text-xs text-muted hover:underline focus-visible:outline-2 focus-visible:outline-primary">{{ job.repository }} · Actions ↗</a>
        </li>
      </ul>
    </div>
  </div>
</template>
