import type { StoredReviewForHead } from '../src/types.ts'
import { Buffer } from 'node:buffer'
import { DatabaseSync } from 'node:sqlite'
import { Octokit } from 'octokit'
import { expect, it, vi } from 'vitest'
import { reconcilePackageReleases } from '../src/package-release-controller.ts'
import { createPackageReleaseSource } from '../src/package-release-github.ts'
import { createPackageReleaseStore } from '../src/package-release-store.ts'
import { repositoryMapping } from './fixtures.ts'

const sha = 'a'.repeat(40)
const mergeSha = 'b'.repeat(40)
const mapping = { ...repositoryMapping(), writablePullRequestAuthors: ['harlan-github-agent[bot]'], release: { manifest: 'package.json', versionFiles: ['package.json'], tagPrefix: 'v', workflow: 'release.yml', checks: ['test'], credential: { _tag: 'Repository' as const } } }
const plan = { _tag: 'Available' as const, headSha: 'f'.repeat(40), bump: 'patch' as const, packageName: 'example', version: '1.0.1', previousVersion: '1.0.0', previousTag: 'v1.0.0', sourceSha: sha, mergeSha }
const record = { repository: mapping.github, pullRequestNumber: 24, commentId: 99, body: '', policy: '', plan, state: { _tag: 'Queued' as const, requestedBy: 'harlan-zw' } }

function fixture() {
  const writes: Array<{ path: string, body: Record<string, unknown> }> = []
  const refs = new Map<string, string>([['heads/main', sha], ['tags/v1.0.0', mergeSha]])
  let ready = false
  let merged = false
  let changedTree = false
  let published = false
  let workflowSuccess = false
  let rangeSha = mergeSha
  let commentBody = ''
  let sourceOpen = false
  let sourceTitle = 'fix: handle input'
  let mainChecks = true
  let checkEvent = 'push'
  let checkBranch = 'main'
  let sourceHead = 'f'.repeat(40)
  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init)
    const url = new URL(req.url)
    const path = decodeURIComponent(url.pathname).replace(`/repos/${mapping.github}`, '')
    if (req.method !== 'GET')
      writes.push({ path, body: await req.json() as Record<string, unknown> })
    let data: unknown
    if (path.startsWith('/git/ref/')) {
      const value = refs.get(path.slice('/git/ref/'.length))
      if (value === undefined)
        return Response.json({ message: 'Not Found' }, { status: 404 })
      data = { object: { sha: value } }
    }
    else if (path === '/pulls/25' && req.method === 'GET') {
      data = { number: 25, merged, merge_commit_sha: merged ? 'd'.repeat(40) : null, state: merged ? 'closed' : 'open', base: { ref: 'main' }, head: { sha: 'c'.repeat(40) }, mergeable_state: 'clean' }
    }
    else if (path === '/pulls/25/merge') {
      merged = true
      data = { merged: true, sha: 'd'.repeat(40) }
    }
    else if (path === `/git/commits/${'c'.repeat(40)}`) {
      data = { tree: { sha: 'release-tree' }, parents: [{ sha }] }
    }
    else if (path === `/git/commits/${'d'.repeat(40)}`) {
      data = { tree: { sha: changedTree ? 'unexpected-tree' : 'release-tree' } }
    }
    else if (path === '/pulls/24') {
      data = { merged: !sourceOpen, draft: false, state: sourceOpen ? 'open' : 'closed', commits: 1, changed_files: 1, merge_commit_sha: sourceOpen ? null : mergeSha, base: { ref: 'main' }, title: sourceTitle, body: '', head: { sha: sourceHead } }
    }
    else if (path === '/pulls/24/commits') {
      data = [{ sha: sourceHead, commit: { message: sourceTitle } }]
    }
    else if (path === '/pulls/24/files') {
      data = [{ filename: 'src/index.ts', patch: '+return []' }]
    }
    else if (path === '/actions/runs') {
      data = { total_count: 1, workflow_runs: [{ id: 10, check_suite_id: 10, head_sha: url.searchParams.get('head_sha'), event: checkEvent, head_branch: checkBranch, status: mainChecks ? 'completed' : 'in_progress', conclusion: mainChecks ? 'success' : null }] }
    }
    else if (path.startsWith('/contents/')) {
      data = { type: 'file', content: Buffer.from(path.endsWith('.yml') ? 'on:\n  push:\n    tags: [\'v*\']\n' : JSON.stringify({ name: 'example', version: url.searchParams.get('ref') === 'c'.repeat(40) ? '1.0.1' : '1.0.0' })).toString('base64') }
    }
    else if (path.startsWith('/compare/')) {
      data = { status: 'ahead', total_commits: 1, commits: [{ sha: rangeSha, commit: { message: 'fix: handle input' } }], files: [{ filename: 'src/index.ts', patch: '+return []' }] }
    }
    else if (path.endsWith('/check-runs')) {
      const main = { id: 10, name: 'test', check_suite: { id: 10 }, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' }
      const tag = { ...main, id: 20, check_suite: { id: 20 } }
      const checkRuns = refs.has('tags/v1.0.1') ? url.searchParams.get('filter') === 'all' ? [tag, main] : [tag] : [main]
      data = { total_count: checkRuns.length, check_runs: checkRuns }
    }
    else if (path === `/git/commits/${sha}`) {
      data = { tree: { sha: 'base-tree' } }
    }
    else if (path === '/git/trees') {
      data = { sha: 'release-tree' }
    }
    else if (path === '/git/commits' && req.method === 'POST') {
      data = { sha: 'c'.repeat(40) }
    }
    else if (path === '/git/refs') {
      const body = writes.at(-1)!.body
      refs.set(String(body.ref).slice(5), String(body.sha))
      data = {}
    }
    else if (path === '/pulls' && req.method === 'GET') {
      data = []
    }
    else if (path === '/pulls' && req.method === 'POST') {
      data = { number: 25 }
    }
    else if (path.includes('/actions/workflows/')) {
      data = { workflow_runs: workflowSuccess ? [{ id: 1, head_branch: 'v1.0.1', status: 'completed', conclusion: 'success', html_url: 'https://github.com/run/1' }] : [] }
    }
    else if (path === '/releases/tags/v1.0.1') {
      data = { draft: false, prerelease: false, html_url: 'https://github.com/release/v1.0.1' }
    }
    else if (path === '/issues/comments/100') {
      if (req.method === 'PATCH')
        commentBody = String(writes.at(-1)!.body.body)
      data = { id: 100, body: commentBody, user: { login: 'harlan-github-agent[bot]' }, issue_url: `https://api.github.com/repos/${mapping.github}/issues/24` }
    }
    else if (path === '/issues/comments/99') {
      return Response.json({ message: 'Not Found' }, { status: 404 })
    }
    else if (path === '/issues/24/comments' && req.method === 'POST') {
      commentBody = String(writes.at(-1)!.body.body)
      data = { id: 100 }
    }
    else if (path === '/issues/24/comments') {
      data = []
    }
    else {
      throw new Error(`Unexpected ${req.method} ${path}`)
    }
    const response = Response.json(data)
    Object.defineProperty(response, 'url', { value: req.url })
    return response
  }
  const source = createPackageReleaseSource({ repository: mapping, actors: { repository: { login: 'harlan-github-agent[bot]', tokens: { getToken: async () => ({ _tag: 'Ok', value: { token: 'test', expiresAt: '2099-01-01' } }), invalidate: () => {} } }, user: { login: 'harlan-zw', tokens: { getToken: async () => ({ _tag: 'Err', error: { repository: mapping.github, message: 'The user credential is not used here.' } }), invalidate: () => {} } } }, template: async () => '### 📚 Description', assertLease: () => {}, review: (): StoredReviewForHead => ready ? { _tag: 'Current', run: { outcome: { _tag: 'Ready', confidence: 95 }, baseRef: 'main', gates: { review: { _tag: 'Passed' }, merge: { _tag: 'Passed' }, ci: { _tag: 'Passed' } } } } as StoredReviewForHead : { _tag: 'None' }, signal: new AbortController().signal, now: () => new Date(), createClient: token => new Octokit({ auth: token, request: { fetch: fetcher }, retry: { enabled: false }, throttle: { enabled: false } }), fetch: async () => Response.json({ 'versions': { '1.0.0': { version: '1.0.0' }, ...(published ? { '1.0.1': { version: '1.0.1' } } : {}) }, 'dist-tags': { latest: published ? '1.0.1' : '1.0.0' } }) })
  return { source, writes, refs, openSource: (title = 'fix: handle input') => {
    sourceOpen = true
    sourceTitle = title
  }, mergeSource: () => {
    sourceOpen = false
  }, changeSourceHead: () => {
    sourceHead = 'e'.repeat(40)
  }, setMainChecks: (passed: boolean, event = 'push', branch = 'main') => {
    mainChecks = passed
    checkEvent = event
    checkBranch = branch
  }, allowReview: () => {
    ready = true
  }, changeMergeTree: () => {
    changedTree = true
  }, publish: () => {
    published = true
  }, workflowDone: () => {
    workflowSuccess = true
  }, removeSource: () => {
    rangeSha = 'f'.repeat(40)
  } }
}

it('reads the release range and prepares a version pull request without pushing main', async () => {
  const task = fixture()
  expect(await task.source.inspect(24)).toMatchObject({ _tag: 'Available', version: '1.0.1', bump: 'patch' })
  expect(await task.source.prepare(record)).toMatchObject({ _tag: 'Prepared', pullRequestNumber: 25, headSha: 'c'.repeat(40) })
  expect(task.refs.get('heads/main')).toBe(sha)
  const tree = task.writes.find(write => write.path === '/git/trees')!.body.tree as Array<{ content: string }>
  expect(JSON.parse(tree[0]!.content)).toMatchObject({ name: 'example', version: '1.0.1' })
  expect(task.refs.get('heads/release/24-1.0.1')).toBe('c'.repeat(40))
})

it('does not offer a release for a merge already outside the unreleased range', async () => {
  const task = fixture()
  task.removeSource()
  expect((await task.source.inspect(24))._tag).toBe('Unavailable')
  expect(task.writes).toEqual([])
})

it('waits for both the tag workflow and npm, and never creates the tag twice', async () => {
  const task = fixture()
  const input = { ...record, state: { _tag: 'Publishing' as const, tag: 'v1.0.1', sha: 'c'.repeat(40) } }
  expect(await task.source.publish(input)).toBeNull()
  task.workflowDone()
  expect(await task.source.publish(input)).toBeNull()
  task.publish()
  expect(await task.source.publish(input)).toBe('https://github.com/release/v1.0.1')
  expect(task.writes.filter(write => write.path === '/git/refs')).toHaveLength(1)
})

it('refuses a tag collision without writing or republishing', async () => {
  const task = fixture()
  task.refs.set('tags/v1.0.1', 'f'.repeat(40))
  expect(await task.source.publish({ ...record, state: { _tag: 'Publishing', tag: 'v1.0.1', sha } })).toEqual({ _tag: 'Blocked', reason: 'The release tag already points to a different commit.' })
  expect(task.writes).toEqual([])
})

it('waits for Review, then verifies the actual merge before allowing a tag', async () => {
  const task = fixture()
  const input = { ...record, state: { _tag: 'Prepared' as const, pullRequestNumber: 25, headSha: 'c'.repeat(40), branch: 'release/24-1.0.1' } }
  expect(await task.source.merge(input)).toBeNull()
  expect(task.writes).toEqual([])
  task.allowReview()
  expect(await task.source.merge(input)).toBeNull()
  expect(await task.source.merge(input)).toEqual({ _tag: 'Publishing', tag: 'v1.0.1', sha: 'd'.repeat(40) })
  expect(task.writes.filter(write => write.path === '/pulls/25/merge')).toHaveLength(1)
  task.changeMergeTree()
  expect(await task.source.merge(input)).toEqual({ _tag: 'Blocked', reason: 'The release merge includes unverified changes.' })
})

it('does not merge when the default branch advances after preparation', async () => {
  const task = fixture()
  task.allowReview()
  task.refs.set('heads/main', 'e'.repeat(40))
  expect(await task.source.merge({ ...record, state: { _tag: 'Prepared', pullRequestNumber: 25, headSha: 'c'.repeat(40), branch: 'release/24-1.0.1' } }))
    .toMatchObject({ _tag: 'Blocked' })
  expect(task.writes).toEqual([])
})

it('recreates a deleted release comment so one pass still advances the record', async () => {
  const task = fixture()
  const store = createPackageReleaseStore(new DatabaseSync(':memory:'))
  store.saveReleaseOffer({ repository: mapping.github, pullRequestNumber: 24, plan, commentId: 99, body: '', policy: JSON.stringify(mapping) })
  expect(store.requestPackageRelease({ repository: mapping.github, pullRequestNumber: 24, commentId: 99, before: '', selected: true, requestId: 'select', requestedBy: 'harlan-zw', commentAuthor: 'harlan-github-agent[bot]' })).toBe(true)
  await reconcilePackageReleases({ webhookReady: true, repository: mapping, store, source: () => task.source, now: () => 1000, signal: new AbortController().signal })
  expect(task.writes.some(write => write.path === '/issues/24/comments')).toBe(true)
  expect(store.listPackageReleases(mapping.github)[0]?.state).toEqual({ _tag: 'Prepared', pullRequestNumber: 25, headSha: 'c'.repeat(40), branch: 'release/24-1.0.1' })
})

it.each(['fix: handle input', 'feat: add input'])('offers the matching selection on an open pull request: %s', async (title) => {
  const task = fixture()
  task.openSource(title)
  expect(await task.source.inspect(24)).toMatchObject({ _tag: 'BeforeMerge', bump: title.startsWith('feat') ? 'minor' : 'patch', headSha: 'f'.repeat(40) })
  expect(task.writes).toEqual([])
})

it.each(['pending', 'pull_request', 'other-branch'])('waits for default branch push checks, ignoring %s evidence', async (mode) => {
  const task = fixture()
  task.setMainChecks(mode !== 'pending', mode === 'pull_request' ? 'pull_request' : 'push', mode === 'other-branch' ? 'feature' : 'main')
  expect(await task.source.prepare(record)).toBeNull()
  expect(task.writes).toEqual([])
  task.setMainChecks(true)
  expect(await task.source.prepare(record)).toMatchObject({ _tag: 'Prepared' })
})

it('releases a preselected pull request only after merge and passing default branch checks', async () => {
  const task = fixture()
  task.openSource()
  const db = new DatabaseSync(':memory:')
  const store = createPackageReleaseStore(db)
  const run = () => reconcilePackageReleases({ webhookReady: true, repository: mapping, store: createPackageReleaseStore(db), source: () => task.source, now: () => 1000, signal: new AbortController().signal })
  store.queuePackageReleaseCommand({ repository: mapping.github, pullRequestNumber: 24, commentId: 101, requestedBy: 'harlan-zw', bump: 'auto' })
  await run()
  await run()
  expect(store.listPackageReleases(mapping.github)[0]?.state._tag).toBe('AwaitingMerge')
  expect(task.refs.has('heads/release/24-1.0.1')).toBe(false)
  task.mergeSource()
  task.setMainChecks(false)
  await run()
  expect(store.listPackageReleases(mapping.github)[0]?.state._tag).toBe('Queued')
  expect(task.refs.has('heads/release/24-1.0.1')).toBe(false)
  task.setMainChecks(true)
  await run()
  expect(store.listPackageReleases(mapping.github)[0]?.state._tag).toBe('Prepared')
  expect(task.refs.has('heads/release/24-1.0.1')).toBe(true)
  db.close()
})

it('writes a maintained repository release with the user credential even when the App can reach it', async () => {
  const requests: Array<{ method: string, path: string, authorization: string | null }> = []
  const appTokens = { getToken: vi.fn(async () => ({ _tag: 'Ok' as const, value: { token: 'app-token', expiresAt: '2099-01-01' } })), invalidate: () => {} }
  const repository = { ...repositoryMapping({ github: 'nuxt-modules/example', ownership: 'maintained', authentication: 'app' }), release: { ...mapping.release, credential: { _tag: 'User' as const } } }
  const source = createPackageReleaseSource({
    repository,
    actors: {
      repository: { login: 'harlan-github-agent[bot]', tokens: appTokens },
      user: { login: 'harlan-zw', tokens: { getToken: async () => ({ _tag: 'Ok', value: { token: 'user-token', expiresAt: '2099-01-01' } }), invalidate: () => {} } },
    },
    template: async () => '',
    assertLease: () => {},
    review: () => ({ _tag: 'None' }),
    signal: new AbortController().signal,
    now: () => new Date(),
    createClient: token => new Octokit({ auth: token, request: { fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init)
      requests.push({ method: req.method, path: new URL(req.url).pathname, authorization: req.headers.get('authorization') })
      const response = Response.json(req.method === 'GET' ? [] : { id: 7 })
      Object.defineProperty(response, 'url', { value: req.url })
      return response
    } }, retry: { enabled: false }, throttle: { enabled: false } }),
  })
  expect(await source.comment(24, 'status')).toBe(7)
  expect(requests).toEqual([
    { method: 'GET', path: '/repos/nuxt-modules/example/issues/24/comments', authorization: 'token user-token' },
    { method: 'POST', path: '/repos/nuxt-modules/example/issues/24/comments', authorization: 'token user-token' },
  ])
  expect(appTokens.getToken).not.toHaveBeenCalled()
})
