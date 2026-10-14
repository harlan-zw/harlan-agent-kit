import type { HostState } from '../utils/terminal-host-discovery.ts'
import { createSharedComposable } from '@vueuse/core'
import { discoverTerminalHost } from '../utils/terminal-host-discovery.ts'

function createTerminalHost() {
  const state = shallowRef<HostState>({ _tag: 'Checking' })
  const auth = useBrowserAuth()
  let discovery: Promise<void> | null = null
  function start(): Promise<void> {
    if (discovery) return discovery
    // BrowserAuthGate owns pairing. Discovery consumes only its authenticated surface.
    discovery = (async () => {
      state.value = { _tag: 'Checking' }
      const surface = auth.session.value?.surface
      if (!surface) {
        state.value = { _tag: 'Unavailable' }
        return
      }
      state.value = await discoverTerminalHost(surface, () => $fetch('/api/terminal/capabilities'))
    })().finally(() => {
      discovery = null
    })
    return discovery
  }

  const controller = computed(
    () =>
      state.value._tag === 'Dashboard' ||
      state.value._tag === 'Legacy' ||
      (state.value._tag === 'Available' && state.value.capabilities.controller),
  )
  const readOnly = computed(() => state.value._tag === 'Available' && state.value.capabilities.controllerReadOnly)
  function controllerPath(path: string): string {
    return readOnly.value ? `/api/maintenance${path.slice('/api'.length)}` : path
  }
  return { state, controller, readOnly, controllerPath, start }
}

export const useTerminalHost = createSharedComposable(createTerminalHost)
