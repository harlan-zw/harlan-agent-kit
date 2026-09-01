import { documentTitle } from '../utils/system.ts'

/**
 * The one place a page names itself. The Needs you count leads on every page,
 * so no page calls `useHead({ title })` on its own.
 */
export function usePageTitle(page?: string) {
  const { decisions } = useDashboard()
  const title = computed(() => documentTitle(decisions.value.length, page))
  useHead({ title })
  return { title }
}
