import { faviconTone } from '../utils/system.ts'

/**
 * The favicon carries the Needs you colour. The title comes from `usePageTitle`.
 *
 * Literal hex is unavoidable inside a data URI. These are the DESIGN.md
 * semantic values and the ink primary, tracked by hand.
 */
const faviconFill = {
  error: '#cf222e',
  warning: '#9a6700',
  success: '#1a7f37',
} as const

export function useDocumentStatus() {
  const { snapshot, decisions } = useDashboard()

  const { title } = usePageTitle()

  const faviconHref = computed(() => {
    const fill = faviconFill[faviconTone(snapshot.value, decisions.value.length)]
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1f1e1b"/><circle cx="16" cy="16" r="7" fill="${fill}"/></svg>`
    return `data:image/svg+xml,${encodeURIComponent(svg)}`
  })

  useHead({
    htmlAttrs: { lang: 'en' },
    link: [{ rel: 'icon', type: 'image/svg+xml', href: faviconHref }],
  })

  return { title }
}
