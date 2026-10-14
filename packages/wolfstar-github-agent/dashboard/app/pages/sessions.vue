<script setup lang="ts">
const route = useRoute()
const terminalHost = useTerminalHost()
const TerminalWorkspace = defineAsyncComponent(() => import('./_TerminalWorkspace.vue'))
const SessionHistory = defineAsyncComponent(() => import('./_SessionHistory.vue'))
const historyView = computed(
  () =>
    terminalHost.state.value._tag === 'Dashboard' ||
    terminalHost.state.value._tag === 'Legacy' ||
    (terminalHost.controller.value &&
      (typeof route.query.session === 'string' ||
        typeof route.query.task === 'string' ||
        route.query.view === 'history')),
)
usePageTitle('Sessions')
</script>

<template>
  <SessionHistory v-if="historyView" />
  <TerminalWorkspace
    v-else-if="terminalHost.state.value._tag === 'Available'"
    :capabilities="terminalHost.state.value.capabilities"
  />
  <div v-else class="flex h-full items-center justify-center p-6" role="status">
    <div class="max-w-md space-y-3">
      <p>
        {{
          terminalHost.state.value._tag === 'Checking'
            ? 'Connecting to the terminal host.'
            : terminalHost.state.value._tag === 'PairingRequired'
              ? 'Open the pairing link from the terminal host.'
              : 'Could not load projects or sessions. Reload.'
        }}
      </p>
      <UButton
        v-if="terminalHost.state.value._tag !== 'Checking'"
        color="neutral"
        variant="outline"
        @click="terminalHost.start"
      >
        Reload
      </UButton>
    </div>
  </div>
</template>
