<script setup lang="ts">
import { avatarUrl } from '../utils/dashboard.ts'

/**
 * Who opened it, where it lives, what it is.
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
  sm: 'text-sm font-medium line-clamp-1',
  md: 'text-sm font-medium line-clamp-2',
  lg: 'text-base font-medium line-clamp-2',
}

const avatarSize = { sm: 'xs', md: 'sm', lg: 'md' } as const

const kindIcon = { issue: 'i-octicon-issue-opened-16', pull_request: 'i-octicon-git-pull-request-16' }
const kindLabel = { issue: 'Issue', pull_request: 'Pull request' }
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
      <p class="flex items-center gap-1 font-mono text-sm text-dimmed">
        <UIcon :name="kindIcon[kind]" class="size-3.5 shrink-0" aria-hidden="true" />
        <span class="sr-only">{{ kindLabel[kind] }}</span>
        <a :href="url" target="_blank" rel="noreferrer" class="entity-link truncate">{{ repository }}#{{ number }}</a>
      </p>
      <a :href="url" target="_blank" rel="noreferrer" class="entity-link mt-0.5 block text-highlighted" :class="titleClass[size]">
        {{ title }}
        <span class="sr-only"> on GitHub</span>
      </a>
    </div>
  </div>
</template>
