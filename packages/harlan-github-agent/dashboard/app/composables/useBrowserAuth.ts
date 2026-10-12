import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { createSharedComposable, until } from '@vueuse/core'
import { createTerminalPairingDiscovery, takeTerminalPairing } from '../utils/terminal-pairing.ts'

interface Session { authenticated: boolean, bootstrapKind: 'pairing' | 'password', passkeys: boolean }
interface Credential { id: string, label: string, created: number }
type Operation = 'check' | 'password' | 'login' | 'add' | 'remove' | 'logout' | 'list'

export const useBrowserAuth = createSharedComposable(() => {
  const session = shallowRef<Session | null>(null)
  const pending = ref<Operation | null>(null)
  const error = ref('')
  const credentials = shallowRef<Credential[]>([])
  const managing = ref(false)
  const route = useRoute()
  const endpoint = '/api/browser-auth/'
  async function refresh() {
    session.value = await $fetch<Session>(`${endpoint}session`)
  }
  async function perform(operation: Operation, action: () => Promise<void>) {
    if (pending.value)
      return
    pending.value = operation
    error.value = ''
    await action().catch((cause: unknown) => {
      error.value = cause instanceof Error && cause.name === 'NotAllowedError'
        ? 'Passkey request was cancelled. Retry.'
        : operation === 'password'
          ? 'Could not sign in. Check the password and retry.'
          : operation === 'check'
            ? 'Could not check sign-in access. Retry.'
            : operation === 'logout'
              ? 'Could not sign out. Retry.'
              : 'The Passkey request failed. Retry.'
    })
    pending.value = null
  }
  const discovery = createTerminalPairingDiscovery({
    take: () => takeTerminalPairing(window.location, (url) => {
      window.history.replaceState(window.history.state, document.title, url)
    }, route.hash),
    discover: async (token) => {
      await until(pending).toBeNull()
      await perform('check', async () => {
        if (token) {
          await navigateTo(window.location.pathname + window.location.search + window.location.hash, { replace: true })
          await $fetch(`${endpoint}bootstrap`, { method: 'POST', body: { token } }).catch(() => {
            error.value = 'The pairing link is invalid. Open a new pairing link.'
          })
        }
        await refresh()
      })
    },
  })
  watch(() => route.hash, () => {
    if (import.meta.client)
      void discovery.observe()
  })
  onScopeDispose(() => discovery.dispose())
  function initialize() {
    return discovery.start()
  }
  async function passwordLogin(password: string) {
    await perform('password', async () => {
      await $fetch(`${endpoint}bootstrap`, { method: 'POST', body: { password } })
      await refresh()
    })
  }
  async function passkeyLogin() {
    await perform('login', async () => {
      const optionsJSON = await $fetch<Parameters<typeof startAuthentication>[0]['optionsJSON']>(`${endpoint}authentication/options`, { method: 'POST', body: {} })
      const response = await startAuthentication({ optionsJSON })
      await $fetch(`${endpoint}authentication/verify`, { method: 'POST', body: { response } })
      await refresh()
    })
  }
  async function list() {
    credentials.value = await $fetch<Credential[]>(`${endpoint}credentials`)
  }
  async function manage() {
    managing.value = true
    await perform('list', list)
  }
  async function add(label: string) {
    await perform('add', async () => {
      const optionsJSON = await $fetch<Parameters<typeof startRegistration>[0]['optionsJSON']>(`${endpoint}registration/options`, { method: 'POST', body: {} })
      const response = await startRegistration({ optionsJSON })
      await $fetch(`${endpoint}registration/verify`, { method: 'POST', body: { response, label: label.trim() || 'Passkey' } })
      await list()
      await refresh()
    })
  }
  async function remove(id: string) {
    await perform('remove', async () => {
      await $fetch(`${endpoint}credentials/remove`, { method: 'POST', body: { id } })
      await refresh()
      if (session.value?.authenticated) {
        await list()
      }
      else {
        credentials.value = []
        managing.value = false
      }
    })
  }
  async function logout() {
    await perform('logout', async () => {
      await $fetch(`${endpoint}logout`, { method: 'POST', body: {} })
      managing.value = false
      credentials.value = []
      session.value = null
      await refresh()
    })
  }
  return { session, pending, error, credentials, managing, initialize, passwordLogin, passkeyLogin, manage, add, remove, logout }
})
