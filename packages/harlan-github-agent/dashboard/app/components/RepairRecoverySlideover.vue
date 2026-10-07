<script setup lang="ts">
import type { RepairRecoveryPlan, RepairRecoveryRequest, RepairRecoveryResponse } from '../../../src/repair-recovery.ts'
import { parseRepairRecoveryResponse } from '../../../src/repair-recovery.ts'

const { candidate } = defineProps<{ candidate: Extract<RepairRecoveryRequest, { _tag: 'Plan' }> | null }>()
const open = defineModel<boolean>('open', { default: false })
const { snapshot } = useDashboard()
type RecoveryState
  = | { _tag: 'Idle' }
    | { _tag: 'Loading' }
    | { _tag: 'Inspecting', plan: RepairRecoveryPlan }
    | { _tag: 'Applying', plan: RepairRecoveryPlan }
    | { _tag: 'Accepted', taskId: string }
    | { _tag: 'Failed', message: string }
const state = ref<RecoveryState>({ _tag: 'Idle' })
const plan = computed(() => state.value._tag === 'Inspecting' || state.value._tag === 'Applying' ? state.value.plan : undefined)
const error = computed(() => state.value._tag === 'Failed' ? state.value.message : undefined)
const pending = computed(() => state.value._tag === 'Loading' || state.value._tag === 'Applying')
const accepted = computed(() => state.value._tag === 'Accepted')
let requestGeneration = 0
const canApply = computed(() => state.value._tag === 'Inspecting'
  && snapshot.value.mutationsEnabled && snapshot.value.agentControl._tag === 'Running'
  && snapshot.value.agentStart._tag === 'Available')

async function request(input: RepairRecoveryRequest): Promise<void> {
  if (input._tag === 'Apply' && state.value._tag !== 'Inspecting')
    return
  const generation = ++requestGeneration
  state.value = input._tag === 'Apply' && state.value._tag === 'Inspecting'
    ? { _tag: 'Applying', plan: state.value.plan }
    : { _tag: 'Loading' }
  await $fetch<RepairRecoveryResponse>('/api/tasks/recover-repair', { method: 'POST', body: input })
    .then((response) => {
      if (generation !== requestGeneration)
        return
      const parsed = parseRepairRecoveryResponse(response)
      if (parsed._tag === 'Err')
        throw new Error(parsed.error)
      if (parsed.value._tag === 'Plan')
        state.value = { _tag: 'Inspecting', plan: parsed.value }
      else
        state.value = { _tag: 'Accepted', taskId: parsed.value.taskId }
    })
    .catch((failure: unknown) => {
      if (generation !== requestGeneration)
        return
      const data = failure as { data?: { message?: string }, message?: string }
      state.value = { _tag: 'Failed', message: data.data?.message ?? data.message ?? 'Repair recovery failed. Request a new Plan.' }
    })
}

watch(() => [open.value, candidate] as const, ([visible, target]) => {
  requestGeneration += 1
  state.value = { _tag: 'Idle' }
  if (visible && target !== null)
    void request(target)
}, { flush: 'sync' })

function apply(): void {
  if (!canApply.value || plan.value === undefined)
    return
  void request({ _tag: 'Apply', taskId: plan.value.taskId, commitSha: plan.value.commitSha, expectedBase: plan.value.expectedBase })
}
</script>

<template>
  <USlideover v-model:open="open" title="Repair recovery">
    <template #body>
      <div class="space-y-4">
        <p v-if="pending" role="status">
          {{ plan ? 'Starting fresh Repair checks.' : 'Reading the retained Repair and current base.' }}
        </p>
        <p v-if="error" role="alert" class="text-error">
          {{ error }}
        </p>
        <p v-if="accepted" role="status">
          Repair recovery accepted. Follow the Task in the Board and History.
        </p>
        <template v-if="plan && !accepted">
          <DetailList
            :items="[
              { term: 'Repository', value: plan.repository },
              { term: 'Pull request', value: `#${plan.pullRequestNumber}`, href: `https://github.com/${plan.repository}/pull/${plan.pullRequestNumber}` },
              { term: 'Operation', value: plan.operation },
            ]"
          />
          <dl class="space-y-3">
            <div>
              <dt class="field-label">
                Retained commit
              </dt>
              <dd class="mt-1 break-all font-mono text-sm">
                {{ plan.commitSha }}
              </dd>
            </div>
            <div>
              <dt class="field-label">
                Current base
              </dt>
              <dd class="mt-1 break-all font-mono text-sm">
                {{ plan.expectedBase }}
              </dd>
            </div>
          </dl>
          <p>The controller verifies regression tests and required checks before opening a pull request.</p>
          <div>
            <p class="field-label">
              Changed paths
            </p>
            <ul class="mt-2 space-y-1 font-mono text-sm break-all">
              <li v-for="path in plan.changedPaths" :key="path">
                {{ path }}
              </li>
            </ul>
          </div>
          <div>
            <p class="field-label">
              Regression tests
            </p>
            <ul class="mt-2 space-y-1 font-mono text-sm break-all">
              <li v-for="path in plan.regressionPaths" :key="path">
                {{ path }}
              </li>
            </ul>
          </div>
          <p v-if="!canApply" class="text-muted">
            If Service control prevents work, resume it before applying this Plan.
          </p>
        </template>
      </div>
    </template>
    <template #footer>
      <ConfirmButton v-if="plan && !accepted" class="min-h-11" label="Apply recovery" confirm-label="Confirm recovery" aria-label="Apply Repair recovery" confirm-aria-label="Confirm Repair recovery" icon="i-octicon-sync-16" color="primary" :disabled="!canApply" @confirm="apply" />
      <UButton v-if="error && candidate" class="min-h-11" :disabled="pending" @click="request(candidate)">
        Request a new Plan
      </UButton>
    </template>
  </USlideover>
</template>
