<script setup lang="ts">
import { avatarUrl } from '../utils/dashboard.ts'

/**
 * Who opened it, what it is, and where it lives.
 *
 * The avatar leads because author identity is what separates work that proceeds
 * on its own from work that waits for Harlan.
 */
const {
  author,
  title,
  url,
  repository,
  kind,
  number,
  size = 'md',
} = defineProps<{
  author: string
  title: string
  url: string
  repository: string
  kind: 'issue' | 'pull_request'
  number: number
  size?: 'sm' | 'md' | 'lg'
}>()

const titleClass = {
  sm: 'text-sm font-medium',
  md: 'text-sm font-medium',
  lg: 'text-base font-medium',
}

const avatarSize = { sm: 'xs', md: 'sm', lg: 'md' } as const
</script>

<template>
  <div class="flex min-w-0 items-start gap-2.5">
    <a
      :href="`https://github.com/${author}`"
      target="_blank"
      rel="noreferrer"
      class="shrink-0"
      :title="`@${author}`"
    >
      <UAvatar :src="avatarUrl(author)" :alt="`@${author}`" :size="avatarSize[size]" />
    </a>
    <div class="min-w-0 flex-1">
      <a :href="url" target="_blank" rel="noreferrer" class="entity-link line-clamp-2" :class="titleClass[size]">
        {{ title }}
        <span class="sr-only"> on GitHub</span>
      </a>
      <p class="mt-0.5 truncate font-mono text-xs text-dimmed">
        <a :href="`https://github.com/${repository}`" target="_blank" rel="noreferrer" class="entity-link">{{ repository }}</a>
        <span aria-hidden="true"> · </span>
        <a :href="url" target="_blank" rel="noreferrer" class="entity-link">{{ kind === 'issue' ? 'Issue' : 'PR' }} #{{ number }}</a>
      </p>
    </div>
  </div>
</template>
