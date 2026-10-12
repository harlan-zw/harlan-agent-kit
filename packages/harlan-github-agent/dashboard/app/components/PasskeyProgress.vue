<script setup lang="ts">
const auth = useBrowserAuth()
const messages = {
  Preparing: 'Preparing the Passkey request.',
  WaitingForBrowser: 'Waiting for the browser Passkey prompt.',
  Verifying: 'Verifying the Passkey response.',
}
</script>

<template>
  <div v-if="auth.passkeyPhase.value" class="space-y-2">
    <p role="status" class="text-sm text-muted">
      {{ messages[auth.passkeyPhase.value] }}
    </p>
    <UButton label="Cancel" color="neutral" variant="outline" class="min-h-11" @click="auth.cancelPasskey" />
  </div>
</template>
