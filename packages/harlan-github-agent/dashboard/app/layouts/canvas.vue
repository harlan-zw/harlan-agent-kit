<script setup lang="ts">
import { useEventListener, useMediaQuery } from '@vueuse/core'
import { isTypingTarget } from '../utils/keyboard.ts'

/**
 * Chrome for a full-bleed canvas: three floating clusters over the page and
 * nothing else. The page owns the whole viewport. Like the default layout,
 * this layout keeps the shared snapshot alive while it is mounted.
 */
const { start, controlError, isStale } = useDashboard()
const toast = useToast()
watch(controlError, (error) => {
  if (error !== undefined)
    toast.add({ title: 'The request failed.', description: error, color: 'error' })
})
const { show: showSystem } = useSystemPane()
useDocumentStatus()
const terminalHost = useTerminalHost()
const keyboardOpen = ref(false)
const route = useRoute()
const narrow = useMediaQuery('(max-width: 767px)')

const nav = [
  { label: 'Timeline', to: '/timeline' },
  { label: 'Sessions', to: '/sessions' },
  { label: 'Stats', to: '/stats' },
]

useEventListener('keydown', (event: KeyboardEvent) => {
  if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || event.key !== '?')
    return
  event.preventDefault()
  keyboardOpen.value = true
})
useEventListener(window, 'open-system', showSystem)

watch(terminalHost.controller, (enabled) => {
  if (enabled)
    start()
})

onMounted(() => {
  void terminalHost.start().then(() => {
    if (terminalHost.controller.value)
      start()
  })
})
</script>

<template>
  <div class="relative h-dvh min-h-0 overflow-hidden bg-(--canvas-ground)">
    <a href="#main" class="skip-link">Skip to content</a>

    <header class="pointer-events-none absolute inset-x-3 top-3 z-40 flex items-start justify-between gap-2">
      <nav aria-label="Pages" class="canvas-cluster pointer-events-auto">
        <NuxtLink to="/timeline" class="flex h-8 items-center gap-2 ps-2 pe-3 font-semibold text-highlighted [font-variation-settings:'wdth'_112]">
          <UIcon name="i-octicon-hubot-16" class="size-[18px]" aria-hidden="true" />
          <span class="max-md:sr-only">Agent</span>
        </NuxtLink>
        <span class="h-5 w-px bg-(--ui-border)" aria-hidden="true" />
        <NuxtLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="flex h-8 items-center rounded-md px-3 font-medium text-muted transition-colors hover:text-highlighted"
          :class="route.path === item.to ? undefined : 'max-md:hidden'"
          active-class="bg-accented/70 !text-highlighted"
        >
          {{ item.label }}
        </NuxtLink>
      </nav>

      <div v-if="terminalHost.controller.value" class="canvas-cluster pointer-events-auto">
        <SystemChip :compact="narrow" />
        <OverflowMenu @keyboard="keyboardOpen = true" />
        <BrowserAuthControls />
      </div>
    </header>

    <main id="main" class="flex h-full min-h-0 flex-col pt-16">
      <AppBanners v-if="terminalHost.controller.value" class="shrink-0" />
      <div class="min-h-0 flex-1" :class="isStale ? 'stale' : undefined">
        <slot />
      </div>
    </main>

    <SystemSlideover />
    <KeyboardModal v-model:open="keyboardOpen" />
  </div>
</template>
