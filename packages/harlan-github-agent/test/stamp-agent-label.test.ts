import type { Octokit } from 'octokit'
import { describe, expect, it, vi } from 'vitest'
import { ok } from '../src/result.ts'
import { repositoryMapping } from './fixtures.ts'

const hoisted = vi.hoisted(() => {
  const state = {
    /** What `issues.get` answers, in call order. */
    reads: [] as string[][],
    /** What `addLabels` answers, whatever it was asked to add. */
    added: [] as string[],
    getCalls: 0,
    removed: [] as string[],
    malformedWrite: undefined as unknown,
    malformedRead: undefined as unknown,
  }
  const octokit = {
    rest: {
      issues: {
        get: () => {
          const labels = state.reads[state.getCalls] ?? state.reads.at(-1) ?? []
          state.getCalls += 1
          return Promise.resolve({ data: { labels: state.malformedRead === undefined ? labels.map(name => ({ name })) : state.malformedRead } })
        },
        createLabel: () => Promise.resolve({ data: {} }),
        addLabels: () => Promise.resolve({ data: state.malformedWrite === undefined ? state.added.map(name => ({ name })) : state.malformedWrite }),
        removeLabel: (input: { name: string }) => {
          state.removed.push(input.name)
          return Promise.resolve({ data: state.malformedWrite === undefined ? state.added.filter(name => name !== input.name).map(name => ({ name })) : state.malformedWrite })
        },
      },
    },
  }
  return { state, octokit }
})

vi.mock('../src/github-auth.ts', () => ({
  createAuthenticatedClient: () => hoisted.octokit as unknown as Octokit,
}))

const { createGitHubAgentSource } = await import('../src/github-agent-source.ts')

function source() {
  return createGitHubAgentSource({
    actorLogin: () => 'harlan-agent[bot]',
    ownAppId: 98114,
    tokens: {
      getToken: () => Promise.resolve(ok({ token: 'token', expiresAt: '2026-08-14T02:00:00.000Z' })),
      invalidate: () => undefined,
    },
  })
}

function reset(input: { reads: string[][], added: string[] }): void {
  hoisted.state.reads = input.reads
  hoisted.state.added = input.added
  hoisted.state.getCalls = 0
  hoisted.state.removed = []
  hoisted.state.malformedWrite = undefined
  hoisted.state.malformedRead = undefined
}

describe('stamping one agent label', () => {
  it.each([null, {}, [null], [{ name: 5 }]])('confirms a malformed label write through one authoritative read: %j', async (value) => {
    reset({ reads: [[], ['harlan-agent-running']], added: [] })
    hoisted.state.malformedWrite = value
    expect(await source().stampAgentLabel(repositoryMapping(), 24, 'RUNNING', AbortSignal.timeout(1000))).toEqual({ _tag: 'Ok', value: undefined })
    expect(hoisted.state.getCalls).toBe(2)
  })

  it('confirms malformed removal responses without accepting stale verdict labels', async () => {
    reset({ reads: [['harlan-agent-blocked'], ['harlan-agent-running', 'harlan-agent-blocked'], ['harlan-agent-running']], added: [] })
    hoisted.state.malformedWrite = {}
    expect(await source().stampAgentLabel(repositoryMapping(), 24, 'RUNNING', AbortSignal.timeout(1000))).toEqual({ _tag: 'Ok', value: undefined })
    expect(hoisted.state.removed).toEqual(['harlan-agent-blocked'])
    expect(hoisted.state.getCalls).toBe(3)
  })

  it('rejects malformed initial labels without treating them as an empty list', async () => {
    reset({ reads: [[]], added: [] })
    hoisted.state.malformedRead = {}
    expect(await source().stampAgentLabel(repositoryMapping(), 24, 'RUNNING', AbortSignal.timeout(1000))).toMatchObject({ _tag: 'Err', error: expect.stringContaining('issues.get returned invalid labels (object)') })
    expect(hoisted.state.getCalls).toBe(1)
  })

  it('confirms malformed approval additions through the same strict read boundary', async () => {
    reset({ reads: [['harlan-agent-review']], added: [] })
    hoisted.state.malformedWrite = {}
    expect(await source().addApprovalLabel(repositoryMapping(), 24, 'harlan-agent-review', AbortSignal.timeout(1000))).toEqual({ _tag: 'Ok', value: undefined })
    expect(hoisted.state.getCalls).toBe(1)
  })

  it('reports both response contexts when the approval confirmation is also malformed', async () => {
    reset({ reads: [[]], added: [] })
    hoisted.state.malformedWrite = {}
    hoisted.state.malformedRead = {}
    expect(await source().addApprovalLabel(repositoryMapping(), 24, 'harlan-agent-review', AbortSignal.timeout(1000))).toEqual({ _tag: 'Err', error: 'GitHub addLabels returned invalid labels (object). GitHub issues.get after addLabels returned invalid labels (object).' })
  })

  it('does not accept a malformed write when a fresh read lacks its intended label', async () => {
    reset({ reads: [[], []], added: [] })
    hoisted.state.malformedWrite = { unexpected: 'response' }
    const result = await source().stampAgentLabel(repositoryMapping(), 24, 'RUNNING', AbortSignal.timeout(1000))
    expect(result).toMatchObject({ _tag: 'Err', error: expect.stringContaining('did not stamp') })
    expect(hoisted.state.getCalls).toBe(2)
  })

  it('trusts the write answer, so a Task that settles at once still reports a landed stamp', async () => {
    // GitHub answers the write with the label, then the Task settles and takes
    // it off again. A fresh read would show it gone and call the write failed.
    reset({ reads: [[], []], added: ['harlan-agent-running'] })

    const result = await source().stampAgentLabel(repositoryMapping(), 24, 'RUNNING', AbortSignal.timeout(1000))

    expect(result).toEqual({ _tag: 'Ok', value: undefined })
    expect(hoisted.state.getCalls).toBe(1)
  })

  it('reports a stamp GitHub answered without the label', async () => {
    reset({ reads: [[]], added: [] })

    const result = await source().stampAgentLabel(repositoryMapping(), 24, 'RUNNING', AbortSignal.timeout(1000))

    expect(result).toEqual({
      _tag: 'Err',
      error: 'GitHub did not stamp the harlan-agent-running label. GitHub answered with no labels.',
    })
  })

  it('writes nothing when the item already carries the label', async () => {
    reset({ reads: [['harlan-agent-running']], added: ['harlan-agent-running'] })

    const result = await source().stampAgentLabel(repositoryMapping(), 24, 'RUNNING', AbortSignal.timeout(1000))

    expect(result).toEqual({ _tag: 'Ok', value: undefined })
    expect(hoisted.state.getCalls).toBe(1)
    expect(hoisted.state.removed).toEqual([])
  })

  it('takes the verdict labels off while it stamps the Running label', async () => {
    reset({ reads: [['harlan-agent-blocked']], added: ['harlan-agent-running', 'harlan-agent-blocked'] })

    const result = await source().stampAgentLabel(repositoryMapping(), 24, 'RUNNING', AbortSignal.timeout(1000))

    expect(result).toEqual({ _tag: 'Ok', value: undefined })
    expect(hoisted.state.removed).toEqual(['harlan-agent-blocked'])
  })
})
