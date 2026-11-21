<script setup lang="ts">
import { useLocalStorage, useMediaQuery } from '@vueuse/core'
import { navigationItems } from '../utils/navigation.ts'

/**
 * The desktop sidebar. Labels by default, icons alone when collapsed, and the
 * choice stays in this browser. A tablet always gets icons, so pages keep their
 * width. Below md the phone tab bar takes over.
 */
const { decisions, unhealthyRepositories } = useDashboard()
const terminalHost = useTerminalHost()
const route = useRoute()
const preference = useLocalStorage('agent:sidebar-collapsed', false, { initOnMounted: true })
const tablet = useMediaQuery('(max-width: 63.999rem)')
const collapsed = computed(() => preference.value || tablet.value)

const items = computed(() => navigationItems.filter(item => terminalHost.controller.value || item.to === '/sessions'))
const groups = computed(() => [
  items.value.filter(item => item.group === 'work'),
  items.value.filter(item => item.group === 'reference'),
].filter(group => group.length > 0))

/** Needs you shows on the two pages that hold it. */
const needsYou = (to: string): number => to === '/' || to === '/timeline' ? decisions.value.length : 0
</script>

<template>
  <aside
    class="z-40 hidden shrink-0 flex-col border-r border-default bg-muted transition-[width] duration-200 ease-(--ease-out) motion-reduce:transition-none md:flex"
    :class="collapsed ? 'w-14' : 'w-56'"
    aria-label="Sidebar"
  >
    <div class="flex h-12 shrink-0 items-center px-2.5" :class="collapsed ? 'justify-center' : undefined">
      <NuxtLink :to="terminalHost.controller.value ? '/' : '/sessions'" class="flex min-h-9 items-center gap-2.5 rounded-md px-1.5 font-semibold text-highlighted">
        <UIcon name="i-octicon-hubot-16" class="size-[18px] shrink-0" aria-hidden="true" />
        <span :class="collapsed ? 'sr-only' : '[font-variation-settings:\'wdth\'_112]'">Agent</span>
      </NuxtLink>
    </div>

    <nav aria-label="Pages" class="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2">
      <template v-for="(group, index) in groups" :key="index">
        <div v-if="index > 0" class="mx-2 my-2.5 h-px bg-(--ui-border)" aria-hidden="true" />
        <ul class="flex flex-col gap-0.5" role="list">
          <li v-for="item in group" :key="item.to">
            <UTooltip :text="item.label" :disabled="!collapsed" :content="{ side: 'right' }">
              <NuxtLink
                :to="item.to"
                class="relative flex h-9 items-center gap-3 rounded-md text-sm font-medium transition-colors"
                :class="[
                  route.path === item.to ? 'bg-accented text-highlighted' : 'text-muted hover:bg-accented/50 hover:text-highlighted',
                  collapsed ? 'justify-center' : 'px-2.5',
                ]"
                :aria-current="route.path === item.to ? 'page' : undefined"
              >
                <UIcon :name="item.icon" class="size-4 shrink-0" aria-hidden="true" />
                <span :class="collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'">{{ item.label }}</span>
                <template v-if="needsYou(item.to) > 0">
                  <span v-if="!collapsed" class="font-mono text-sm text-warning" :aria-label="`${needsYou(item.to)} need you`">{{ needsYou(item.to) }}</span>
                  <span v-else class="absolute right-2 top-1.5 size-1.5 rounded-full bg-warning" aria-hidden="true" />
                </template>
                <span v-if="item.to === '/watching' && unhealthyRepositories > 0" class="size-1.5 rounded-full bg-error" :class="collapsed ? 'absolute right-2 top-1.5' : undefined" aria-hidden="true" />
              </NuxtLink>
            </UTooltip>
          </li>
        </ul>
      </template>
    </nav>

    <div class="flex shrink-0 flex-col gap-0.5 border-t border-default p-2">
      <UTooltip v-if="terminalHost.controller.value" text="How it works" :disabled="!collapsed" :content="{ side: 'right' }">
        <NuxtLink
          to="/flow"
          class="flex h-9 items-center gap-3 rounded-md text-sm font-medium transition-colors"
          :class="[route.path === '/flow' ? 'bg-accented text-highlighted' : 'text-muted hover:bg-accented/50 hover:text-highlighted', collapsed ? 'justify-center' : 'px-2.5']"
        >
          <UIcon name="i-octicon-workflow-16" class="size-4 shrink-0" aria-hidden="true" />
          <span :class="collapsed ? 'sr-only' : undefined">How it works</span>
        </NuxtLink>
      </UTooltip>
      <UTooltip v-if="!tablet" :text="collapsed ? 'Expand sidebar' : 'Collapse sidebar'" :content="{ side: 'right' }">
        <button
          type="button"
          class="flex h-9 items-center gap-3 rounded-md text-sm font-medium text-muted transition-colors hover:bg-accented/50 hover:text-highlighted"
          :class="collapsed ? 'justify-center' : 'px-2.5'"
          :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          :aria-expanded="!collapsed"
          @click="preference = !preference"
        >
          <UIcon :name="collapsed ? 'i-octicon-sidebar-collapse-16' : 'i-octicon-sidebar-expand-16'" class="size-4 shrink-0" aria-hidden="true" />
          <span v-if="!collapsed">Collapse</span>
        </button>
      </UTooltip>
    </div>
  </aside>
</template>
