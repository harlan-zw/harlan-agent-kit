import { describe, expect, it, vi } from 'vitest'
import { createServiceUpdateSource } from '../src/index.ts'
import { createDeployedServiceUpdateSource } from '../src/service-update.ts'

const deployedCommit = 'a'.repeat(40)
const latestCommit = 'b'.repeat(40)
const checkedAt = new Date('2026-09-02T03:00:00.000Z')

describe('service update', () => {
  it('reports when origin/main has a newer commit', async () => {
    const source = createServiceUpdateSource({
      deployedCommit,
      now: () => checkedAt,
      readLatestCommit: () => Promise.resolve(latestCommit),
      prepareCommit: () => Promise.resolve({ _tag: 'Ok', value: undefined }),
      onError: vi.fn(),
    })

    expect(source.read()).toEqual({ _tag: 'Checking', deployedCommit })

    await source.refresh()

    expect(source.read()).toEqual({
      _tag: 'Available',
      deployedCommit,
      latestCommit,
      checkedAt: checkedAt.toISOString(),
    })
  })

  it('reports a failed check without hiding when it ran', async () => {
    const onError = vi.fn()
    const source = createServiceUpdateSource({
      deployedCommit,
      now: () => checkedAt,
      readLatestCommit: () => Promise.reject(new Error('origin refused the connection')),
      prepareCommit: () => Promise.resolve({ _tag: 'Ok', value: undefined }),
      onError,
    })

    await source.refresh()

    expect(source.read()).toEqual({
      _tag: 'Unavailable',
      deployedCommit,
      checkedAt: checkedAt.toISOString(),
      reason: 'The latest commit could not be checked. Retry later.',
    })
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })

  it('prepares the pinned commit from the accepted request', async () => {
    const prepareCommit = vi.fn(() => Promise.resolve({ _tag: 'Ok' as const, value: undefined }))
    const source = createServiceUpdateSource({
      deployedCommit,
      now: () => checkedAt,
      readLatestCommit: () => Promise.resolve(latestCommit),
      prepareCommit,
      onError: vi.fn(),
    })

    await expect(source.prepare(latestCommit)).resolves.toEqual({ _tag: 'Ok', value: undefined })
    expect(prepareCommit).toHaveBeenCalledWith(latestCommit)
  })
})

describe('deployed service update', () => {
  it('reports that a deploy updates the instance and refuses to prepare an update', async () => {
    const source = createDeployedServiceUpdateSource({
      deployedCommit: 'a'.repeat(40),
      now: () => new Date('2026-10-14T00:00:00.000Z'),
    })

    expect(source.read()).toEqual({
      _tag: 'Unavailable',
      deployedCommit: 'a'.repeat(40),
      checkedAt: '2026-10-14T00:00:00.000Z',
      reason: 'This instance updates with each Cloudflare deploy.',
    })
    expect(await source.prepare('b'.repeat(40))).toEqual({
      _tag: 'Err',
      error: 'This instance updates with each Cloudflare deploy.',
    })
  })
})
