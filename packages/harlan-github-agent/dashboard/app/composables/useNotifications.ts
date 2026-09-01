import type { QueueEntry } from '../../../src/types.ts'
import { useLocalStorage } from '@vueuse/core'
import { decisionKey } from '../utils/dashboard.ts'

export type NotificationToggleResult
  = | { _tag: 'On' }
    | { _tag: 'Off' }
    | { _tag: 'Blocked', reason: string }

/**
 * Opt in browser notifications for new Needs you entries.
 *
 * The preference is durable, the permission belongs to the browser, and the
 * first snapshot only seeds the baseline so opening the page never fires one.
 */
export function useNotifications() {
  const { decisions } = useDashboard()

  const preference = useLocalStorage('harlan-agent-notifications', false)
  const supported = ref(false)
  const enabled = ref(false)
  const seen = ref(new Set<string>())
  const seeded = ref(false)

  async function toggle(): Promise<NotificationToggleResult> {
    if (enabled.value) {
      enabled.value = false
      preference.value = false
      return { _tag: 'Off' }
    }
    const permission = Notification.permission === 'granted'
      ? 'granted'
      : await Notification.requestPermission()
    if (permission !== 'granted')
      return { _tag: 'Blocked', reason: 'The browser blocked notifications. Allow them for this site, then try again.' }
    enabled.value = true
    preference.value = true
    return { _tag: 'On' }
  }

  function notify(fresh: QueueEntry[]): void {
    const first = fresh[0]
    if (first === undefined || Notification.permission !== 'granted')
      return
    const body = fresh.length === 1
      ? `${first.repository} #${first.number}: ${first.title}`
      : `${fresh.length} entries need you.`
    const notification = new Notification('Harlan GitHub Agent', { body, tag: 'harlan-agent-decisions' })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
  }

  watch(decisions, (entries) => {
    const keys = entries.map(decisionKey)
    const fresh = entries.filter((_, index) => !seen.value.has(keys[index]!))
    seen.value = new Set(keys)
    if (!seeded.value) {
      seeded.value = true
      return
    }
    if (enabled.value && fresh.length > 0)
      notify(fresh)
  })

  onMounted(() => {
    supported.value = 'Notification' in window
    if (supported.value && preference.value && Notification.permission === 'granted')
      enabled.value = true
  })

  return { supported, enabled, toggle }
}
