import { describe, expect, it } from 'vitest'
import { createExternalWatchController, mergeExternalWatchSnapshot } from '../src/external-watch.ts'
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

    expect(snapshot.subjects).toContainEqual(expect.objectContaining({
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

    expect(controller.snapshot().subjects.map(subject => subject.number)).toEqual([100])
  })
})
