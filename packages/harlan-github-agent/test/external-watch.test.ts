import { describe, expect, it } from 'vitest'
import { createExternalWatchController, createReloadableExternalWatchController, mergeExternalWatchSnapshot } from '../src/external-watch.ts'
import { dashboardSnapshot } from './fixtures.ts'

describe('external repository watches', () => {
  it('observes only exact public issues without adding executable Queue work', async () => {
    const controller = createExternalWatchController({
      watches: [{ github: 'nuxt-modules/sitemap', issues: [658] }],
      issueCutoff: '2026-07-14',
      now: () => new Date('2026-08-13T13:00:00.000Z'),
      requestIssue: (_repository, number) => Promise.resolve({
        number,
        state: 'open',
        title: 'fix: Site map generation error during prerendering on Nuxt v5',
        author: 'SharpIceX',
        url: 'https://github.com/nuxt-modules/sitemap/issues/658',
        createdAt: '2026-08-13T12:04:49Z',
        updatedAt: '2026-08-13T12:04:49Z',
        isPullRequest: false,
      }),
    })

    await controller.poll()
    const snapshot = mergeExternalWatchSnapshot(dashboardSnapshot(), controller.snapshot())

    expect(snapshot.items).toContainEqual(expect.objectContaining({
      kind: 'issue',
      repository: 'nuxt-modules/sitemap',
      number: 658,
    }))
    expect(snapshot.repositories).toContainEqual(expect.objectContaining({
      github: 'nuxt-modules/sitemap',
      ownership: 'external',
      subjectCount: 1,
    }))
    expect(snapshot.queue).toEqual([])
  })

  it('shows public GitHub failures in repository health', async () => {
    const controller = createExternalWatchController({
      watches: [{ github: 'nuxt-modules/sitemap', issues: [658] }],
      issueCutoff: '2026-07-14',
      now: () => new Date('2026-08-13T13:00:00.000Z'),
      requestIssue: () => Promise.reject(new Error('GitHub rate limit reached.')),
    })

    await controller.poll()

    expect(controller.snapshot().repositories[0]).toEqual(expect.objectContaining({
      lastError: 'GitHub rate limit reached.',
      subjectCount: 0,
    }))
  })

  it('surfaces a failed watch on a repository the snapshot also maintains', async () => {
    const controller = createExternalWatchController({
      watches: [{ github: 'harlan-zw/example', issues: [12] }],
      issueCutoff: '2026-07-14',
      now: () => new Date('2026-08-13T13:00:00.000Z'),
      requestIssue: () => Promise.reject(new Error('GitHub rate limit reached.')),
    })
    await controller.poll()

    const existing = dashboardSnapshot()
    existing.repositories.push({
      github: 'harlan-zw/example',
      enabled: true,
      writesEnabled: true,
      ownership: 'maintained',
      lastAttemptAt: '2026-08-13T01:00:00.000Z',
      lastSuccessAt: '2026-08-13T01:00:00.000Z',
      lastError: null,
      paused: false,
      subjectCount: 3,
    })
    const merged = mergeExternalWatchSnapshot(existing, controller.snapshot())

    expect(merged.status).toBe('degraded')
    expect(merged.repositories.find(repository => repository.github === 'harlan-zw/example')).toEqual(expect.objectContaining({
      ownership: 'maintained',
      lastError: 'GitHub rate limit reached.',
    }))
  })

  it('lists all current human issues for a repository watch', async () => {
    const controller = createExternalWatchController({
      watches: [{ github: 'nuxt-modules/robots', issues: 'all' }],
      issueCutoff: '2026-07-14',
      now: () => new Date('2026-08-13T13:00:00.000Z'),
      requestIssues: () => Promise.resolve([
        {
          number: 100,
          state: 'open',
          title: 'Human issue',
          author: 'contributor',
          url: 'https://github.com/nuxt-modules/robots/issues/100',
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-13T00:00:00.000Z',
          isPullRequest: false,
        },
        {
          number: 101,
          state: 'open',
          title: 'Pull request',
          author: 'contributor',
          url: 'https://github.com/nuxt-modules/robots/pull/101',
          createdAt: '2026-08-12T00:00:00.000Z',
          updatedAt: '2026-08-13T00:00:00.000Z',
          isPullRequest: true,
        },
      ]),
    })

    await controller.poll()

    expect(controller.snapshot().items.map(subject => subject.number)).toEqual([100])
  })

  it('keeps the prior public issues when a reload cannot read GitHub', async () => {
    const now = () => new Date('2026-09-28T04:00:00.000Z')
    const issue = {
      number: 658,
      state: 'open' as const,
      title: 'Existing issue',
      author: 'contributor',
      url: 'https://github.com/nuxt-modules/sitemap/issues/658',
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      isPullRequest: false,
    }
    const controller = createReloadableExternalWatchController({
      watches: [{ github: 'nuxt-modules/sitemap', issues: [658] }],
      issueCutoff: '2026-07-14',
      now,
      requestIssue: () => Promise.resolve(issue),
    })
    await controller.poll()

    const result = await controller.reload({
      watches: [{ github: 'nuxt-modules/sitemap', issues: 'all' }],
      issueCutoff: '2026-07-14',
      now,
      requestIssues: () => Promise.reject(new Error('GitHub rate limit reached.')),
    })

    expect(result).toEqual({ _tag: 'Err', error: 'nuxt-modules/sitemap: GitHub rate limit reached.' })
    expect(controller.snapshot().items.map(item => item.number)).toEqual([658])
  })

  it('applies a second reload issued while one is still in flight', async () => {
    const now = () => new Date('2026-09-28T04:00:00.000Z')
    let releaseFirstPoll: (() => void) | undefined
    const firstPoll = new Promise<void>(resolve => (releaseFirstPoll = resolve))
    const controller = createReloadableExternalWatchController({
      watches: [{ github: 'nuxt-modules/sitemap', issues: [658] }],
      issueCutoff: '2026-07-14',
      now,
      requestIssue: () => Promise.resolve({
        number: 658,
        state: 'open',
        title: 'Startup issue',
        author: 'contributor',
        url: 'https://github.com/nuxt-modules/sitemap/issues/658',
        createdAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:00.000Z',
        isPullRequest: false,
      }),
    })
    await controller.poll()

    const first = controller.reload({
      watches: [{ github: 'nuxt-modules/robots', issues: 'all' }],
      issueCutoff: '2026-07-14',
      now,
      requestIssues: () => firstPoll.then(() => [{
        number: 658,
        state: 'open',
        title: 'In-flight issue',
        author: 'contributor',
        url: 'https://github.com/nuxt-modules/robots/issues/658',
        createdAt: '2026-09-26T00:00:00.000Z',
        updatedAt: '2026-09-26T00:00:00.000Z',
        isPullRequest: false,
      }]),
    })
    const second = controller.reload({
      watches: [{ github: 'nuxt-modules/sitemap', issues: [658, 659] }],
      issueCutoff: '2026-07-14',
      now,
      requestIssue: (_repository, number) => Promise.resolve({
        number,
        state: 'open',
        title: `Newest issue ${number}`,
        author: 'contributor',
        url: `https://github.com/nuxt-modules/sitemap/issues/${number}`,
        createdAt: '2026-09-27T00:00:00.000Z',
        updatedAt: '2026-09-27T00:00:00.000Z',
        isPullRequest: false,
      }),
    })
    releaseFirstPoll?.()

    expect(await second).toEqual({ _tag: 'Ok', value: { repositories: 1, issues: 2 } })
    expect(await first).toEqual({ _tag: 'Ok', value: { repositories: 1, issues: 1 } })
    expect(controller.snapshot().items.map(item => item.number)).toEqual([658, 659])
  })

  it('shows the new public issues after a successful reload', async () => {
    const now = () => new Date('2026-09-28T04:00:00.000Z')
    const controller = createReloadableExternalWatchController({
      watches: [{ github: 'nuxt-modules/sitemap', issues: [658] }],
      issueCutoff: '2026-07-14',
      now,
      requestIssue: () => Promise.resolve({
        number: 658,
        state: 'open',
        title: 'Old issue',
        author: 'contributor',
        url: 'https://github.com/nuxt-modules/sitemap/issues/658',
        createdAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:00.000Z',
        isPullRequest: false,
      }),
    })
    await controller.poll()

    const result = await controller.reload({
      watches: [{ github: 'nuxt-modules/sitemap', issues: 'all' }],
      issueCutoff: '2026-07-14',
      now,
      requestIssues: () => Promise.resolve([{
        number: 676,
        state: 'open',
        title: 'New issue',
        author: 'contributor',
        url: 'https://github.com/nuxt-modules/sitemap/issues/676',
        createdAt: '2026-09-26T00:00:00.000Z',
        updatedAt: '2026-09-26T00:00:00.000Z',
        isPullRequest: false,
      }]),
    })

    expect(result).toEqual({ _tag: 'Ok', value: { repositories: 1, issues: 1 } })
    expect(controller.snapshot().items.map(item => item.number)).toEqual([676])
    const existing = dashboardSnapshot()
    existing.repositories.push({ ...controller.snapshot().repositories[0]!, ownership: 'maintained' })
    const merged = mergeExternalWatchSnapshot(existing, controller.snapshot())
    expect(merged.items.map(item => item.number)).toEqual([676])
    expect(merged.repositories.filter(repository => repository.github === 'nuxt-modules/sitemap')).toHaveLength(1)
  })
})
