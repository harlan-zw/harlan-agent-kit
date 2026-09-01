<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
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
  ejectedSession,
  clearEjectedSession,
  requestRestart,
  controlPending,
} = useDashboard()

const { copy, copied } = useClipboard()

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
        @click="requestRestart"
      >
        Restart again
      </UButton>
    </div>

    <div v-if="ejectedSession" role="status" class="mx-auto flex max-w-[100rem] flex-wrap items-center gap-x-4 gap-y-2 px-6 py-2 text-sm xl:px-10">
      <span v-if="ejectedSession._tag === 'Ejected'">Agent stopped. Resume {{ ejectedSession.repository }}#{{ ejectedSession.itemNumber }} in your terminal.</span>
      <span v-else class="status-warning">{{ ejectedSession.nextAction }}</span>
      <code class="min-w-0 flex-1 basis-full break-all font-mono text-sm text-muted sm:basis-auto">{{ ejectedSession.command }}</code>
      <UButton size="xs" color="neutral" variant="outline" icon="i-octicon-copy-16" @click="copy(ejectedSession.command)">
        {{ copied ? 'Copied' : 'Copy' }}
      </UButton>
      <UButton size="xs" color="neutral" variant="ghost" aria-label="Close this notice" @click="clearEjectedSession">
        Close
      </UButton>
    </div>
  </div>
</template>
