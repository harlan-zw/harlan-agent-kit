import type { Octokit } from 'octokit'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitHubAgentSource } from '../src/github-agent-source.ts'
import { createGitHubIssuePublisher } from '../src/github.ts'
import { nativeReviewBody } from '../src/native-review.ts'
import { createPublicTextGuard, privateDetailsFor, redactPrivateDetails } from '../src/public-text.ts'
import { ok } from '../src/result.ts'
import { openJournalStore } from '../src/store.ts'
import { repositoryMapping } from './fixtures.ts'

const details = privateDetailsFor({
  home: '/home/harlan',
  storagePath: '/home/harlan/.local/share/harlan-github-agent/state.sqlite',
  checkoutRoots: ['/home/harlan/pkg', '/home/harlan/sites'],
  workerHomes: ['/home/agent', '/home/harlan/.local/share/harlan-agent-kit/worker-home'],
  serviceOrigins: ['https://harlan-github-agent.localhost', 'https://hogwild.tail1234.ts.net'],
})

const stores: Array<ReturnType<typeof openJournalStore>> = []

afterEach(() => {
  stores.splice(0).forEach(store => store.close())
})

function journal() {
  const store = openJournalStore(':memory:')
  stores.push(store)
  return store
}

/** The Routine report harlan-zw/harlan-agent-kit#271 received on 2026-11-22. */
const leakedReport = `**2026-11-22T06:00:00.000Z** — Two workflows failed on main.

Full notes: https://notes.localhost/notes/ci-review-2026-11-22
Evidence is in \`~/scratch/ci-review-2026-11-22/\`.`

describe('redactPrivateDetails', () => {
  it('removes the notes link and the scratch path from a Routine report', () => {
    const redacted = redactPrivateDetails(leakedReport, details)

    expect(redacted.text).not.toContain('notes.localhost')
    expect(redacted.text).not.toContain('scratch')
    expect(redacted.text).toContain('Two workflows failed on main.')
    expect(redacted.hits.map(hit => hit.entry).sort()).toEqual(['notes.localhost', '~/scratch'])
  })

  it('removes a Markdown link to a private host as a whole', () => {
    const redacted = redactPrivateDetails('Read [the CI notes](https://notes.localhost/notes/ci-review-x) first.', details)

    expect(redacted.text).toBe('Read [private link] first.')
  })

  it('removes a path inside an agent worktree or the worker home', () => {
    const redacted = redactPrivateDetails([
      'Ran /home/harlan/pkg/harlan-agent-kit.fix-x/packages/a/src/index.ts.',
      'Cache at /home/agent/.cache/pnpm',
      'Worktree /home/harlan/.local/share/harlan-github-agent/worktrees/abc/src',
    ].join('\n'), details)

    expect(redacted.text).toBe([
      'Ran [private path].',
      'Cache at [private path]',
      'Worktree [private path]',
    ].join('\n'))
  })

  it('removes a tilde path that a native review encoded as an HTML entity', () => {
    const redacted = redactPrivateDetails('See &#126;/scratch/ci-review&#95;2026/report.md for proof.', details)

    expect(redacted.text).toBe('See [private path] for proof.')
  })

  it('derives aliases only for protected roots inside the normalized controller home', () => {
    const configured = privateDetailsFor({
      home: '/home/harlan/./',
      storagePath: '/home/harlan/state/../journal/state.sqlite',
      checkoutRoots: ['/home/harlan/pkg/', '/home/harlan-other/sites', '/srv/checkouts'],
      workerHomes: ['/home/harlan/workers/agent', '/home/agent'],
      serviceOrigins: [],
    })

    expect(redactPrivateDetails([
      '~/journal/run',
      '$HOME/journal/run',
      '~/workers/agent/cache',
      '$HOME/workers/agent/cache',
      '~/pkg/worktree',
      '$HOME/pkg/worktree',
      '~/sites/example',
      '$HOME/sites/example',
      '~/checkouts/example',
      '~/.config/app',
      '$HOME/.config/app',
      '~/pkg-extra/example',
    ].join('\n'), configured).text).toBe([
      ...Array.from({ length: 6 }).fill('[private path]'),
      '~/sites/example',
      '$HOME/sites/example',
      '~/checkouts/example',
      '~/.config/app',
      '$HOME/.config/app',
      '~/pkg-extra/example',
    ].join('\n'))
  })

  it('removes the Service dashboard hosts', () => {
    const redacted = redactPrivateDetails('Open https://harlan-github-agent.localhost/tasks/1 or https://hogwild.tail1234.ts.net/.', details)

    expect(redacted.text).toBe('Open [private link] or [private link].')
  })

  it('keeps the local dashboard host private when the configured origin is a Tailscale host', () => {
    const tailscaleOnly = privateDetailsFor({ home: '/home/harlan', storagePath: ':memory:', checkoutRoots: [], workerHomes: [], serviceOrigins: ['https://hogwild.tail1234.ts.net'] })

    expect(redactPrivateDetails('Open https://harlan-github-agent.localhost/tasks/1.', tailscaleOnly).text).toBe('Open [private link].')
  })

  it.each([
    ['See https://notes.localhost.', 'See [private link].'],
    ['Evidence is in ~/scratch.', 'Evidence is in [private path].'],
    ['Ran in /home/agent.', 'Ran in [private path].'],
  ])('removes a private entry that ends a sentence: %s', (text, expected) => {
    expect(redactPrivateDetails(text, details).text).toBe(expected)
  })

  it.each([
    'Set the key in ~/.config/opencode/opencode.json.',
    'The dev server answers on http://localhost:3000/api/health.',
    'The example config reads /home/harlan/.config/harlan-github-agent/app.pem.',
    'The preview runs at https://example.localhost.',
    'Paths like ~/scratchpad stay.',
    'A file named ~/scratch.txt stays.',
    'The host notes.localhost.example.com stays.',
  ])('keeps text a finding may legitimately quote: %s', (text) => {
    expect(redactPrivateDetails(text, details)).toEqual({ text, hits: [] })
  })
})

describe('the publish boundary', () => {
  it('redacts absolute and home-relative checkout roots before GitHub receives a comment', async () => {
    const sent: string[] = []
    const publisher = createGitHubIssuePublisher({
      createClient: () => ({ rest: { issues: { createComment: async (input: { body: string }) => {
        sent.push(input.body)
        return { data: { id: 7 } }
      } } } }) as unknown as Octokit,
      publicText: createPublicTextGuard({ details, store: journal(), now: () => new Date('2026-11-22T06:05:00.000Z') }),
      tokens: { getToken: async () => ok({ token: 'fixture-token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    })
    const paths = ['pkg', 'sites'].flatMap(root => ['/home/harlan', '~', '$HOME'].map(home => `${home}/${root}/example-worktree`))

    expect(await publisher.createComment({ repository: repositoryMapping(), issueNumber: 24, body: [...paths, '~/.config'].join('\n') })).toEqual(ok({ id: 7 }))

    expect(sent).toEqual([[...paths.map(() => '[private path]'), '~/.config'].join('\n')])
  })

  it('redacts a Routine report comment before GitHub receives it and records an Incident', async () => {
    const store = journal()
    const sent: string[] = []
    const client = {
      rest: { issues: { createComment: (input: { body: string }) => {
        sent.push(input.body)
        return Promise.resolve({ data: { id: 7 } })
      } } },
    } as unknown as Octokit
    const publisher = createGitHubIssuePublisher({
      createClient: () => client,
      publicText: createPublicTextGuard({ details, store, now: () => new Date('2026-11-22T06:05:00.000Z') }),
      tokens: {
        getToken: async () => ok({ token: 'token', expiresAt: '2026-11-22T07:00:00.000Z' }),
        invalidate: () => undefined,
      },
    })

    const result = await publisher.createComment({ repository: repositoryMapping({ github: 'harlan-zw/harlan-agent-kit' }), issueNumber: 271, body: leakedReport })

    expect(result).toEqual(ok({ id: 7 }))
    expect(sent).toHaveLength(1)
    expect(sent[0]).not.toContain('notes.localhost')
    expect(sent[0]).not.toContain('~/scratch')
    expect(store.listIncidents()).toEqual([expect.objectContaining({
      scope: { _tag: 'Repository', repository: 'harlan-zw/harlan-agent-kit' },
      kind: 'private_detail',
      recovery: { _tag: 'ActionRequired' },
      message: expect.stringContaining('harlan-zw/harlan-agent-kit#271'),
    })])
  })

  it('cleans a canonical comment GitHub already holds with a leak, and confirms the edit', async () => {
    const store = journal()
    const headSha = '1031dc93dddca88266cb32a085c7b90dcd58ec23'
    const leaked = `<!-- harlan-agent-kit:pr-triage -->
<!-- reviewed-sha: ${headSha} -->
### 🤖 REVIEWING

Notes: ~/notes/review-24.md`
    const stopped = `<!-- harlan-agent-kit:pr-triage -->
<!-- reviewed-sha: ${headSha} -->
### 🤖 STOPPED

Notes: ~/notes/review-24.md`
    const comment = {
      id: 5,
      body: leaked,
      html_url: 'https://github.com/harlan-zw/example/pull/24#issuecomment-5',
      issue_url: 'https://api.github.com/repos/harlan-zw/example/issues/24',
      user: { login: 'harlan-github-agent[bot]' },
    }
    const client = {
      rest: { issues: {
        getComment: () => Promise.resolve({ data: comment }),
        updateComment: (input: { body: string }) => {
          comment.body = input.body
          return Promise.resolve({ data: comment })
        },
      } },
    } as unknown as Octokit
    const source = createGitHubAgentSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => client,
      ownAppId: 98114,
      publicText: createPublicTextGuard({ details, store, now: () => new Date('2026-11-22T06:05:00.000Z') }),
      tokens: {
        getToken: () => Promise.resolve(ok({ token: 'app-token', expiresAt: '2026-11-22T07:00:00.000Z' })),
        invalidate: () => undefined,
      },
    })

    const result = await source.editReviewStatus(repositoryMapping(), 24, 5, leaked, stopped, new AbortController().signal)

    expect(result).toEqual(ok({ _tag: 'Edited', commentId: 5, url: comment.html_url }))
    expect(comment.body).toContain('### 🤖 STOPPED')
    expect(comment.body).toContain('Notes: [private path]')
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail', message: expect.stringContaining('harlan-zw/example#24') })])
  })

  it('redacts a follow-up in the native review after its text was entity-encoded', async () => {
    const store = journal()
    const headSha = 'a'.repeat(40)
    const written: string[] = []
    const source = createGitHubAgentSource({
      actorLogin: () => 'harlan-github-agent[bot]',
      createClient: () => ({
        paginate: async () => [],
        rest: { pulls: {
          listReviews: () => undefined,
          createReview: async (input: { commit_id: string, body: string }) => {
            written.push(input.body)
            return { data: { id: 1, user: { login: 'harlan-github-agent[bot]' }, state: 'COMMENTED', commit_id: input.commit_id, body: input.body } }
          },
        } },
      }) as unknown as Octokit,
      ownAppId: 98114,
      publicText: createPublicTextGuard({ details, store, now: () => new Date('2026-11-22T06:05:00.000Z') }),
      tokens: { getToken: async () => ok({ token: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    })
    const body = nativeReviewBody({
      repository: 'harlan-zw/example',
      headSha,
      outcome: 'READY',
      commentUrl: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
      findings: [{
        _tag: 'Logged',
        impact: 40,
        summary: 'The cache key ignores the locale.',
        nextAction: 'Key the cache by locale.',
        details: { fingerprint: 'f'.repeat(64), identity: 'cache-locale', location: { path: 'src/cache.ts', line: 3 }, proof: 'The trace in ~/pkg/cache_trace/run.log shows two locales sharing one key.' },
      }],
    })

    expect(await source.upsertNativeReview(repositoryMapping(), 24, headSha, body, new AbortController().signal, () => ok(undefined))).toEqual(ok(undefined))
    expect(written).toHaveLength(1)
    expect(written[0]).not.toContain('/pkg')
    expect(written[0]).toContain('The trace in [private path] shows two locales sharing one key.')
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail', message: expect.stringContaining('the review on harlan-zw/example#24') })])
  })
})
