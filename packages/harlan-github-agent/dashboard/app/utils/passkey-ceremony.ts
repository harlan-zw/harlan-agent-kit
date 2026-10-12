export type PasskeyPhase = 'Preparing' | 'WaitingForBrowser' | 'Verifying'
export type PasskeyResult = { _tag: 'Ok' } | { _tag: 'Cancelled' } | { _tag: 'TimedOut', phase: PasskeyPhase } | { _tag: 'Failed', cause: unknown }
/** Cancellation settles once. Late browser and HTTP results cannot advance the protocol. */
export function runPasskeyOperation<Options, Credential>(dependencies: {
  prepare: (signal: AbortSignal) => Promise<Options>
  browser: (options: Options) => Promise<Credential>
  verify: (credential: Credential, signal: AbortSignal) => Promise<unknown>
  abortBrowser: () => void
  phase: (phase: PasskeyPhase | null) => void
  requestMs?: number
  browserMs?: number
}) {
  const controller = new AbortController()
  let active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolve!: (result: PasskeyResult) => void
  const result = new Promise<PasskeyResult>((done) => {
    resolve = done
  })
  function finish(value: PasskeyResult) {
    if (!active)
      return
    active = false
    clearTimeout(timer)
    if (value._tag === 'Cancelled' || value._tag === 'TimedOut') {
      controller.abort()
      dependencies.abortBrowser()
    }
    dependencies.phase(null)
    resolve(value)
  }
  function phase(value: PasskeyPhase) {
    clearTimeout(timer)
    dependencies.phase(value)
    timer = setTimeout(finish, value === 'WaitingForBrowser' ? dependencies.browserMs ?? 120000 : dependencies.requestMs ?? 15000, { _tag: 'TimedOut', phase: value })
  }
  phase('Preparing')
  void Promise.resolve().then(async () => {
    if (!active)
      return
    const options = await dependencies.prepare(controller.signal)
    if (!active)
      return
    phase('WaitingForBrowser')
    const credential = await dependencies.browser(options)
    if (!active)
      return
    phase('Verifying')
    await dependencies.verify(credential, controller.signal)
    finish({ _tag: 'Ok' })
  }).catch(cause => finish({ _tag: 'Failed', cause }))
  return { result, cancel: () => finish({ _tag: 'Cancelled' }) }
}
