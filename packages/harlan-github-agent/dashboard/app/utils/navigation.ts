/**
 * Every dashboard page the shell links to, in sidebar order.
 *
 * Work pages are where decisions and Agents live. Reference pages answer
 * questions about what happened. The sidebar and the phone tab bar both read
 * this list, so a page is added in one place.
 */
export interface NavigationItem {
  label: string
  to: string
  icon: string
  group: 'work' | 'reference'
}

export const navigationItems: readonly NavigationItem[] = [
  { label: 'Sessions', to: '/sessions', icon: 'i-octicon-terminal-16', group: 'work' },
  { label: 'Board', to: '/', icon: 'i-octicon-columns-16', group: 'work' },
  { label: 'Timeline', to: '/timeline', icon: 'i-octicon-clock-16', group: 'work' },
  { label: 'History', to: '/history', icon: 'i-octicon-history-16', group: 'reference' },
  { label: 'Watching', to: '/watching', icon: 'i-octicon-broadcast-16', group: 'reference' },
  { label: 'Routines', to: '/routines', icon: 'i-octicon-calendar-16', group: 'reference' },
  { label: 'Stats', to: '/stats', icon: 'i-octicon-graph-16', group: 'reference' },
]

/** Pages that own the whole viewport and scroll inside themselves. */
export const fullBleedPaths: readonly string[] = ['/sessions', '/timeline']

/** The header names the page. Unknown paths fall back to the product name. */
export function pageLabel(path: string): string {
  if (path === '/flow')
    return 'How it works'
  return navigationItems.find(item => item.to === path)?.label ?? 'Agent'
}
