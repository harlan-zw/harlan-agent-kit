<script setup lang="ts">
import { restartNotice } from '../utils/system.ts'

/**
 * One line of consequence and one action each. Nothing here tints a surface:
 * the text carries the tone and a hairline separates the row.
 */
const {
  snapshot,
  loadError,
  loadState,
  isStale,
  relativeTime,
  requestRestart,
  requestUpdate,
  controlPending,
} = useDashboard()

const restart = computed(() => restartNotice(snapshot.value.restartRequest))
</script>

<template>
  <div class="divide-y divide-default border-b border-default empty:hidden">
    <div v-if="loadError" role="alert" class="mx-auto flex max-w-[100rem] flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2 text-sm xl:px-10">
      <span class="status-error">{{ loadError }}</span>
      <UButton size="xs" color="neutral" variant="outline" @click="loadState">
        Retry
      </UButton>
    </div>

    <div v-if="isStale" role="status" class="mx-auto flex max-w-[100rem] flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2 text-sm xl:px-10">
      <span class="status-warning">Last update {{ relativeTime(snapshot.generatedAt) }}. The board may have moved on.</span>
      <UButton size="xs" color="neutral" variant="outline" @click="loadState">
        Reload
      </UButton>
    </div>

    <div v-if="restart" role="status" class="mx-auto flex max-w-[100rem] flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2 text-sm xl:px-10">
      <span :class="restart._tag === 'ActionRequired' ? 'status-error' : 'status-warning'">{{ restart.text }}</span>
      <UButton
        v-if="restart._tag === 'ActionRequired'"
        size="xs"
        color="neutral"
        variant="outline"
        :disabled="controlPending"
        @click="snapshot.restartRequest?.operation._tag === 'Update' ? requestUpdate() : requestRestart()"
      >
        {{ snapshot.restartRequest?.operation._tag === 'Update' ? 'Update after current work' : 'Restart again' }}
      </UButton>
    </div>
  </div>
</template>
