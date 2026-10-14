import { expect, it } from 'vitest'
import { runPassStepResult } from '../src/poll-pass.ts'
import { createPassIncidentRecorder, reconcilePackageReleasePass } from '../src/service.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

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
