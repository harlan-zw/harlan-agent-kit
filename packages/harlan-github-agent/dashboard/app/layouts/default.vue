<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { isTypingTarget } from '../utils/keyboard.ts'

/**
 * One header, one row, 48px, on every page. No status bar, no footer.
 *
 * The layout is also the one subscriber that keeps the shared snapshot alive,
 * so changing page never costs a reconnect.
 */
const { snapshot, loading, unhealthyRepositories, controlPending, controlError, isStale, setAgentControl, start } = useDashboard()
const { show: showSystem } = useSystemPane()
useDocumentStatus()
const toast = useToast()

const keyboardOpen = ref(false)
const route = useRoute()
const sessionPage = computed(() => route.path === '/sessions')

const tabs = [
  { label: 'Sessions', to: '/sessions', icon: 'i-octicon-comment-discussion-16' },
  { label: 'Board', to: '/', icon: 'i-octicon-columns-16' },
  { label: 'History', to: '/history', icon: 'i-octicon-history-16' },
  { label: 'Watching', to: '/watching', icon: 'i-octicon-broadcast-16' },
  { label: 'Routines', to: '/routines', icon: 'i-octicon-calendar-16' },
  { label: 'Stats', to: '/stats', icon: 'i-octicon-graph-16' },
]

const paused = computed(() => snapshot.value.agentControl._tag === 'Paused')

watch(controlError, (error) => {
  if (error !== undefined)
    toast.add({ title: 'The request failed.', description: error, color: 'error' })
})

useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || event.key !== '?')
    return
  event.preventDefault()
  keyboardOpen.value = true
})

/** The board's Incident row asks for the pane by event, so it never imports layout state. */
useEventListener(window, 'open-system', showSystem)

onMounted(start)
</script>

<template>
  <div class="min-h-screen md:pl-44">
    <a href="#main" class="skip-link">Skip to content</a>
    <aside class="fixed inset-y-0 left-0 z-40 hidden w-44 flex-col border-r border-default bg-muted md:flex">
      <NuxtLink to="/sessions" class="flex h-14 items-center gap-2 px-4 text-base font-semibold text-highlighted">
        <UIcon name="i-octicon-hubot-16" class="size-5" aria-hidden="true" />Agent
      </NuxtLink>
      <nav aria-label="Pages" class="space-y-1 px-2">
        <UButton v-for="tab in tabs" :key="tab.to" :to="tab.to" :icon="tab.icon" exact color="neutral" variant="ghost" class="min-h-11 w-full" active-class="bg-accented text-highlighted" inactive-class="text-muted">
          {{ tab.label }}
          <UBadge v-if="tab.to === '/watching' && unhealthyRepositories > 0" color="error" variant="subtle" class="ml-auto">
            <span class="font-mono">{{ unhealthyRepositories }}</span>
          </UBadge>
        </UButton>
      </nav>
      <div class="mt-auto border-t border-default p-3">
        <UButton to="/flow" icon="i-octicon-workflow-16" color="neutral" variant="ghost" class="min-h-11 w-full">
          How it works
        </UButton>
      </div>
    </aside>
    <header class="sticky top-0 z-40 h-12 border-b border-default bg-default">
      <div class="mx-auto flex h-full max-w-[100rem] items-center gap-4 px-6 xl:px-10">
        <NuxtLink to="/sessions" class="flex shrink-0 items-center gap-2 text-sm font-medium text-highlighted md:hidden">
          <UIcon name="i-octicon-hubot-16" class="size-4" aria-hidden="true" />
          Agent
        </NuxtLink>

        <span class="hidden text-sm font-medium text-muted md:block">{{ tabs.find(tab => tab.to === route.path)?.label ?? 'Agent' }}</span>

        <div class="ms-auto flex items-center gap-1.5">
          <SystemChip />
          <div class="hidden items-center gap-1.5 lg:flex">
            <AgentSelectionMenu />
            <UButton
              :color="paused ? 'primary' : 'neutral'"
              :variant="paused ? 'solid' : 'outline'"
              size="sm"
              :loading="controlPending"
              :disabled="controlPending || loading"
              @click="setAgentControl(paused ? 'resume' : 'pause')"
            >
              {{ paused ? 'Resume' : 'Pause' }}
            </UButton>
          </div>
          <OverflowMenu @keyboard="keyboardOpen = true" />
        </div>
      </div>
    </header>

    <AppBanners v-if="!sessionPage" />

    <main id="main" :class="sessionPage ? '' : 'mx-auto max-w-[100rem] px-6 py-6 xl:px-10 xl:py-10'">
      <div :class="isStale && !sessionPage ? 'stale' : undefined">
        <slot />
      </div>
    </main>

    <SystemSlideover />
    <KeyboardModal v-model:open="keyboardOpen" />
  </div>
</template>
