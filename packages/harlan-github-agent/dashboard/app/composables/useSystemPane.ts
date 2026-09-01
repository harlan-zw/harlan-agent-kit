/**
 * Whether the System slideover is open.
 *
 * Shared state, because the header chip opens it and the Incident row above
 * the board opens it too. Call `show()` from anywhere under the layout.
 */
export function useSystemPane() {
  const open = useState('system-pane-open', () => false)
  function show(): void {
    open.value = true
  }
  return { open, show }
}
