import type { TerminalCapabilities } from '../../../src/terminal-protocol.ts'
import { createSharedComposable, useEventListener } from '@vueuse/core'
import { createTerminalPairingDiscovery, takeTerminalPairing } from '../utils/terminal-pairing.ts'
import { parseTerminalCapabilities } from '../utils/terminal-protocol.ts'

type HostState =
  | { _tag: 'Checking' }
  | { _tag: 'Available'; capabilities: TerminalCapabilities }
  | { _tag: 'Legacy' }
  | { _tag: 'PairingRequired' }
  | { _tag: 'Unavailable' }

function status(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const value = error as { statusCode?: unknown; status?: unknown }
  return typeof value.statusCode === 'number'
    ? value.statusCode
    : typeof value.status === 'number'
      ? value.status
      : undefined
}

function createTerminalHost() {
  const state = shallowRef<HostState>({ _tag: 'Checking' })
  const route = useRoute()
  const router = useRouter()
  const discovery = createTerminalPairingDiscovery({
    take: () =>
      takeTerminalPairing(
        window.location,
        (url) => {
          window.history.replaceState(window.history.state, document.title, url)
          // Clear the router copy too, so later navigation cannot restore the secret.
          void router.replace(url).catch(() => {
            // Navigation failures can contain the old URL and its pairing secret.
            console.error('Could not remove the terminal pairing fragment.')
          })
        },
        route.hash || router.currentRoute.value.hash,
      ),
    discover: (code) =>
      (async () => {
        state.value = { _tag: 'Checking' }
        if (code) {
          const result = await $fetch<{ _tag: 'Ok' | 'Err' }>('/api/terminal/pair', { method: 'POST', body: { code } })
          if (result._tag !== 'Ok') {
            state.value = { _tag: 'PairingRequired' }
            return
          }
        }
        const capabilities = parseTerminalCapabilities(await $fetch<unknown>('/api/terminal/capabilities'))
        if (capabilities._tag === 'Err') {
          state.value = { _tag: 'Unavailable' }
          return
        }
        state.value = { _tag: 'Available', capabilities: capabilities.value }
      })().catch((error: unknown) => {
        const code = status(error)
        state.value =
          code === 404
            ? { _tag: 'Legacy' }
            : code === 401 || code === 403
              ? { _tag: 'PairingRequired' }
              : { _tag: 'Unavailable' }
      }),
  })
  // Nuxt navigation can restore the initial fragment after the first discovery request.
  function observePairing() {
    void discovery.observe()
  }
  watch([() => route.hash, () => router.currentRoute.value.hash], observePairing, { flush: 'post' })
  useEventListener('hashchange', observePairing)
  onScopeDispose(discovery.dispose)
  function start(): Promise<void> {
    return discovery.start()
  }

  const controller = computed(
    () => state.value._tag === 'Legacy' || (state.value._tag === 'Available' && state.value.capabilities.controller),
  )
  const readOnly = computed(() => state.value._tag === 'Available' && state.value.capabilities.controllerReadOnly)
  function controllerPath(path: string): string {
    return readOnly.value ? `/api/maintenance${path.slice('/api'.length)}` : path
  }
  return { state, controller, readOnly, controllerPath, start }
}

export const useTerminalHost = createSharedComposable(createTerminalHost)
