<script setup lang="ts">
const auth = useBrowserAuth()
const password = ref('')
async function submitPassword() {
  await auth.passwordLogin(password.value)
  if (auth.session.value?.authenticated) password.value = ''
}
onMounted(() => {
  void auth.initialize()
})
</script>

<template>
  <slot v-if="auth.session.value?.authenticated" />
  <main v-else class="flex min-h-dvh items-center justify-center bg-default px-5 py-10">
    <section
      class="w-full max-w-sm rounded-lg border border-default bg-muted p-6 shadow-sm"
      aria-labelledby="browser-login-title"
      :aria-busy="auth.pending.value !== null"
    >
      <div class="mb-6 flex items-center gap-3">
        <UIcon name="i-octicon-hubot-16" class="size-6 text-highlighted" aria-hidden="true" />
        <h1 id="browser-login-title" class="text-lg font-semibold text-highlighted">Sign in to Agent</h1>
      </div>
      <p v-if="auth.pending.value === 'check'" role="status" class="text-sm text-muted">Checking sign-in access.</p>
      <div v-else class="space-y-4">
        <UButton
          v-if="auth.session.value?.passkeys"
          label="Sign in with Passkey"
          icon="i-octicon-key-16"
          class="min-h-11 w-full justify-center"
          :loading="auth.pending.value === 'login'"
          :disabled="auth.pending.value !== null"
          @click="auth.passkeyLogin"
        />
        <form
          v-if="auth.session.value?.bootstrapKind === 'password'"
          class="space-y-3"
          @submit.prevent="submitPassword"
        >
          <label for="browser-password" class="block text-sm font-medium text-highlighted">Password</label>
          <UInput
            id="browser-password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            class="w-full"
            :disabled="auth.pending.value !== null"
            required
          />
          <UButton
            type="submit"
            label="Sign in with password"
            color="neutral"
            variant="outline"
            class="min-h-11 w-full justify-center"
            :loading="auth.pending.value === 'password'"
            :disabled="auth.pending.value !== null || !password"
          />
        </form>
        <p v-if="auth.session.value?.bootstrapKind === 'pairing'" class="text-sm text-muted">
          Open the pairing link from the terminal host.
        </p>
        <UButton
          v-if="!auth.session.value"
          label="Retry"
          color="neutral"
          variant="outline"
          class="min-h-11"
          :disabled="auth.pending.value !== null"
          @click="auth.initialize"
        />
      </div>
      <PasskeyProgress />
      <p v-if="auth.error.value" role="alert" class="mt-4 text-sm text-error">
        {{ auth.error.value }}
      </p>
    </section>
  </main>
</template>
