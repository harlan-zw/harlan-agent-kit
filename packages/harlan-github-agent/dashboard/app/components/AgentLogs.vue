<script setup lang="ts">
import type { AgentLogSelection } from '../utils/agent-logs.ts'
import { useEventListener, useResizeObserver } from '@vueuse/core'
import { sessionBottomTarget, sessionCanFollow, sessionDistanceFromBottom, sessionFollowOnScroll } from '../utils/session-scroll.ts'
import { sessionHostLabels } from '../utils/session.ts'

const { selection, sidebarOpen = false } = defineProps<{ selection: AgentLogSelection, sidebarOpen?: boolean }>()
const emit = defineEmits<{ projects: [] }>()
const log = computed(() => selection._tag === 'Live' || selection._tag === 'Retained' ? selection.log : undefined)
const conversation = useTemplateRef<HTMLElement>('conversation')
const content = useTemplateRef<HTMLElement>('content')
const following = ref(true)
const atBottom = ref(true)
let lastWriteTop = -1
let previousTop = 0

function scrollLatest(): void {
  const element = conversation.value
  if (!element)
    return
  following.value = true
  element.scrollTop = sessionBottomTarget(element)
  lastWriteTop = element.scrollTop
  previousTop = element.scrollTop
  atBottom.value = true
}
function followLatest(): void {
  const element = conversation.value
  if (!element)
    return
  if (sessionCanFollow({ geometry: element, lastWriteTop, following: following.value }))
    scrollLatest()
  atBottom.value = sessionDistanceFromBottom(element) <= 32
}
watch(() => log.value?.id, async () => {
  following.value = true
  lastWriteTop = -1
  await nextTick()
  scrollLatest()
})
watch(() => log.value?.activity, async () => {
  await nextTick()
  followLatest()
})
useResizeObserver(content, followLatest)
useEventListener(conversation, 'scroll', () => {
  const element = conversation.value
  if (!element)
    return
  following.value = sessionFollowOnScroll({ geometry: element, lastWriteTop, previousTop, following: following.value })
  previousTop = element.scrollTop
  atBottom.value = sessionDistanceFromBottom(element) <= 32
}, { passive: true })
useEventListener(conversation, 'wheel', (event: WheelEvent) => {
  if (event.deltaY < 0)
    following.value = false
}, { passive: true })
</script>

<template>
  <section class="relative flex min-h-0 min-w-0 flex-col bg-default" aria-label="Agent logs">
    <header class="flex min-h-16 shrink-0 items-center gap-3 border-b border-default px-4 lg:px-8">
      <UButton class="md:hidden" color="neutral" variant="ghost" icon="i-octicon-sidebar-expand-16" aria-label="Toggle projects" :aria-expanded="sidebarOpen" aria-controls="session-projects" @click="emit('projects')" />
      <div class="min-w-0 flex-1">
        <h1 class="truncate text-base font-medium">
          {{ log?.title ?? 'Watch logs' }}
        </h1>
        <p v-if="log" class="truncate text-sm text-muted">
          {{ log?.host ? sessionHostLabels[log.host] : 'Host unavailable' }}
          <template v-if="log">
            / {{ log.kind }} / {{ selection._tag === 'Live' ? log.phase : 'Last received logs' }}
          </template>
        </p>
      </div>
      <span class="shrink-0 text-sm text-muted">Read only</span>
    </header>
    <div ref="conversation" class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 lg:px-8" tabindex="0" aria-label="Agent activity">
      <div ref="content" class="mx-auto max-w-5xl py-5">
        <p v-if="selection._tag === 'Loading'" class="text-sm text-muted" role="status">
          Loading Agent logs…
        </p>
        <p v-if="selection._tag === 'Unavailable'" class="text-sm text-muted" role="status">
          These logs are unavailable. Choose a running Agent.
        </p>
        <p v-if="selection._tag === 'Retained'" class="mb-5 text-sm text-muted" role="status">
          This Agent left the running list. The last received logs remain here.
        </p>
        <p v-if="log && !log.activity.length" class="text-sm text-muted" role="status">
          No activity received yet.
        </p>
        <ol v-if="log" class="space-y-4 font-mono text-sm" role="list">
          <li v-for="(item, index) in log.activity" :key="index" class="min-w-0 break-words">
            <template v-if="item._tag === 'Command'">
              <p class="whitespace-pre-wrap">
                <span class="mr-1.5 text-dimmed" aria-hidden="true">$</span>{{ item.command }} <span v-if="item.exitCode !== null && item.exitCode !== 0" class="status-error">exit {{ item.exitCode }}</span>
              </p>
              <pre v-if="item.output" class="mt-1 whitespace-pre-wrap break-words text-muted">{{ item.output }}</pre>
            </template>
            <p v-else-if="item._tag === 'FileChange'">
              Edited {{ item.changes.map(change => change.path).join(', ') }}
            </p>
            <p v-else class="whitespace-pre-wrap text-muted">
              {{ item.text }}
            </p>
          </li>
        </ol>
      </div>
    </div>
    <div v-if="!atBottom" class="pointer-events-none absolute bottom-5 inset-x-0 flex justify-center">
      <UButton class="pointer-events-auto" color="neutral" variant="outline" icon="i-octicon-arrow-down-16" @click="scrollLatest">
        Latest activity
      </UButton>
    </div>
  </section>
</template>
