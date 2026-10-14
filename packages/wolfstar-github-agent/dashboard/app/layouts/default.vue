<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import { isTypingTarget } from '../utils/keyboard.ts'

/**
 * The activity rail and view tabs stay mounted across every page.
 *
 * The layout is also the one subscriber that keeps the shared snapshot alive,
 * so changing page never costs a reconnect.
 */
const {
  snapshot,
  controlsUnavailable,
  unhealthyRepositories,
  controlPending,
  controlError,
  isStale,
  setAgentControl,
  start,
} = useDashboard()
const { show: showSystem } = useSystemPane()
useDocumentStatus()
const toast = useToast()

const keyboardOpen = ref(false)
const route = useRoute()
const sessionPage = computed(() => route.path === '/sessions')
const terminalHost = useTerminalHost()

const tabs = [
  { label: 'Sessions', to: '/sessions', icon: 'i-octicon-terminal-16' },
  { label: 'Board', to: '/', icon: 'i-octicon-columns-16' },
  { label: 'History', to: '/history', icon: 'i-octicon-history-16' },
  { label: 'Watching', to: '/watching', icon: 'i-octicon-broadcast-16' },
  { label: 'Routines', to: '/routines', icon: 'i-octicon-calendar-16' },
  { label: 'Stats', to: '/stats', icon: 'i-octicon-graph-16' },
]

const paused = computed(() => snapshot.value.agentControl._tag === 'Paused')

watch(controlError, (error) => {
  if (error !== undefined) toast.add({ title: 'The request failed.', description: error, color: 'error' })
})

useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || event.key !== '?') return
  event.preventDefault()
  keyboardOpen.value = true
})

/** The board's Incident row asks for the pane by event, so it never imports layout state. */
useEventListener(window, 'open-system', showSystem)

watch(terminalHost.controller, (enabled) => {
  if (enabled) start()
})

onMounted(() => {
  void terminalHost.start().then(async () => {
    if (terminalHost.controller.value) start()
    else if (terminalHost.state.value._tag === 'Available' && !sessionPage.value) await navigateTo('/sessions')
  })
})
</script>

<template>
  <div class="flex h-dvh min-h-0 overflow-hidden">
    <a href="#main" class="skip-link">Skip to content</a>
    <aside class="z-40 hidden w-12 shrink-0 flex-col border-r border-default bg-muted md:flex">
      <NuxtLink
        to="/sessions"
        aria-label="Agent"
        class="flex h-11 shrink-0 items-center justify-center text-highlighted"
      >
        <UIcon name="i-octicon-hubot-16" class="size-5" aria-hidden="true" />
      </NuxtLink>
      <nav aria-label="Pages" class="space-y-1">
        <UTooltip
          v-for="tab in tabs.filter((tab) => terminalHost.controller.value || tab.to === '/sessions')"
          :key="tab.to"
          :text="tab.label"
          :content="{ side: 'right' }"
        >
          <div class="relative">
            <UButton
              :to="tab.to"
              :icon="tab.icon"
              :aria-label="tab.label"
              exact
              color="neutral"
              variant="ghost"
              class="flex min-h-11 w-full justify-center rounded-none"
              active-class="bg-accented text-highlighted border-l-2 border-accented"
              inactive-class="text-muted"
            >
              <span class="sr-only">{{ tab.label }}</span>
            </UButton>
            <span
              v-if="tab.to === '/watching' && unhealthyRepositories > 0"
              class="pointer-events-none absolute right-1 top-1 size-1.5 rounded-full bg-error"
              aria-hidden="true"
            />
          </div>
        </UTooltip>
      </nav>
      <div v-if="terminalHost.controller.value" class="mt-auto border-t border-default">
        <UTooltip text="How it works" :content="{ side: 'right' }">
          <UButton
            to="/flow"
            icon="i-octicon-workflow-16"
            aria-label="How it works"
            color="neutral"
            variant="ghost"
            class="min-h-11 w-full justify-center rounded-none"
          />
        </UTooltip>
      </div>
    </aside>
    <div class="flex min-w-0 flex-1 flex-col">
      <header class="workspace-header z-40 shrink-0 border-b border-default bg-muted">
        <div class="flex h-full min-w-0 items-center gap-2 pr-2">
          <NuxtLink
            to="/sessions"
            class="flex shrink-0 items-center gap-2 text-sm font-medium text-highlighted md:hidden"
          >
            <UIcon name="i-octicon-hubot-16" class="size-4" aria-hidden="true" />
            <span class="sr-only sm:not-sr-only">Agent</span>
          </NuxtLink>

          <span
            class="flex h-full shrink-0 items-center border-r border-default border-t-2 border-t-accented bg-default px-2 text-sm font-medium text-highlighted sm:px-4"
            >{{ tabs.find((tab) => tab.to === route.path)?.label ?? 'Agent' }}</span
          >

          <div class="ms-auto flex items-center gap-1.5">
            <UButton
              v-if="terminalHost.controller.value && !sessionPage"
              to="/sessions"
              label="Sessions"
              icon="i-octicon-terminal-16"
              color="neutral"
              variant="outline"
              class="min-h-11 md:hidden"
            />
            <span
              v-if="terminalHost.readOnly.value"
              class="sr-only rounded border border-default text-xs text-muted sm:not-sr-only sm:px-2 sm:py-1"
              role="status"
              >Read-only Service connection.</span
            >
            <SystemChip v-if="terminalHost.controller.value" class="max-sm:max-w-28 max-sm:overflow-hidden" />
            <div v-if="terminalHost.controller.value && !sessionPage" class="hidden items-center gap-1.5 lg:flex">
              <AgentSelectionMenu />
              <UButton
                :color="paused ? 'primary' : 'neutral'"
                :variant="paused ? 'solid' : 'outline'"
                size="sm"
                :loading="controlPending"
                :disabled="controlPending || controlsUnavailable"
                @click="setAgentControl(paused ? 'resume' : 'pause')"
              >
                {{ paused ? 'Resume' : 'Pause' }}
              </UButton>
            </div>
            <OverflowMenu v-if="terminalHost.controller.value" @keyboard="keyboardOpen = true" />
            <BrowserAuthControls />
          </div>
        </div>
      </header>

      <AppBanners v-if="terminalHost.controller.value" />

      <main
        id="main"
        class="min-h-0 min-w-0 flex-1"
        :class="sessionPage ? 'overflow-hidden' : 'overflow-auto p-4 lg:p-6'"
      >
        <div class="h-full min-h-0" :class="isStale && !sessionPage ? 'stale' : undefined">
          <slot />
        </div>
      </main>
    </div>

    <SystemSlideover />
    <KeyboardModal v-model:open="keyboardOpen" />
  </div>
</template>
