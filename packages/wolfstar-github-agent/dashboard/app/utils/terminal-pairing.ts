/** Consume the secret before any request. Router startup can change the hash after setup. */
export function takeTerminalPairing(
  location: { hash: string; pathname: string; search: string },
  replace: (url: string) => void,
  routerHash = '',
): string | undefined {
  const parameters = new URLSearchParams((location.hash || routerHash).slice(1))
  const codes = parameters.getAll('pair')
  if (codes.length === 0) return undefined
  parameters.delete('pair')
  const remaining = parameters.toString()
  replace(`${location.pathname}${location.search}${remaining ? `#${remaining}` : ''}`)
  return codes.length === 1 && /^[\w-]{32,256}$/.test(codes[0]!) ? codes[0] : undefined
}

/** Serialize discovery and late pairing without replaying an attempted secret. */
export function createTerminalPairingDiscovery(dependencies: {
  take: () => string | undefined
  discover: (code: string | undefined) => Promise<void>
}) {
  const consumed = new Set<string>()
  let queued: string | undefined
  let pending: Promise<void> | undefined
  let disposed = false
  function consume(): boolean {
    const code = dependencies.take()
    if (!code || consumed.has(code) || consumed.size >= 64) return false
    consumed.add(code)
    queued = code
    return true
  }
  function run(): Promise<void> {
    if (pending) return pending
    const work = Promise.resolve()
      .then(async () => {
        do {
          const code = queued
          queued = undefined
          if (disposed) return
          await dependencies.discover(code)
        } while (queued)
      })
      .finally(() => {
        if (pending === work) pending = undefined
        // A fragment can arrive between the last await and this cleanup microtask.
        if (queued && !disposed) return run()
      })
    pending = work
    return work
  }
  return {
    start() {
      if (disposed) return Promise.resolve()
      consume()
      return run()
    },
    observe() {
      if (disposed || !consume()) return Promise.resolve()
      return run()
    },
    dispose() {
      disposed = true
      queued = undefined
      consumed.clear()
    },
  }
}
