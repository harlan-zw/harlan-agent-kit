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

const tabs = [
  { label: 'Board', to: '/' },
  { label: 'History', to: '/history' },
  { label: 'Watching', to: '/watching' },
  { label: 'Stats', to: '/stats' },
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
  <div class="min-h-screen">
    <a href="#main" class="skip-link">Skip to content</a>
    <header class="sticky top-0 z-40 h-12 border-b border-default bg-default">
      <div class="mx-auto flex h-full max-w-[100rem] items-center gap-4 px-6 xl:px-10">
        <NuxtLink to="/" class="flex shrink-0 items-center gap-2 text-sm font-medium text-highlighted">
          <UIcon name="i-octicon-hubot-16" class="size-4" aria-hidden="true" />
          Agent
        </NuxtLink>

        <nav aria-label="Pages" class="hidden items-center gap-0.5 md:flex">
          <UButton
            v-for="tab in tabs"
            :key="tab.to"
            :to="tab.to"
            exact
            color="neutral"
            variant="ghost"
            size="sm"
            active-class="bg-muted text-highlighted"
            inactive-class="text-muted"
          >
            {{ tab.label }}
            <UBadge v-if="tab.to === '/watching' && unhealthyRepositories > 0" color="error" variant="subtle" size="sm" class="font-mono">
              {{ unhealthyRepositories }}
            </UBadge>
          </UButton>
        </nav>

        <div class="ms-auto flex items-center gap-1.5">
          <SystemChip />
          <div class="hidden items-center gap-1.5 md:flex">
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

    <AppBanners />

    <main id="main" class="mx-auto max-w-[100rem] px-6 py-6 xl:px-10 xl:py-10">
      <div :class="isStale ? 'stale' : undefined">
        <slot />
      </div>
    </main>

    <SystemSlideover />
    <KeyboardModal v-model:open="keyboardOpen" />
  </div>
</template>
