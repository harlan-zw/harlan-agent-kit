<script setup lang="ts">
import { useBrowserLocation } from '@vueuse/core'

const auth = useBrowserAuth()
const location = useBrowserLocation()
const checking = computed(() => auth.pending.value === 'check' || (!auth.session.value && !auth.error.value))
// A pairing link's enrolment can add one Passkey. The new Passkey then signs this browser in.
const enrolling = computed(() => auth.session.value?.enrolment === true)
const label = ref('')
const browserSupported = computed(() => import.meta.client && !!window.PublicKeyCredential)
onMounted(() => {
  void auth.initialize()
})
</script>

<template>
  <slot v-if="auth.session.value?.authenticated" />
  <main v-else class="flex min-h-dvh items-center justify-center bg-default px-5 py-10">
    <section class="w-full max-w-sm rounded-lg border border-default bg-muted p-6 shadow-sm" aria-labelledby="browser-login-title" :aria-busy="checking || auth.pending.value !== null">
      <div class="mb-6 flex items-center gap-3">
        <UIcon name="i-octicon-hubot-16" class="size-6 text-highlighted" aria-hidden="true" />
        <h1 id="browser-login-title" class="text-lg font-semibold text-highlighted">
          {{ checking ? 'Opening Agent' : enrolling ? 'Add a Passkey' : 'Sign in to Agent' }}
        </h1>
      </div>
      <p v-if="checking" role="status" class="text-sm text-muted">
        Checking sign-in access.
      </p>
      <form v-else-if="enrolling" class="space-y-3" @submit.prevent="auth.add(label)">
        <p class="text-sm text-muted">
          This pairing link lets this browser add one Passkey.
        </p>
        <label for="enrolment-passkey-label" class="block text-sm font-medium text-highlighted">Passkey name</label>
        <UInput id="enrolment-passkey-label" v-model="label" maxlength="80" autocomplete="off" class="w-full" :disabled="auth.pending.value !== null" />
        <UButton type="submit" label="Add Passkey" icon="i-octicon-key-16" class="min-h-11 w-full justify-center" :loading="auth.pending.value === 'add'" :disabled="auth.pending.value !== null || !browserSupported" />
        <p v-if="!browserSupported" class="text-sm text-muted">
          This browser does not support Passkeys.
        </p>
      </form>
      <div v-else class="space-y-4">
        <UButton v-if="auth.session.value?.passkeys" label="Sign in with Passkey" icon="i-octicon-key-16" class="min-h-11 w-full justify-center" :loading="auth.pending.value === 'login'" :disabled="auth.pending.value !== null" @click="auth.passkeyLogin" />
        <p v-if="auth.session.value?.bootstrapKind === 'pairing'" class="text-sm text-muted">
          Open the pairing link from the terminal host.
        </p>
        <template v-else-if="auth.session.value?.bootstrapKind === 'passkey' && !auth.session.value.passkeys">
          <p class="text-sm text-muted">
            No Passkey is set up for this address. Run this command on the host:
          </p>
          <code class="block break-all rounded-md border border-default bg-default px-3 py-2 font-mono text-xs text-highlighted">harlan-github-agent pair --origin {{ location.origin }}</code>
        </template>
        <p v-else-if="auth.session.value?.bootstrapKind === 'passkey'" class="text-sm text-muted">
          If you lose every Passkey, open a new pairing link from the host.
        </p>
        <UButton v-if="!auth.session.value && auth.error.value" label="Retry" color="neutral" variant="outline" class="min-h-11" :disabled="auth.pending.value !== null" @click="auth.initialize" />
      </div>
      <PasskeyProgress />
      <p v-if="auth.error.value" role="alert" class="mt-4 text-sm text-error">
        {{ auth.error.value }}
      </p>
    </section>
  </main>
</template>
