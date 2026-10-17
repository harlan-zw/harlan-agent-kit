<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  state: 'loading' | 'error'
  retry?: () => void
}>()
const loading = computed(() => props.state === 'loading')
const role = computed(() => loading.value ? 'status' : 'alert')
</script>

<template>
  <div class="flex h-full min-h-64 items-center justify-center p-6" :role="role" :aria-busy="loading">
    <div class="max-w-md space-y-3 text-center">
      <p v-if="loading">
        Opening Sessions…
      </p>
      <template v-else>
        <p>
          Could not open Sessions. Retry.
        </p>
        <UButton color="neutral" variant="outline" class="min-h-11 min-w-24" @click="retry?.()">
          Retry
        </UButton>
      </template>
    </div>
  </div>
</template>
