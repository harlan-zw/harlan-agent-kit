import type { GitHubCheck, GitHubChecksSnapshot } from '../src/github-agent-source.ts'
import type { GitHubSource } from '../src/github.ts'
import type { RunnerLostRecoveryOptions } from '../src/runner-lost-recovery.ts'
import type { GitHubItem } from '../src/types.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { reconcileRepository } from '../src/reconcile.ts'
import { err, ok } from '../src/result.ts'
import { resolveRecoveredRunnerIncidents } from '../src/runner-lost-recovery.ts'
import { openJournalStore } from '../src/store.ts'
import { pullRequestItem, repositoryMapping } from './fixtures.ts'

const stores: Array<ReturnType<typeof openJournalStore>> = []
afterEach(() => stores.splice(0).forEach(store => store.close()))
const at = '2026-09-30T00:00:00.000Z'
const check = (overrides: Partial<GitHubCheck> = {}): GitHubCheck => ({ id: 1, name: 'test', source: { _tag: 'CheckRun', appId: 15368 }, status: 'completed', conclusion: 'success', failure: { _tag: 'NotAsked' }, ...overrides })
const healthy = (): GitHubChecksSnapshot => ({ _tag: 'Available', checks: [check()] })

function setup() {
  const repository = repositoryMapping()
  const store = openJournalStore(':memory:', true)
  stores.push(store)
  store.syncRepositories([repository], at)
  store.setRepositoryWritesEnabled(repository.github, true)
  const loss = () => store.recordIncident({ scope: { _tag: 'Repository', repository: repository.github }, kind: 'runner_lost', severity: 'warning', operation: 'read_checks', message: 'A runner lost its job.', recovery: { _tag: 'ActionRequired' }, at })
  loss()
  const items: GitHubItem[] = [pullRequestItem({ mergeState: 'clean' })]
  let finalItems = items
  let headChecks = healthy()
  let baseChecks = healthy()
  let defaultChecks = healthy()
  let defaultSha = 'default-sha'
  let onFinalRead = () => {}
  const reads: string[] = []
  let sourceReads = 0
  const checksBySha = new Map<string, GitHubChecksSnapshot>()
  const github: RunnerLostRecoveryOptions['github'] = {
    getOpenPullRequestCheckSources: async () => {
      sourceReads++
      if (sourceReads % 2 === 0)
        onFinalRead()
      const sourceItems = sourceReads % 2 === 0 ? finalItems : items
      return ok(sourceItems.flatMap(item => item.kind === 'pull_request' && item.state === 'open'
        ? [{ number: item.number, headSha: item.headSha, baseSha: item.baseSha, ...(item.baseRef === undefined ? {} : { baseRef: item.baseRef }) }]
        : []))
    },
    getDefaultBranchSnapshot: async () => ok({ baseSha: defaultSha, baseChecks: defaultChecks }),
    getCommitChecks: async (_mapping, sha, role) => {
      reads.push(`${role}:${sha}`)
      return checksBySha.get(sha) ?? (role === 'head' ? headChecks : baseChecks)
    },
  }
  return {
    store,
    repository,
    items,
    github,
    loss,
    reads,
    setChecks: (sha: string, checks: GitHubChecksSnapshot) => { checksBySha.set(sha, checks) },
    setHead: (checks: GitHubChecksSnapshot) => { headChecks = checks },
    setBase: (checks: GitHubChecksSnapshot) => { baseChecks = checks },
    setDefault: (checks: GitHubChecksSnapshot) => { defaultChecks = checks },
    setFinal: (value: GitHubItem[]) => { finalItems = value },
    onFinal: (run: () => void) => { onFinalRead = run },
    moveDefault: () => { defaultSha = 'moved-default' },
    run: (signal = new AbortController().signal) => resolveRecoveredRunnerIncidents({ repository, github, store, now: () => new Date(at) }, signal),
  }
}

describe('runner Incident recovery', () => {
  it('resolves a legacy grouped warning after full current CI proves recovery', async () => {
    const probe = setup()
    expect(await probe.run()).toEqual(ok(1))
    expect(probe.store.listIncidents()).toEqual([])
    expect(await probe.run()).toEqual(ok(0))
  })

  it('retires runner loss when completed jobs prove a real step failure, while preserving its CI result', async () => {
    const probe = setup()
    const failed: GitHubChecksSnapshot = { _tag: 'Available', checks: [check({ conclusion: 'failure', failure: { _tag: 'StepFailed' } })] }
    probe.setHead(failed)
    probe.setBase(failed)
    expect(await probe.run()).toEqual(ok(1))
    expect(await probe.github.getCommitChecks(probe.repository, 'abc123', 'head', new AbortController().signal)).toEqual(failed)
  })

  it.each(['head', 'base', 'default'] as const)('defers %s loss and incomplete or ambiguous evidence', async (source) => {
    const snapshots: GitHubChecksSnapshot[] = [
      { _tag: 'Unavailable', reason: 'GitHub unavailable.' },
      { _tag: 'Available', checks: [] },
      { _tag: 'Available', checks: [check({ status: 'in_progress', conclusion: null })] },
      { _tag: 'Available', checks: [check({ status: 'queued', conclusion: null })] },
      { _tag: 'Available', checks: [check({ conclusion: 'failure', failure: { _tag: 'RunnerLost', incompleteSteps: 3 } })] },
      { _tag: 'Available', checks: [check({ conclusion: 'failure', failure: { _tag: 'Unknown', reason: 'No steps.' } })] },
      { _tag: 'Available', checks: [check({ conclusion: 'failure' })] },
      { _tag: 'Available', checks: [check({ conclusion: 'skipped' }), check({ conclusion: 'neutral' })] },
    ]
    const probe = setup()
    for (const snapshot of snapshots) {
      if (source === 'head')
        probe.setHead(snapshot)
      else if (source === 'base')
        probe.setBase(snapshot)
      else
        probe.setDefault(snapshot)
      expect(await probe.run()).toMatchObject({ _tag: snapshot._tag === 'Unavailable' ? 'Err' : 'Ok' })
      expect(probe.store.listIncidents()).toHaveLength(1)
    }
  })

  it('includes an untrusted author and its nondefault base in the complete scope', async () => {
    const probe = setup()
    probe.items.push(pullRequestItem({ number: 25, author: 'dependabot[bot]', headSha: 'other-head', baseSha: 'stack-base', baseRef: 'stack' }))
    probe.setChecks('stack-base', { _tag: 'Available', checks: [check({ conclusion: 'failure', failure: { _tag: 'RunnerLost', incompleteSteps: 1 } })] })
    expect(await probe.run()).toEqual(ok(0))
    expect(probe.reads).toContain('base:stack-base')
    probe.setChecks('stack-base', healthy())
    expect(await probe.run()).toEqual(ok(1))
  })

  it.each(['head', 'base', 'baseRef', 'new-pr', 'default', 'policy', 'writes', 'new-loss', 'abort'] as const)('defers a concurrent %s change', async (change) => {
    const probe = setup()
    probe.onFinal(() => {
      if (change === 'head' || change === 'base' || change === 'baseRef') {
        probe.setFinal([pullRequestItem({ [change === 'head' ? 'headSha' : change === 'base' ? 'baseSha' : 'baseRef']: 'moved' })])
      }
      else if (change === 'new-pr') {
        probe.setFinal([...probe.items, pullRequestItem({ number: 26 })])
      }
      else if (change === 'default') {
        probe.moveDefault()
      }
      else if (change === 'policy') {
        probe.store.syncRepositories([{ ...probe.repository, defaultBranch: 'other-main' }], at)
      }
      else if (change === 'writes') {
        probe.store.setRepositoryWritesEnabled(probe.repository.github, false)
      }
      else if (change === 'new-loss') {
        probe.loss()
      }
    })
    const controller = new AbortController()
    if (change === 'abort')
      probe.onFinal(() => controller.abort())
    expect(await probe.run(controller.signal)).toMatchObject({ _tag: change === 'abort' ? 'Err' : 'Ok', ...(change === 'abort' ? {} : { value: 0 }) })
    expect(probe.store.listIncidents()).toHaveLength(1)
  })

  it('surfaces source errors without resolving the warning', async () => {
    const probe = setup()
    probe.github.getDefaultBranchSnapshot = async () => err('GitHub unavailable.')
    expect(await probe.run()).toEqual(err('GitHub unavailable.'))
    expect(probe.store.listIncidents()).toHaveLength(1)
  })

  it('runs recovery after a complete poll with all authors, and skips failed polls', async () => {
    const probe = setup()
    probe.items.push(pullRequestItem({ number: 25, author: 'dependabot[bot]', headSha: 'other-head' }))
    const github: Pick<GitHubSource, 'listOpenItems' | 'getIssue' | 'getPullRequest'> = {
      listOpenItems: async () => ok(probe.items),
      getIssue: async () => { throw new Error('Unexpected exact issue read.') },
      getPullRequest: async () => { throw new Error('Unexpected exact PR read.') },
    }
    let calls = 0
    const recoverRunnerIncidents = (repository: typeof probe.repository, signal: AbortSignal) => {
      calls++
      return resolveRecoveredRunnerIncidents({ repository, github: probe.github, store: probe.store, now: () => new Date(at) }, signal)
    }
    expect((await reconcileRepository(probe.repository, { github, store: probe.store, now: () => new Date(at), recoverRunnerIncidents }))._tag).toBe('Ok')
    expect(calls).toBe(1)
    expect(probe.reads).toContain('head:other-head')
    expect(probe.store.listIncidents()).toEqual([])
    probe.loss()
    github.listOpenItems = async () => err({ repository: probe.repository.github, message: 'Incomplete poll.' })
    expect((await reconcileRepository(probe.repository, { github, store: probe.store, now: () => new Date(at), recoverRunnerIncidents }))._tag).toBe('Err')
    expect(calls).toBe(1)
    expect(probe.store.listIncidents()).toContainEqual(expect.objectContaining({ kind: 'runner_lost' }))
  })

  it('reopens later loss and preserves unrelated operations and repositories', async () => {
    const probe = setup()
    probe.store.recordIncident({ scope: { _tag: 'Repository', repository: probe.repository.github }, kind: 'unknown', severity: 'error', operation: 'review_gate_refresh', message: 'CI failed.', recovery: { _tag: 'ActionRequired' }, at })
    probe.store.recordIncident({ scope: { _tag: 'Repository', repository: 'other/repo' }, kind: 'runner_lost', severity: 'warning', operation: 'read_checks', message: 'Another runner lost.', recovery: { _tag: 'ActionRequired' }, at })
    expect(await probe.run()).toEqual(ok(1))
    expect(probe.store.listIncidents()).toHaveLength(2)
    probe.loss()
    expect(probe.store.listIncidents()).toHaveLength(3)
  })

  it('recovers an old warning beneath more than 50 unrelated Incidents', async () => {
    const probe = setup()
    for (let index = 0; index < 60; index++)
      probe.store.recordIncident({ scope: { _tag: 'Service' }, kind: 'unknown', severity: 'error', operation: 'unrelated', message: `Other failure ${index}.`, recovery: { _tag: 'ActionRequired' }, at: '2026-09-30T00:01:00.000Z' })
    expect(probe.store.listIncidents().some(incident => incident.kind === 'runner_lost')).toBe(false)
    expect(await probe.run()).toEqual(ok(1))
    expect(probe.store.listRunnerLostIncidents(probe.repository.github)).toEqual([])
    expect(probe.store.listIncidents()).toHaveLength(50)
  })

  it('deduplicates shared head and base reads within one recovery pass', async () => {
    const probe = setup()
    probe.items.push(pullRequestItem({ number: 25, headSha: 'abc123' }))
    expect(await probe.run()).toEqual(ok(1))
    expect(probe.reads).toEqual(['head:abc123', 'base:base123'])
  })
})
