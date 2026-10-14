<script setup lang="ts">
import type { AgentProviderName } from '../../../src/agent-provider.ts'
import type { AgentModel, CodexReasoningEffort, Routine } from '../../../src/types.ts'
import { hasSpendableCapacity, selectedModelCapacity } from '../../../src/capacity.ts'

const { routine } = defineProps<{ routine: Routine | undefined }>()
const emit = defineEmits<{ queued: [id: string] }>()
const open = defineModel<boolean>('open', { default: false })
const { snapshot, controlsUnavailable, relativeTime, runRoutine } = useDashboard()
const provider = ref<AgentProviderName>('codex')
const model = ref<AgentModel>()
const reasoningEffort = ref<CodexReasoningEffort>('medium')
const pending = ref(false)
const error = ref<string>()
const models = computed(() => [...snapshot.value.agentModels[provider.value]])
const capacity = computed(() => ({
  capacity: selectedModelCapacity(snapshot.value, provider.value, model.value),
  reservePercent:
    snapshot.value.providerCapacities.find((entry) => entry.provider === provider.value)?.reservePercent ?? 0,
}))
const canSpend = computed(
  () => capacity.value !== undefined && hasSpendableCapacity(capacity.value.capacity, capacity.value.reservePercent),
)
const canSubmit = computed(
  () => routine?.enabled && model.value !== undefined && canSpend.value && !controlsUnavailable.value && !pending.value,
)

watch(open, (value) => {
  if (!value) return
  provider.value = snapshot.value.agentProfile.provider
})
watch([provider, open], ([, value]) => {
  if (!value) return
  model.value =
    models.value.find((value) => value === 'gpt-6.1-sol') ??
    models.value.find((value) => value === snapshot.value.agentProfile.roles.routine_scan.model) ??
    models.value[0]
  if (
    provider.value === 'opencode' &&
    !hasSpendableCapacity(
      selectedModelCapacity(snapshot.value, 'opencode', model.value),
      capacity.value.reservePercent,
    ) &&
    snapshot.value.agentModelCapacities?.opencodeGo._tag === 'Unpublished'
  )
    model.value = models.value.find((value) => value === 'opencode-go/glm-5.3-flash') ?? model.value
  reasoningEffort.value = provider.value === 'codex' ? 'medium' : 'high'
  error.value = undefined
})

async function submit(): Promise<void> {
  if (!canSubmit.value || routine === undefined || model.value === undefined) return
  pending.value = true
  error.value = undefined
  try {
    const run = await runRoutine(routine.id, {
      provider: provider.value,
      model: model.value,
      reasoningEffort: reasoningEffort.value,
    })
    if (run === undefined) return
    open.value = false
    emit('queued', run.id)
  } catch (failure) {
    const data =
      typeof failure === 'object' && failure !== null && 'data' in failure
        ? (failure.data as { message?: unknown })
        : undefined
    error.value = typeof data?.message === 'string' ? data.message : 'Could not queue the Routine run. Retry.'
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Run now"
    :description="routine ? `${routine.name} on ${routine.repository}` : undefined"
    :dismissible="!pending"
    :close="!pending"
    :ui="{ content: 'sm:max-w-lg' }"
  >
    <template #body>
      <form class="flex flex-col gap-5" @submit.prevent="submit">
        <p class="text-sm text-muted">Applies to this scan only.</p>
        <UFormField label="Agent provider" required>
          <USelect
            v-model="provider"
            :items="[
              { label: 'Codex', value: 'codex' },
              { label: 'OpenCode', value: 'opencode' },
            ]"
            aria-label="Agent provider"
            class="min-h-11 w-full"
            :disabled="pending"
          />
        </UFormField>
        <UFormField label="Model" required>
          <USelect v-model="model" :items="models" aria-label="Model" class="min-h-11 w-full" :disabled="pending" />
        </UFormField>
        <UFormField label="Reasoning effort" required>
          <USelect
            v-model="reasoningEffort"
            :items="[...snapshot.reasoningEfforts]"
            aria-label="Reasoning effort"
            class="min-h-11 w-full"
            :disabled="pending"
          />
        </UFormField>
        <div class="flex flex-col gap-1 text-sm" aria-live="polite">
          <p v-if="capacity?.capacity._tag === 'Available'">
            {{
              Math.max(0, 100 - capacity.capacity.usedPercent).toLocaleString(undefined, { maximumFractionDigits: 1 })
            }}% left · Reserve {{ capacity.reservePercent }}% · resets {{ relativeTime(capacity.capacity.resetsAt) }}
          </p>
          <p v-else-if="capacity?.capacity._tag === 'Unavailable'" class="status-warning">
            {{ capacity.capacity.reason }}
          </p>
          <p v-else-if="capacity?.capacity._tag === 'Unpublished'" class="text-muted">Usage is not published.</p>
          <p v-if="!canSpend" class="status-warning">The selected provider cannot start a scan now.</p>
          <p class="text-muted">This scan uses the selected provider's usage. Reserve applies before it starts.</p>
        </div>
        <p v-if="error" class="status-error text-sm" role="alert">
          {{ error }}
        </p>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="outline" class="min-h-11" :disabled="pending" @click="open = false">
            Cancel
          </UButton>
          <UButton type="submit" class="min-h-11" :loading="pending" :disabled="!canSubmit"> Run now </UButton>
        </div>
      </form>
    </template>
  </UModal>
</template>
