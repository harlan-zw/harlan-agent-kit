<script setup lang="ts">
/** The keyboard list. Reached from the overflow menu or `?`, never from page copy. */
const open = defineModel<boolean>('open', { default: false })

const shortcuts = [
  { keys: ['j', 'k'], action: 'Move through Needs you' },
  { keys: ['a'], action: 'Press the primary action on the focused card' },
  { keys: ['/'], action: 'Focus the Watching filter' },
  { keys: ['?'], action: 'Open this list' },
]
</script>

<template>
  <UModal v-model:open="open" title="Keyboard">
    <template #body>
      <dl class="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
        <template v-for="shortcut in shortcuts" :key="shortcut.action">
          <dt class="flex gap-1">
            <UKbd v-for="key in shortcut.keys" :key="key" :value="key" />
          </dt>
          <dd class="text-sm">
            {{ shortcut.action }}
          </dd>
        </template>
      </dl>
    </template>
  </UModal>
</template>
