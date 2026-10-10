import { expect, it } from 'vitest'
import { runPassStep } from '../src/poll-pass.ts'
import { createPassIncidentRecorder, reconcilePackageReleasePass } from '../src/service.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

it('keeps a failed release repository when a later repository succeeds', async () => {
  const store = openJournalStore(':memory:')
  const signal = new AbortController().signal
  const repositories = ['harlan-zw/failed', 'harlan-zw/healthy'].map(github => ({ ...repositoryMapping(), github }))
  const record = createPassIncidentRecorder({ store, signal, now: () => new Date('2026-10-10T15:00:00Z') })
  try {
    await reconcilePackageReleasePass({
      repositories,
      mayPublish: () => true,
      reconcile: async (repository) => {
        if (repository.github.endsWith('/failed'))
          throw new Error('GitHub returned 502.')
      },
      guarded: (step, run, fallback) => runPassStep(step, run, fallback, { signal, onDefect: () => {} }),
      record,
    })
    expect(store.listIncidents()).toMatchObject([{
      operation: 'package_release',
      message: 'harlan-zw/failed: package release reconciliation failed.',
    }])
  }
  finally {
    store.close()
  }
})

it.each(['recovered', 'no repositories', 'all paused'])('clears earlier release failures when the next pass has %s', async (scenario) => {
  const store = openJournalStore(':memory:')
  const signal = new AbortController().signal
  const record = createPassIncidentRecorder({ store, signal, now: () => new Date('2026-10-10T15:00:00Z') })
  record('package_release', ['harlan-zw/failed: package release reconciliation failed.'])
  try {
    await reconcilePackageReleasePass({
      repositories: scenario === 'no repositories' ? [] : [repositoryMapping()],
      mayPublish: () => scenario !== 'all paused',
      reconcile: async () => {
        if (scenario === 'all paused')
          throw new Error('A paused repository must not reconcile.')
      },
      guarded: (step, run, fallback) => runPassStep(step, run, fallback, { signal, onDefect: () => {} }),
      record,
    })
    expect(store.listIncidents()).toEqual([])
  }
  finally {
    store.close()
  }
})

it('preserves earlier release failures when shutdown aborts a pass', async () => {
  const store = openJournalStore(':memory:')
  const controller = new AbortController()
  const signal = controller.signal
  const record = createPassIncidentRecorder({ store, signal, now: () => new Date('2026-10-10T15:00:00Z') })
  record('package_release', ['harlan-zw/failed: package release reconciliation failed.'])
  try {
    await reconcilePackageReleasePass({
      repositories: [repositoryMapping()],
      mayPublish: () => true,
      reconcile: async () => {
        controller.abort()
        throw new Error('This operation was aborted.')
      },
      guarded: (step, run, fallback) => runPassStep(step, run, fallback, { signal, onDefect: () => {} }),
      record,
    })
    expect(store.listIncidents().map(incident => incident.message)).toEqual([
      'harlan-zw/failed: package release reconciliation failed.',
    ])
  }
  finally {
    store.close()
  }
})
