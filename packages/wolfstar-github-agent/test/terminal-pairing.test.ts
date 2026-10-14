import { describe, expect, it } from 'vitest'
import { createTerminalPairingDiscovery, takeTerminalPairing } from '../dashboard/app/utils/terminal-pairing.ts'

describe('terminal pairing fragment', () => {
  it('consumes a late router fragment and removes its secret before returning it', () => {
    const code = 'a'.repeat(72)
    const replaced: string[] = []
    const location = { pathname: '/sessions', search: '?terminal=existing', hash: `#pair=${code}&view=terminal` }
    expect(takeTerminalPairing(location, (url) => replaced.push(url))).toBe(code)
    expect(replaced).toEqual(['/sessions?terminal=existing#view=terminal'])
  })
  it.each(['#pair=short', `#pair=${'a'.repeat(32)}&pair=${'b'.repeat(32)}`, `#pair=${'a'.repeat(257)}`])(
    'removes and refuses malformed or duplicated secrets %s',
    (hash) => {
      const replaced: string[] = []
      expect(takeTerminalPairing({ pathname: '/', search: '', hash }, (url) => replaced.push(url))).toBeUndefined()
      expect(replaced).toEqual(['/'])
    },
  )
  it('preserves unrelated anchors and query parameters', () => {
    const replaced: string[] = []
    expect(
      takeTerminalPairing({ pathname: '/sessions', search: '?view=history', hash: '#main' }, (url) =>
        replaced.push(url),
      ),
    ).toBeUndefined()
    expect(replaced).toEqual([])
  })
  it('consumes the initial router secret when navigation temporarily clears the browser fragment', () => {
    const replaced: string[] = []
    const code = 'f'.repeat(72)
    expect(
      takeTerminalPairing({ pathname: '/', search: '', hash: '' }, (url) => replaced.push(url), `#pair=${code}`),
    ).toBe(code)
    expect(replaced).toEqual(['/'])
    expect(
      takeTerminalPairing({ pathname: '/', search: '', hash: '#main' }, (url) => replaced.push(url), `#pair=${code}`),
    ).toBeUndefined()
  })
})

it('queues a late fragment during discovery and consumes it before the first request finishes', async () => {
  const code = 'a'.repeat(72)
  const location = { pathname: '/sessions', search: '', hash: '' }
  const requests: (string | undefined)[] = []
  let finish: () => void = () => {}
  const initial = new Promise<void>((resolve) => {
    finish = resolve
  })
  const discovery = createTerminalPairingDiscovery({
    take: () =>
      takeTerminalPairing(location, () => {
        location.hash = ''
      }),
    discover: async (secret) => {
      requests.push(secret)
      if (!secret) await initial
    },
  })
  const started = discovery.start()
  await Promise.resolve()
  location.hash = `#pair=${code}`
  discovery.observe()
  expect(location.hash).toBe('')
  expect(requests).toEqual([undefined])
  finish()
  await started
  expect(requests).toEqual([undefined, code])
  location.hash = `#pair=${code}`
  await discovery.observe()
  expect(location.hash).toBe('')
  expect(requests).toEqual([undefined, code])
})

it('pairs automatically after discovery completes and detaches without another request', async () => {
  let secret: string | undefined
  const requests: (string | undefined)[] = []
  const discovery = createTerminalPairingDiscovery({
    take: () => {
      const code = secret
      secret = undefined
      return code
    },
    discover: async (code) => {
      requests.push(code)
    },
  })
  await discovery.start()
  secret = 'b'.repeat(72)
  await discovery.observe()
  await discovery.observe()
  expect(requests).toEqual([undefined, 'b'.repeat(72)])
  discovery.dispose()
  secret = 'c'.repeat(72)
  await discovery.observe()
  expect(requests).toEqual([undefined, 'b'.repeat(72)])
})

it('does not replay an attempted pairing code after a refused authentication request', async () => {
  const code = 'd'.repeat(72)
  let secret: string | undefined = code
  const requests: string[] = []
  const discovery = createTerminalPairingDiscovery({
    take: () => {
      const next = secret
      secret = undefined
      return next
    },
    discover: async (next) => {
      if (next) requests.push(next)
      throw new Error('Pairing refused')
    },
  })
  await expect(discovery.start()).rejects.toThrow('Pairing refused')
  secret = code
  await discovery.observe()
  expect(requests).toEqual([code])
})

it('cancels queued pairing when its observer scope closes', async () => {
  let secret: string | undefined
  let finish: () => void = () => {}
  const first = new Promise<void>((resolve) => {
    finish = resolve
  })
  const requests: (string | undefined)[] = []
  const discovery = createTerminalPairingDiscovery({
    take: () => secret,
    discover: async (code) => {
      requests.push(code)
      await first
    },
  })
  const started = discovery.start()
  await Promise.resolve()
  secret = 'e'.repeat(72)
  discovery.observe()
  discovery.dispose()
  finish()
  await started
  expect(requests).toEqual([undefined])
})

it('bounds automatic attempts even when distinct pairing fragments keep arriving', async () => {
  let secret: string | undefined
  const requests: (string | undefined)[] = []
  const discovery = createTerminalPairingDiscovery({
    take: () => secret,
    discover: async (code) => {
      requests.push(code)
    },
  })
  for (let index = 0; index < 100; index++) {
    secret = String(index).padStart(32, '0')
    await discovery.observe()
  }
  expect(requests.length).toBe(64)
  expect(requests.at(-1)).toBe(String(63).padStart(32, '0'))
})
