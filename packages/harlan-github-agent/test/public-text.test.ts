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
        details: { fingerprint: 'f'.repeat(64), identity: 'cache-locale', location: { path: 'src/cache.ts', line: 3 }, proof: 'The trace in ~/scratch/cache_trace/run.log shows two locales sharing one key.' },
      }],
    })

    expect(await source.upsertNativeReview(repositoryMapping(), 24, headSha, body, new AbortController().signal, () => ok(undefined))).toEqual(ok(undefined))
    expect(written).toHaveLength(1)
    expect(written[0]).not.toContain('/scratch')
    expect(written[0]).toContain('The trace in [private path] shows two locales sharing one key.')
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail', message: expect.stringContaining('the review on harlan-zw/example#24') })])
  })
})

/** One pull request whose comments live in memory, so a source can publish and read them back. */
function commentHost(initial: Array<{ id: number, body: string }> = []) {
  const comments = initial.map(comment => ({
    ...comment,
    author_association: 'NONE',
    html_url: `https://github.com/harlan-zw/example/pull/24#issuecomment-${comment.id}`,
    issue_url: 'https://api.github.com/repos/harlan-zw/example/issues/24',
    user: { login: 'harlan-github-agent[bot]' },
  }))
  const writes: string[] = []
  const write = (id: number | undefined, body: string) => {
    writes.push(body)
    const existing = comments.find(comment => comment.id === id)
    if (existing !== undefined) {
      existing.body = body
      return Promise.resolve({ data: existing })
    }
    const created = { id: 50 + comments.length, body, author_association: 'NONE', html_url: `https://github.com/harlan-zw/example/pull/24#issuecomment-${50 + comments.length}`, issue_url: 'https://api.github.com/repos/harlan-zw/example/issues/24', user: { login: 'harlan-github-agent[bot]' } }
    comments.push(created)
    return Promise.resolve({ data: created })
  }
  const client = {
    paginate: () => Promise.resolve(comments),
    rest: { issues: {
      listComments: () => undefined,
      getComment: (input: { comment_id: number }) => Promise.resolve({ data: comments.find(comment => comment.id === input.comment_id) }),
      createComment: (input: { body: string }) => write(undefined, input.body),
      updateComment: (input: { comment_id: number, body: string }) => write(input.comment_id, input.body),
    } },
  } as unknown as Octokit
  return { client, comments, writes }
}

function agentSource(client: Octokit, store: ReturnType<typeof journal>, sourceDetails = details) {
  return createGitHubAgentSource({
    actorLogin: () => 'harlan-github-agent[bot]',
    createClient: () => client,
    ownAppId: 98114,
    publicText: createPublicTextGuard({ details: sourceDetails, store, now: () => new Date('2026-11-22T06:05:00.000Z') }),
    tokens: { getToken: async () => ok({ token: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
  })
}

const reviewHead = '1031dc93dddca88266cb32a085c7b90dcd58ec23'
function reviewBody(line: string) {
  return `<!-- harlan-agent-kit:pr-triage -->
<!-- reviewed-sha: ${reviewHead} -->
### 🤖 READY

${line}`
}

describe('review findings on #754', () => {
  it('redacts every spelling of a checkout root under the home directory', async () => {
    const store = journal()
    const sent: string[] = []
    const publisher = createGitHubIssuePublisher({
      createClient: () => ({ rest: { issues: { createComment: (input: { body: string }) => {
        sent.push(input.body)
        return Promise.resolve({ data: { id: 7 } })
      } } } }) as unknown as Octokit,
      publicText: createPublicTextGuard({ details, store, now: () => new Date('2026-11-22T06:05:00.000Z') }),
      tokens: { getToken: async () => ok({ token: 'token', expiresAt: '2099-01-01T00:00:00.000Z' }), invalidate: () => undefined },
    })

    await publisher.createComment({ repository: repositoryMapping(), issueNumber: 24, body: [
      'Absolute /home/harlan/pkg/example.fix-x/src/a.ts',
      'Tilde ~/pkg/example.fix-x/src/a.ts',
      'Variable $HOME/sites/site.fix-y/app.vue',
      'Journal ~/.local/share/harlan-github-agent/worktrees/abc',
      'Config ~/.config/opencode/opencode.json',
    ].join('\n') })

    expect(sent[0]).toBe([
      'Absolute [private path]',
      'Tilde [private path]',
      'Variable [private path]',
      'Journal [private path]',
      'Config ~/.config/opencode/opencode.json',
    ].join('\n'))
  })

  it('keeps editing a canonical comment after the deny list changes', async () => {
    const store = journal()
    const host = commentHost()
    const before = reviewBody('Dashboard: https://hogwild.tail1234.ts.net/items/24')
    const published = await agentSource(host.client, store).upsertReviewStatus(repositoryMapping(), 24, null, before, false, new AbortController().signal)
    if (published._tag === 'Err')
      throw new Error(published.error)
    const restarted = privateDetailsFor({ home: '/home/harlan', storagePath: ':memory:', checkoutRoots: [], workerHomes: [], serviceOrigins: ['https://other.tail1234.ts.net'] })

    const edited = await agentSource(host.client, store, restarted).editReviewStatus(repositoryMapping(), 24, published.value.commentId, before, reviewBody('Stopped.'), new AbortController().signal)

    expect(edited).toEqual(ok(expect.objectContaining({ _tag: 'Edited' })))
    expect(host.comments[0]?.body).toContain('Stopped.')
  })

  it('records one Incident for a body written once, and none for a refused write', async () => {
    const store = journal()
    const host = commentHost()
    const source = agentSource(host.client, store)
    const body = reviewBody('Notes: ~/notes/review-24.md')

    expect(await source.upsertReviewStatus(repositoryMapping(), 24, null, body, false, new AbortController().signal, () => ok(undefined))).toEqual(ok(expect.anything()))
    expect(await source.upsertReviewStatus(repositoryMapping(), 24, null, body, false, new AbortController().signal, () => ok(undefined))).toEqual(ok(expect.anything()))
    expect(host.writes).toHaveLength(1)
    expect(store.listIncidents()).toEqual([expect.objectContaining({ kind: 'private_detail', occurrences: 1 })])

    const refused = journal()
    const refusedHost = commentHost()
    expect(await agentSource(refusedHost.client, refused).upsertReviewStatus(repositoryMapping(), 24, null, body, false, new AbortController().signal, () => ({ _tag: 'Err', error: 'Lease expired.' }))).toEqual({ _tag: 'Err', error: 'Lease expired.' })
    expect(refusedHost.writes).toHaveLength(0)
    expect(refused.listIncidents()).toEqual([])
  })

  it('redacts a worker home with an encoded character in the native review, and keeps a longer sibling', async () => {
    const store = journal()
    const written: string[] = []
    const withEncodedRoot = privateDetailsFor({ home: '/home/harlan', storagePath: ':memory:', checkoutRoots: [], workerHomes: ['/srv/agent_home', '/home/agent'], serviceOrigins: [] })
    const client = {
      paginate: async () => [],
      rest: { pulls: {
        listReviews: () => undefined,
        createReview: async (input: { commit_id: string, body: string }) => {
          written.push(input.body)
          return { data: { id: 1, user: { login: 'harlan-github-agent[bot]' }, state: 'COMMENTED', commit_id: input.commit_id, body: input.body } }
        },
      } },
    } as unknown as Octokit
    const body = nativeReviewBody({
      repository: 'harlan-zw/example',
      headSha: reviewHead,
      outcome: 'READY',
      commentUrl: 'https://github.com/harlan-zw/example/pull/24#issuecomment-42',
      findings: [{
        _tag: 'Logged',
        impact: 40,
        summary: 'The cache key ignores the locale.',
        nextAction: 'Key the cache by locale.',
        details: { fingerprint: 'f'.repeat(64), identity: 'cache-locale', location: { path: 'src/cache.ts', line: 3 }, proof: 'The cache at /srv/agent_home/cache differs from /home/agent_x/cache.' },
      }],
    })

    await agentSource(client, store, withEncodedRoot).upsertNativeReview(repositoryMapping(), 24, reviewHead, body, new AbortController().signal, () => ok(undefined))

    expect(written[0]).toContain('The cache at [private path] differs from /home/agent&#95;x/cache.')
  })

  it.each([
    ['`~/notes/client handover/acquisition.pdf`', '`[private path]`'],
    ['Read "~/notes/client handover/acquisition.pdf" first.', 'Read "[private path]" first.'],
    ['Run `cat /home/agent/my notes/a b.txt` there.', 'Run `cat [private path]` there.'],
    ['Harlan\'s note says it\'s fine.', 'Harlan\'s note says it\'s fine.'],
  ])('redacts a quoted path with spaces through its closing delimiter: %s', (text, expected) => {
    expect(redactPrivateDetails(text, details).text).toBe(expected)
  })

  it.each([
    '[View code](https://github.com/harlan-zw/example/blob/abc123/fixtures/notes.localhost/README.md#L3)',
    'See https://github.com/harlan-zw/example/blob/abc123/fixtures/notes.localhost/README.md.',
  ])('keeps a public link whose path names a private host: %s', (text) => {
    expect(redactPrivateDetails(text, details)).toEqual({ text, hits: [] })
  })

  it('keeps redacting a private host given as a Markdown link or autolink', () => {
    expect(redactPrivateDetails('Read [notes](https://notes.localhost/x) and <https://notes.localhost/y>.', details).text)
      .toBe('Read [private link] and [private link].')
  })

  it.each(['[', '](', '<https://', '`', '"', 'a.', '![x](', '[a'])('redacts 65,536 characters of %s in linear time', (unit) => {
    const text = unit.repeat(Math.ceil(65_536 / unit.length)).slice(0, 65_536)
    const started = performance.now()
    redactPrivateDetails(text, details)
    expect(performance.now() - started).toBeLessThan(100)
  })
})
