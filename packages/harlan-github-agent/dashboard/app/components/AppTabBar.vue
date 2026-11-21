<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { navigationItems } from '../utils/navigation.ts'

/**
 * The phone tab bar: the work pages, then More for reference pages. Sessions
 * owns the keyboard space on a phone, so the bar steps aside there.
 */
const { decisions, unhealthyRepositories } = useDashboard()
const route = useRoute()

const work = navigationItems.filter(item => item.group === 'work')
const reference = navigationItems.filter(item => item.group === 'reference')
const moreActive = computed(() => reference.some(item => item.to === route.path) || route.path === '/flow')
const moreItems = computed<DropdownMenuItem[][]>(() => [
  reference.map(item => ({ label: item.label, icon: item.icon, to: item.to })),
  [{ label: 'How it works', icon: 'i-octicon-workflow-16', to: '/flow' }],
])
const needsYou = (to: string): number => to === '/' || to === '/timeline' ? decisions.value.length : 0
</script>

<template>
  <nav
    aria-label="Pages"
    class="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-default bg-muted/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
  >
    <NuxtLink
      v-for="item in work"
      :key="item.to"
      :to="item.to"
      class="relative flex h-14 flex-col items-center justify-center gap-0.5 text-sm font-medium"
      :class="route.path === item.to ? 'text-highlighted' : 'text-muted'"
      :aria-current="route.path === item.to ? 'page' : undefined"
    >
      <UIcon :name="item.icon" class="size-5" aria-hidden="true" />
      {{ item.label }}
      <span v-if="needsYou(item.to) > 0" class="absolute top-2 left-1/2 ms-2 size-2 rounded-full bg-warning" :aria-label="`${needsYou(item.to)} need you`" />
    </NuxtLink>
    <UDropdownMenu :items="moreItems" :content="{ side: 'top', align: 'end' }">
      <button
        type="button"
        class="relative flex h-14 flex-col items-center justify-center gap-0.5 text-sm font-medium"
        :class="moreActive ? 'text-highlighted' : 'text-muted'"
      >
        <UIcon name="i-octicon-three-bars-16" class="size-5" aria-hidden="true" />
        More
        <span v-if="unhealthyRepositories > 0" class="absolute top-2 left-1/2 ms-2 size-2 rounded-full bg-error" aria-hidden="true" />
      </button>
    </UDropdownMenu>
  </nav>
</template>
