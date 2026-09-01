<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { useMediaQuery } from '@vueuse/core'
import { restartNotice } from '../utils/system.ts'

/**
 * Everything that is not a decision: Selection mode, Restart, Notifications,
 * Theme, Keyboard, How it works. Below `md` the tabs and Pause live here too.
 */
const emit = defineEmits<{ keyboard: [] }>()

const { snapshot, controlPending, setSelectionMode, setAgentControl, requestRestart } = useDashboard()
const notifications = useNotifications()
const colorMode = useColorMode()
const toast = useToast()

const wide = useMediaQuery('(min-width: 48rem)')

const restart = computed(() => restartNotice(snapshot.value.restartRequest))
const paused = computed(() => snapshot.value.agentControl._tag === 'Paused')

async function toggleNotifications(): Promise<void> {
  const result = await notifications.toggle()
  if (result._tag === 'Blocked')
    toast.add({ title: 'Notifications stay off', description: result.reason, color: 'warning' })
}

const themes = [
  { label: 'Light', value: 'light', icon: 'i-octicon-sun-16' },
  { label: 'Dark', value: 'dark', icon: 'i-octicon-moon-16' },
  { label: 'System', value: 'system', icon: 'i-octicon-device-desktop-16' },
] as const

const items = computed<DropdownMenuItem[][]>(() => {
  const compact: DropdownMenuItem[][] = wide.value
    ? []
    : [
        [
          { label: 'Board', to: '/', icon: 'i-octicon-columns-16' },
          { label: 'History', to: '/history', icon: 'i-octicon-history-16' },
          { label: 'Watching', to: '/watching', icon: 'i-octicon-broadcast-16' },
          { label: 'Stats', to: '/stats', icon: 'i-octicon-graph-16' },
        ],
        [
          {
            label: paused.value ? 'Resume' : 'Pause',
            icon: paused.value ? 'i-octicon-play-16' : 'i-octicon-stop-16',
            disabled: controlPending.value,
            onSelect: () => setAgentControl(paused.value ? 'resume' : 'pause'),
          },
        ],
      ]
  return [
    ...compact,
    [
      { label: 'Selection mode', type: 'label' },
      {
        label: 'Auto',
        description: 'The service selects each pull request.',
        type: 'checkbox',
        checked: snapshot.value.selectionMode === 'auto',
        disabled: controlPending.value,
        onUpdateChecked: () => setSelectionMode('auto'),
      },
      {
        label: 'Manual',
        description: 'You select each pull request.',
        type: 'checkbox',
        checked: snapshot.value.selectionMode === 'manual',
        disabled: controlPending.value,
        onUpdateChecked: () => setSelectionMode('manual'),
      },
    ],
    [
      ...(notifications.supported.value
        ? [{
            label: 'Notifications',
            description: 'When something needs you.',
            icon: 'i-octicon-bell-16',
            type: 'checkbox' as const,
            checked: notifications.enabled.value,
            onUpdateChecked: () => toggleNotifications(),
          }]
        : []),
      {
        label: 'Theme',
        icon: colorMode.preference === 'dark' ? 'i-octicon-moon-16' : colorMode.preference === 'light' ? 'i-octicon-sun-16' : 'i-octicon-device-desktop-16',
        children: themes.map(theme => ({
          label: theme.label,
          icon: theme.icon,
          type: 'checkbox' as const,
          checked: colorMode.preference === theme.value,
          onUpdateChecked: () => {
            colorMode.preference = theme.value
          },
        })),
      },
      {
        label: 'Keyboard',
        icon: 'i-octicon-command-palette-16',
        kbds: ['?'],
        onSelect: () => emit('keyboard'),
      },
      { label: 'How it works', to: '/flow', icon: 'i-octicon-workflow-16' },
    ],
    [
      {
        label: restart.value === undefined ? 'Restart after current work' : restart.value.text,
        icon: 'i-octicon-sync-16',
        disabled: controlPending.value || restart.value?._tag === 'Requested' || restart.value?._tag === 'Restarting',
        onSelect: () => requestRestart(),
      },
    ],
  ]
})
</script>

<template>
  <UDropdownMenu :items="items" :content="{ align: 'end' }" :ui="{ content: 'w-80' }">
    <UButton
      color="neutral"
      variant="ghost"
      size="sm"
      square
      icon="i-octicon-kebab-horizontal-16"
      aria-label="More"
      title="More"
    />
  </UDropdownMenu>
</template>
