<script setup lang="ts">
import { avatarUrl } from '../utils/dashboard.ts'

const { repository } = defineProps<{ repository: string }>()
const owner = computed(() => repository.split('/')[0]!)
</script>

<template>
  <span class="inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle">
    <span class="shrink-0" aria-hidden="true">
      <UAvatar :src="avatarUrl(owner)" :alt="owner" size="3xs" />
    </span>
    <span class="min-w-0 truncate">{{ repository }}<slot /></span>
  </span>
</template>
