import { expect, it } from 'vitest'
import { reconcilePackageReleases } from '../src/package-release-controller.ts'
import { runPassStepResult } from '../src/poll-pass.ts'
import { createPassIncidentRecorder, reconcilePackageReleasePass } from '../src/service.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

it('records no Incident when Pause stops an in-flight release request', async () => {
  const store = openJournalStore(':memory:')
  const signal = new AbortController().signal
  const repository = {
    ...repositoryMapping(),
    release: {
      manifest: 'package.json',
      versionFiles: ['package.json'],
      tagPrefix: 'v',
      workflow: 'release.yml',
      checks: ['test'],
      credential: { _tag: 'Repository' as const },
    },
  }
  let allowed = true
  let comments = 0
  const defects: string[] = []
  const record = createPassIncidentRecorder({ store, signal, now: () => new Date('2026-10-13T00:00:00Z') })
  try {
    await reconcilePackageReleasePass({
      repositories: [repository],
      mayPublish: () => allowed,
      guarded: (step, run) =>
        runPassStepResult(step, run, { signal, onDefect: (_step, reason) => defects.push(reason) }),
      record,
      reconcile: async () => {
        await reconcilePackageReleases({
          repository,
          store,
          signal,
          webhookReady: true,
          now: () => 1000,
          mayPublish: () => allowed,
          source: (assertLease) => ({
            candidates: async () => {
              allowed = false
              assertLease()
              return []
            },
            inspect: async () => {
              throw new Error('Pause must stop inspection.')
            },
            comment: async () => {
              comments++
              return 99
            },
            prepare: async () => null,
            merge: async () => null,
            publish: async () => null,
          }),
        })
      },
    })
    expect(store.listIncidents()).toEqual([])
    expect(defects).toEqual([])
    expect(comments).toBe(0)
    expect(store.listPackageReleases(repository.github)).toEqual([])
    expect(store.claimPackageReleaseLease(repository.github, 1000)).not.toBeNull()
  } finally {
    store.close()
  }
})

it.each([
  {
    reason: 'No server is currently available to service your request.',
    kind: 'github_unavailable',
    severity: 'warning',
    recovery: 'OnNextOperation',
  },
  {
    reason:
      'The GitHub account wolfstar-project hit the primary GitHub rate limit. Requests pause until 2026-10-12T05:42:05.000Z.',
    kind: 'rate_limit',
    severity: 'warning',
    recovery: 'OnNextOperation',
  },
  { reason: 'The release plan is invalid.', kind: 'unknown', severity: 'error', recovery: 'ActionRequired' },
])(
  'preserves $kind release failures when a later repository succeeds',
  async ({ reason, kind, severity, recovery }) => {
    const store = openJournalStore(':memory:')
    const signal = new AbortController().signal
    const repositories = ['wolfstar-project/failed', 'wolfstar-project/healthy'].map((github) => ({
      ...repositoryMapping(),
      github,
    }))
    const record = createPassIncidentRecorder({ store, signal, now: () => new Date('2026-10-10T15:00:00Z') })
    record('package_release', ['wolfstar-project/failed: package release reconciliation failed.'])
    try {
      await reconcilePackageReleasePass({
        repositories,
        mayPublish: () => true,
        reconcile: async (repository) => {
          if (repository.github.endsWith('/failed')) throw new Error(reason)
        },
        guarded: (step, run) => runPassStepResult(step, run, { signal, onDefect: () => {} }),
        record,
      })
      expect(store.listIncidents()).toMatchObject([
        {
          operation: 'package_release',
          message: `wolfstar-project/failed: ${reason}`,
          kind,
          severity,
          recovery: { _tag: recovery },
        },
      ])
    } finally {
      store.close()
    }
  },
)

it.each(['recovered', 'no repositories', 'all paused'])(
  'clears earlier release failures when the next pass has %s',
  async (scenario) => {
    const store = openJournalStore(':memory:')
    const signal = new AbortController().signal
    const record = createPassIncidentRecorder({ store, signal, now: () => new Date('2026-10-10T15:00:00Z') })
    record('package_release', ['wolfstar-project/failed: package release reconciliation failed.'])
    try {
      await reconcilePackageReleasePass({
        repositories: scenario === 'no repositories' ? [] : [repositoryMapping()],
        mayPublish: () => scenario !== 'all paused',
        reconcile: async () => {
          if (scenario === 'all paused') throw new Error('A paused repository must not reconcile.')
        },
        guarded: (step, run) => runPassStepResult(step, run, { signal, onDefect: () => {} }),
        record,
      })
      expect(store.listIncidents()).toEqual([])
    } finally {
      store.close()
    }
  },
)

it('preserves earlier release failures when shutdown aborts a pass', async () => {
  const store = openJournalStore(':memory:')
  const controller = new AbortController()
  const signal = controller.signal
  const record = createPassIncidentRecorder({ store, signal, now: () => new Date('2026-10-10T15:00:00Z') })
  record('package_release', ['wolfstar-project/failed: package release reconciliation failed.'])
  try {
    await reconcilePackageReleasePass({
      repositories: [repositoryMapping()],
      mayPublish: () => true,
      reconcile: async () => {
        controller.abort()
        throw new Error('This operation was aborted.')
      },
      guarded: (step, run) => runPassStepResult(step, run, { signal, onDefect: () => {} }),
      record,
    })
    expect(store.listIncidents().map((incident) => incident.message)).toEqual([
      'wolfstar-project/failed: package release reconciliation failed.',
    ])
  } finally {
    store.close()
  }
})
