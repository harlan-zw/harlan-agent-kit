<script setup lang="ts">
import { useEventListener, useMediaQuery, useWindowSize } from '@vueuse/core'
import { isTypingTarget } from '../utils/keyboard.ts'
import { fullBleedPaths, pageLabel } from '../utils/navigation.ts'

/**
 * The one shell for every page: a sidebar on desktop, a tab bar on a phone, and
 * a slim header that names the page and holds the System controls.
 *
 * The layout is also the one subscriber that keeps the shared snapshot alive,
 * so changing page never costs a reconnect.
 */
const { snapshot, controlsUnavailable, controlPending, controlError, isStale, setAgentControl, start } = useDashboard()
const { show: showSystem } = useSystemPane()
useDocumentStatus()
const toast = useToast()

const keyboardOpen = ref(false)
const route = useRoute()
const sessionPage = computed(() => route.path === '/sessions')
const fullBleed = computed(() => fullBleedPaths.includes(route.path))
const narrow = useMediaQuery('(max-width: 47.999rem)')
const phoneInput = useMediaQuery('(pointer: coarse)')
const { height: visualHeight } = useWindowSize({ type: 'visual' })
const viewportTop = ref(0)
const viewportScale = ref(1)
function updateViewport() {
  viewportTop.value = window.visualViewport?.offsetTop ?? 0
  viewportScale.value = window.visualViewport?.scale ?? 1
}
useEventListener(() => window.visualViewport, 'resize', updateViewport)
useEventListener(() => window.visualViewport, 'scroll', updateViewport)
/** On a phone, Sessions follows the visual viewport so the keyboard never covers the composer. */
const sessionHeight = computed(() => sessionPage.value && phoneInput.value && Number.isFinite(visualHeight.value)
  && viewportScale.value === 1
  ? { position: 'fixed' as const, top: `${viewportTop.value}px`, left: '0', right: '0', height: `${visualHeight.value}px` }
  : undefined)
const terminalHost = useTerminalHost()
/** The phone tab bar shows wherever the controller is reachable, except on Sessions. */
const tabBar = computed(() => terminalHost.controller.value && !sessionPage.value)

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

watch(terminalHost.controller, (enabled) => {
  if (enabled)
    start()
})

onMounted(() => {
  void terminalHost.start().then(async () => {
    if (terminalHost.controller.value)
      start()
    else if (terminalHost.state.value._tag === 'Available' && !sessionPage.value)
      await navigateTo('/sessions')
  })
})
</script>

<template>
  <div class="flex h-dvh min-h-0 overflow-hidden bg-default pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]" :style="sessionHeight">
    <a href="#main" class="skip-link">Skip to content</a>
    <AppSidebar />

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="z-30 flex h-12 shrink-0 items-center gap-2 border-b border-default bg-default ps-3 pe-2 md:ps-5">
        <NuxtLink :to="terminalHost.controller.value ? '/' : '/sessions'" aria-label="Agent" class="flex size-9 shrink-0 items-center justify-center rounded-md text-highlighted md:hidden">
          <UIcon name="i-octicon-hubot-16" class="size-[18px]" aria-hidden="true" />
        </NuxtLink>
        <span class="min-w-0 truncate text-sm font-semibold text-highlighted">{{ pageLabel(route.path) }}</span>

        <div class="ms-auto flex shrink-0 items-center gap-1.5">
          <span v-if="terminalHost.readOnly.value" class="sr-only rounded-md border border-default text-sm text-muted sm:not-sr-only sm:px-2 sm:py-0.5" role="status">Read-only Service connection.</span>
          <SystemChip v-if="terminalHost.controller.value" :compact="narrow || sessionPage" />
          <div v-if="terminalHost.controller.value && !sessionPage" class="hidden items-center gap-1.5 lg:flex">
            <AgentSelectionMenu />
            <UButton
              :color="paused ? 'primary' : 'neutral'"
              :variant="paused ? 'solid' : 'outline'"
              size="sm"
              :icon="paused ? 'i-octicon-play-16' : undefined"
              :loading="controlPending"
              :disabled="controlPending || controlsUnavailable"
              @click="setAgentControl(paused ? 'resume' : 'pause')"
            >
              {{ paused ? 'Resume' : 'Pause' }}
            </UButton>
          </div>
          <OverflowMenu v-if="terminalHost.controller.value" @keyboard="keyboardOpen = true" />
          <BrowserAuthControls :trigger="!terminalHost.controller.value" />
        </div>
      </header>

      <AppBanners v-if="terminalHost.controller.value" />

      <main
        id="main"
        class="min-h-0 min-w-0 flex-1"
        :class="[
          fullBleed ? 'overflow-hidden' : 'overflow-auto p-4 lg:p-6',
          tabBar ? (fullBleed ? 'max-md:pb-[calc(3.5rem+env(safe-area-inset-bottom))]' : 'max-md:pb-[calc(4.5rem+env(safe-area-inset-bottom))]') : undefined,
        ]"
      >
        <div class="h-full min-h-0" :class="isStale && !sessionPage ? 'stale' : undefined">
          <slot />
        </div>
      </main>
    </div>

    <AppTabBar v-if="tabBar" />
    <SystemSlideover />
    <KeyboardModal v-model:open="keyboardOpen" />
  </div>
</template>
