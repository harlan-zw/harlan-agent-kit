import type { SettingsAvailability, SettingsChanges, SettingsView } from '../utils/settings.ts'
import { createSharedComposable } from '@vueuse/core'
import { availabilityFromError } from '../utils/settings.ts'

interface FetchFailure {
  statusCode?: number
  status?: number
  data?: { error?: unknown }
  message?: string
}

function failure(error: unknown): { status: number | undefined; reason: string } {
  const failed = error as FetchFailure
  const message = typeof failed.data?.error === 'string' ? failed.data.error : (failed.message ?? 'The request failed.')
  return { status: failed.statusCode ?? failed.status, reason: message }
}

/**
 * The provider settings the Cloudflare edge Worker holds.
 *
 * The Worker answers under `/setup/api`, on the same origin as this page, so
 * the browser's own sign in rides along and no second login is needed. A
 * Service that runs from a configuration file has no such route, and the page
 * says so instead of showing a form that cannot work.
 */
export const useSettings = createSharedComposable(() => {
  const availability = ref<SettingsAvailability>({ _tag: 'Loading' })
  const saving = ref(false)
  const saveError = ref<string | undefined>()
  /** True after a save, while the controller restarts on the new settings. */
  const restarting = ref(false)

  const view = computed<SettingsView | undefined>(() =>
    availability.value._tag === 'Available' ? availability.value.view : undefined,
  )

  async function load(): Promise<void> {
    try {
      const loaded = await $fetch<SettingsView>('/setup/api/state')
      availability.value = { _tag: 'Available', view: loaded }
    } catch (error) {
      const { status, reason } = failure(error)
      availability.value = availabilityFromError(status, reason)
    }
  }

  /** Returns true when the Worker accepted the change. */
  async function save(changes: SettingsChanges): Promise<boolean> {
    saving.value = true
    saveError.value = undefined
    try {
      const saved = await $fetch<SettingsView & { restarting?: boolean }>('/setup/api/providers', {
        method: 'POST',
        body: changes,
      })
      const { restarting: restart, ...next } = saved
      availability.value = { _tag: 'Available', view: next }
      restarting.value = restart === true
      return true
    } catch (error) {
      saveError.value = failure(error).reason
      return false
    } finally {
      saving.value = false
    }
  }

  return { availability, view, saving, saveError, restarting, load, save }
})
