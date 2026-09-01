<script setup lang="ts">
/**
 * Confirmation only. One sentence of consequence, one solid button, one ghost Cancel.
 *
 * The consequence is the description, so it reads before the verb. An error
 * from the write renders inside the modal, so the reader sees it where the
 * decision was made and can retry without reopening.
 */
const {
  title,
  consequence,
  confirmLabel,
  tone = 'error',
  pending = false,
  error = null,
} = defineProps<{
  title: string
  consequence: string
  confirmLabel: string
  tone?: 'error' | 'primary'
  pending?: boolean
  error?: string | null
}>()

const emit = defineEmits<{ confirm: [] }>()
const open = defineModel<boolean>('open', { default: false })
</script>

<template>
  <UModal v-model:open="open" :title="title" :description="consequence" :dismissible="!pending">
    <template v-if="error" #body>
      <p role="alert" class="status-error">
        {{ error }}
      </p>
    </template>
    <template #footer>
      <UButton variant="ghost" color="neutral" :disabled="pending" @click="open = false">
        Cancel
      </UButton>
      <UButton :color="tone" :loading="pending" @click="emit('confirm')">
        {{ confirmLabel }}
      </UButton>
    </template>
  </UModal>
</template>
