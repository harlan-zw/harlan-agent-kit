<script setup lang="ts">
import { useClipboard } from '@vueuse/core'
import SessionMarkdown from './_SessionMarkdown.vue'

const { role, text } = defineProps<{ role: 'You' | 'Agent', text: string }>()
const { copy, copied, isSupported } = useClipboard({ legacy: true })
const copyFailure = ref(false)
async function copyMessage(): Promise<void> {
  copyFailure.value = false
  await copy(text).catch(() => {
    copyFailure.value = true
  })
}
</script>

<template>
  <article class="group my-6 min-w-0" :aria-label="`${role} message`" :class="role === 'You' ? 'ml-auto max-w-[90%]' : ''">
    <div class="mb-2 flex min-h-8 items-center gap-2" :class="role === 'You' ? 'justify-end' : ''">
      <span class="text-sm font-medium text-muted">{{ role }}</span>
      <UButton v-if="isSupported" color="neutral" variant="ghost" size="xs" :icon="copied ? 'i-octicon-check-16' : 'i-octicon-copy-16'" :aria-label="`Copy ${role === 'You' ? 'your' : 'Agent'} message`" :title="copied ? 'Copied' : 'Copy message'" @click="copyMessage" />
      <span v-if="copied" class="text-sm text-muted" role="status">Copied</span>
    </div>
    <div v-if="role === 'You'" class="rounded-xl bg-muted px-4 py-3">
      <p class="whitespace-pre-wrap break-words text-base leading-7">
        {{ text }}
      </p>
    </div>
    <SessionMarkdown v-else :text="text" />
    <p v-if="copyFailure" class="mt-2 text-sm text-muted" role="status">
      Could not copy the message. Select it to copy.
    </p>
  </article>
</template>
