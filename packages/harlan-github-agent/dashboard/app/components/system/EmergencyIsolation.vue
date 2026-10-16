<script setup lang="ts">
import type { PasskeyPhase } from '../../utils/passkey-ceremony.ts'
import { startAuthentication, WebAuthnAbortService } from '@simplewebauthn/browser'
import { runPasskeyOperation } from '../../utils/passkey-ceremony.ts'

const props = defineProps<{ active: boolean }>()
const visible = ref(false)
const ready = ref(false)
const checking = ref(false)
const open = ref(false)
const phase = ref<PasskeyPhase | null>(null)
const outcome = ref<'idle' | 'accepted' | 'uncertain'>('idle')
const error = ref('')
let submitted = false
let cancel = () => {}
const api = $fetch.create({ timeout: 25000, retry: 0 })
async function check() {
  if (checking.value || outcome.value !== 'idle')
    return
  checking.value = true
  ready.value = false
  try {
    const status = await api<{ available: boolean, locked: boolean }>('/api/emergency-isolation/status')
    visible.value = true
    ready.value = status.available && !status.locked
    error.value = status.locked ? 'Isolation has already been requested. Inspect through admin recovery.' : ''
  }
  catch (cause) {
    const status = (cause as { statusCode?: number }).statusCode
    visible.value = status !== 401 && status !== 403 && status !== 404
    error.value = 'Emergency isolation is unavailable. Use admin recovery to inspect.'
  }
  finally { checking.value = false }
}
watch(() => props.active, (active) => {
  if (active)
    void check()
}, { immediate: true })
onScopeDispose(() => cancel())
async function isolate() {
  if (phase.value || outcome.value !== 'idle' || !ready.value)
    return
  error.value = ''
  submitted = false
  let ceremonyId = ''
  const operation = runPasskeyOperation({
    prepare: async (signal) => {
      const prepared = await api<{ ceremonyId: string, options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/api/emergency-isolation/options', { method: 'POST', body: {}, signal })
      ceremonyId = prepared.ceremonyId
      return prepared.options
    },
    browser: optionsJSON => startAuthentication({ optionsJSON }),
    verify: async (response, signal) => {
      submitted = true
      const result = await api<{ accepted: boolean }>('/api/emergency-isolation/isolate', { method: 'POST', body: { ceremonyId, response, confirmation: 'ISOLATE-HOGWILD' }, signal })
      if (result.accepted !== true)
        throw new Error('Unconfirmed isolation')
      return result
    },
    phase: (value) => { phase.value = value },
    abortBrowser: () => WebAuthnAbortService.cancelCeremony(),
    requestMs: 25000,
  })
  cancel = operation.cancel
  const result = await operation.result
  if (result._tag === 'Ok')
    outcome.value = 'accepted'
  else if (submitted)
    outcome.value = 'uncertain'
  else error.value = 'Passkey confirmation did not finish. No isolation request was sent.'
}
const progress = computed(() => phase.value === 'Preparing' ? 'Preparing the Passkey request.' : phase.value === 'WaitingForBrowser' ? 'Confirm with your Passkey.' : 'Requesting isolation.')
const resultMessage = computed(() => outcome.value === 'accepted'
  ? 'Isolation requested. This site will disconnect. Use admin recovery SSH to inspect and restore access.'
  : 'Could not confirm the request. Isolation may have started. Use admin recovery SSH to inspect before trying again.')
</script>

<template>
  <section v-if="visible" aria-labelledby="emergency-isolation-title" class="space-y-3">
    <h3 id="emergency-isolation-title" class="field-label">
      Emergency isolation
    </h3>
    <p class="text-sm text-muted">
      Stop Hogwild workloads and block their network access. Power stays on.
    </p>
    <p v-if="error && !open" role="status" class="text-sm status-warning">
      {{ error }}
    </p>
    <p v-if="outcome !== 'idle' && !open" role="status" class="text-sm">{{ resultMessage }}</p>
    <UButton color="error" variant="outline" :disabled="!ready || outcome !== 'idle'" class="min-h-11" @click="open = true">
      Isolate Hogwild
    </UButton>
    <UButton v-if="!ready && outcome === 'idle'" color="neutral" variant="ghost" :loading="checking" class="min-h-11" @click="check">
      Check again
    </UButton>
    <UModal v-model:open="open" title="Isolate Hogwild?" description="This stops workloads and disconnects this site. Power stays on. Restore access later through admin recovery SSH." :dismissible="!phase" :close="!phase">
      <template #body>
        <p v-if="outcome === 'accepted'" role="status" class="text-sm">
          {{ resultMessage }}
        </p>
        <p v-else-if="outcome === 'uncertain'" role="alert" class="text-sm status-warning">
          {{ resultMessage }}
        </p>
        <p v-else-if="phase" role="status" class="text-sm">
          {{ progress }}
        </p>
        <p v-else class="text-sm text-muted">
          Confirm with your Passkey to request isolation.
        </p>
        <p v-if="error && outcome === 'idle'" role="alert" class="mt-3 text-sm status-warning">
          {{ error }}
        </p>
      </template>
      <template #footer>
        <div v-if="outcome === 'idle'" class="flex w-full flex-wrap justify-end gap-2">
          <UButton color="neutral" variant="ghost" :disabled="phase === 'Verifying'" class="min-h-11" @click="phase ? cancel() : open = false">
            Cancel
          </UButton>
          <UButton color="error" :loading="!!phase" :disabled="!!phase" class="min-h-11" @click="isolate">
            Confirm with Passkey
          </UButton>
        </div>
        <UButton v-else color="neutral" variant="ghost" class="min-h-11" @click="open = false">Close</UButton>
      </template>
    </UModal>
  </section>
</template>
