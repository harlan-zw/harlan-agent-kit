<script setup lang="ts">
import { useClipboard } from '@vueuse/core'

const { text, language = '' } = defineProps<{ text: string, language?: string }>()
const { copy, copied, isSupported } = useClipboard({ legacy: true })
const copyFailure = ref(false)
async function copyCode(): Promise<void> {
  copyFailure.value = false
  await copy(text).catch(() => {
    copyFailure.value = true
  })
}
</script>

<template>
  <div class="my-4 overflow-hidden rounded-lg border border-default bg-muted">
    <div class="flex min-h-11 items-center justify-between gap-3 border-b border-default px-3">
      <span class="font-mono text-sm text-muted">{{ language || 'Code' }}</span>
      <UButton v-if="isSupported" color="neutral" variant="ghost" :icon="copied ? 'i-octicon-check-16' : 'i-octicon-copy-16'" aria-label="Copy code" @click="copyCode">
        {{ copied ? 'Copied' : 'Copy' }}
      </UButton>
    </div>
    <pre class="overflow-x-auto p-4 font-mono text-sm leading-6" tabindex="0" aria-label="Code"><code>{{ text }}</code></pre>
    <p v-if="copyFailure" class="px-4 pb-3 text-sm" role="status">
      Could not copy code. Select it to copy.
    </p>
  </div>
</template>
