<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { AgentModel, AgentSelection, CodexReasoningEffort } from '../../../src/types.ts'
import { AGENT_PROVIDER_NAMES, AGENT_ROLES } from '../../../src/agent-profile.ts'
import { agentProfileState, workChip } from '../utils/dashboard.ts'
import { providerLabels } from '../utils/system.ts'

/**
 * One control for the Agent provider, its model, and its Reasoning effort.
 *
 * Switching the provider clears the model and the effort, because a model
 * belongs to one provider and the service refuses the other provider's.
 * Follow configuration hands the whole choice back to the configuration file.
 * Automatic hands it to remaining capacity in the configured order.
 */
const { snapshot, loading, controlPending, selectAgent } = useDashboard()

const profile = computed(() => agentProfileState(snapshot.value, loading.value))

const pinned = computed(() => snapshot.value.agentSelection._tag === 'Pinned' ? snapshot.value.agentSelection : undefined)

/** While the selection follows the configuration, the configured provider decides. */
const provider = computed(() => pinned.value?.provider ?? snapshot.value.agentProfile.provider)

const orderLabel = computed(() => snapshot.value.agentProviderOrder.map(name => providerLabels[name]).join(', then '))

const triggerLabel = computed(() => {
  if (profile.value._tag === 'Loading')
    return 'Loading'
  if (profile.value._tag === 'Unavailable')
    return 'Unavailable'
  const name = providerLabels[profile.value.profile.provider]
  if (snapshot.value.agentSelection._tag === 'Automatic')
    return `Automatic · ${name}`
  return pinned.value?.model ? `${name} · ${pinned.value.model}` : name
})

function pin(model: AgentModel | null, reasoningEffort: CodexReasoningEffort | null): AgentSelection {
  return { _tag: 'Pinned', provider: provider.value, model, reasoningEffort }
}

const items = computed<DropdownMenuItem[][]>(() => {
  const selection = snapshot.value.agentSelection
  const models = snapshot.value.agentModels[provider.value]
  return [
    [
      { label: 'Agent selection', type: 'label' },
      {
        label: 'Follow configuration',
        type: 'checkbox',
        checked: selection._tag === 'FollowsConfiguration',
        onUpdateChecked: () => selectAgent({ _tag: 'FollowsConfiguration' }),
      },
      {
        label: 'Automatic',
        description: orderLabel.value,
        type: 'checkbox',
        checked: selection._tag === 'Automatic',
        onUpdateChecked: () => selectAgent({ _tag: 'Automatic', order: [...snapshot.value.agentProviderOrder] }),
      },
      ...AGENT_PROVIDER_NAMES.map(candidate => ({
        label: providerLabels[candidate],
        type: 'checkbox' as const,
        checked: pinned.value?.provider === candidate,
        onUpdateChecked: () => selectAgent({ _tag: 'Pinned', provider: candidate, model: null, reasoningEffort: null }),
      })),
    ],
    [
      { label: 'Model', type: 'label' },
      {
        label: 'Provider default',
        type: 'checkbox',
        checked: (pinned.value?.model ?? null) === null,
        onUpdateChecked: () => selectAgent(pin(null, pinned.value?.reasoningEffort ?? null)),
      },
      ...models.map(model => ({
        label: model,
        type: 'checkbox' as const,
        checked: pinned.value?.model === model,
        onUpdateChecked: () => selectAgent(pin(model, pinned.value?.reasoningEffort ?? null)),
      })),
    ],
    [
      { label: 'Reasoning effort', type: 'label' },
      {
        label: 'Provider default',
        type: 'checkbox',
        checked: (pinned.value?.reasoningEffort ?? null) === null,
        onUpdateChecked: () => selectAgent(pin(pinned.value?.model ?? null, null)),
      },
      ...snapshot.value.reasoningEfforts.map(reasoningEffort => ({
        label: reasoningEffort,
        type: 'checkbox' as const,
        checked: pinned.value?.reasoningEffort === reasoningEffort,
        onUpdateChecked: () => selectAgent(pin(pinned.value?.model ?? null, reasoningEffort)),
      })),
    ],
  ]
})

/** What each role will run next, after the selection above is applied. Read only. */
const roles = computed(() => AGENT_ROLES.map((role) => {
  const roleProfile = snapshot.value.agentProfile.roles[role]
  return {
    role,
    label: workChip(role).label,
    model: roleProfile.reasoningEffort ? `${roleProfile.model} · ${roleProfile.reasoningEffort}` : roleProfile.model,
  }
}))
</script>

<template>
  <UDropdownMenu
    v-if="profile._tag === 'Available'"
    :items="items"
    :content="{ align: 'end' }"
    :ui="{ content: 'w-80' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      size="sm"
      trailing-icon="i-octicon-chevron-down-16"
      :loading="controlPending"
      aria-label="Agent selection"
      title="Agent selection"
    >
      {{ triggerLabel }}
    </UButton>
    <template #content-bottom>
      <div class="border-t border-default p-2">
        <p class="field-label px-2 py-1.5">
          Per role
        </p>
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-2 py-1 text-sm">
          <template v-for="entry in roles" :key="entry.role">
            <dt class="text-muted">
              {{ entry.label }}
            </dt>
            <dd class="text-end font-mono text-muted">
              {{ entry.model }}
            </dd>
          </template>
        </dl>
      </div>
    </template>
  </UDropdownMenu>
  <UButton
    v-else
    color="neutral"
    variant="ghost"
    size="sm"
    disabled
    :loading="profile._tag === 'Loading'"
    :aria-label="`Agent selection ${triggerLabel.toLowerCase()}`"
  >
    {{ triggerLabel }}
  </UButton>
</template>
