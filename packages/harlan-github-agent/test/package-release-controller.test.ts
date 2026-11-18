import type { PackageReleaseSource } from '../src/package-release-controller.ts'
import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { RequestError } from 'octokit'
import { describe, expect, it, vi } from 'vitest'
import { reconcilePackageReleases } from '../src/package-release-controller.ts'
import { createPackageReleaseStore } from '../src/package-release-store.ts'
import { planPackageReleaseBeforeMerge, releaseNoteApproval, renderPackageRelease } from '../src/package-release.ts'
import { createWebhookApp } from '../src/webhook.ts'
import { repositoryMapping } from './fixtures.ts'

const plan = { _tag: 'Available' as const, headSha: 'f'.repeat(40), bump: 'patch' as const, packageName: 'example', version: '1.0.1', previousVersion: '1.0.0', previousTag: 'v1.0.0', sourceSha: 'a'.repeat(40), mergeSha: 'b'.repeat(40) }
const repository = { ...repositoryMapping(), release: { manifest: 'package.json', versionFiles: ['package.json'], tagPrefix: 'v', workflow: 'release.yml', checks: ['test'], credential: { _tag: 'Repository' as const } } }

function setup(mayPublish = () => true) {
  const database = new DatabaseSync(':memory:')
  const store = createPackageReleaseStore(database)
  const source: PackageReleaseSource = {
    candidates: async () => [24],
    inspect: async () => plan,
    comment: vi.fn(async () => 99),
    prepare: vi.fn<PackageReleaseSource['prepare']>(async () => ({ _tag: 'Prepared', pullRequestNumber: 25, headSha: 'c'.repeat(40), branch: 'release/24-1.0.1' })),
    merge: vi.fn(async () => null),
    publish: vi.fn(async () => null),
    releaseNoteContext: vi.fn<PackageReleaseSource['releaseNoteContext']>(async () => [{ number: 23, title: 'fix: handle input', body: 'Handles empty input.' }]),
    applyReleaseNote: vi.fn<PackageReleaseSource['applyReleaseNote']>(async ({ tag }) => `https://github.com/harlan-zw/example/releases/tag/${tag}`),
  }
  const logger = { error: vi.fn<(message: string) => void>() }
  const run = (webhookReady = true) => reconcilePackageReleases({ logger, webhookReady, repository, mayPublish, store: createPackageReleaseStore(database), source: () => source, now: () => 1000, signal: new AbortController().signal })
  const click = () => store.requestPackageRelease({ repository: repository.github, pullRequestNumber: 24, commentId: 99, before: renderPackageRelease(plan), requestId: 'select', selected: true, requestedBy: 'harlan-zw', commentAuthor: 'harlan-github-agent[bot]' })
  return { database, store, source, run, click, logger }
}

describe('release controller', () => {
  it('keeps a selected release resumable when Pause arrives during inspection', async () => {
    let allowed = true
    const task = setup(() => allowed)
    await task.run()
    task.click()
    vi.mocked(task.source.comment).mockClear()
    task.source.inspect = async () => {
      allowed = false
      return plan
    }
    expect(await task.run()).toEqual({ _tag: 'Paused' })
    expect(task.source.prepare).not.toHaveBeenCalled()
    expect(task.source.comment).not.toHaveBeenCalled()
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Queued')
    allowed = true
    task.source.inspect = async () => plan
    await task.run()
    expect(task.source.prepare).toHaveBeenCalledTimes(1)
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Prepared')
    task.database.close()
  })

  it('preserves a real failure when Pause prevents its status comment', async () => {
    let allowed = true
    const task = setup(() => allowed)
    await task.run()
    task.click()
    vi.mocked(task.source.comment).mockClear()
    task.source.inspect = async () => {
      allowed = false
      throw new Error('Connection lost')
    }
    await expect(task.run()).rejects.toThrow('Connection lost')
    expect(task.source.comment).not.toHaveBeenCalled()
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Queued')
    task.database.close()
  })

  it('preserves the original failure when Pause interrupts its status receipt', async () => {
    let allowed = true
    const task = setup(() => allowed)
    await task.run()
    task.click()
    task.source.inspect = async () => {
      throw new Error('Connection lost')
    }
    task.source.comment = vi.fn(async () => {
      allowed = false
      return 99
    })
    await expect(task.run()).rejects.toThrow('Connection lost')
    expect(task.source.comment).toHaveBeenCalledTimes(1)
    expect(task.store.listPackageReleases(repository.github)[0]?.body).toBe(renderPackageRelease(plan))
    task.database.close()
  })

  it.each([false, true])('explains a manual major release without authorizing publication, text request: %s', async (requested) => {
    const task = setup()
    task.source.inspect = async () => planPackageReleaseBeforeMerge({
      ...plan,
      title: 'fix: handle input',
      body: '',
      currentVersion: plan.previousVersion,
      commits: ['feat!: require Nuxt 4.6', 'fix: handle input'],
      files: [],
      complete: true,
    })
    if (requested)
      task.store.queuePackageReleaseCommand({ repository: repository.github, pullRequestNumber: 24, commentId: 101, requestedBy: 'harlan-zw', bump: 'auto' })
    await task.run()
    expect(task.source.comment).toHaveBeenLastCalledWith(24, expect.stringContaining('Run a manual major release.'))
    const body = vi.mocked(task.source.comment).mock.calls.at(-1)![1]
    expect(body).toContain('Automatic releases support patch and minor only.')
    expect(body).toContain('v1.0.0')
    expect(body).not.toContain('- [ ]')
    expect(task.store.listPackageReleases(repository.github)).toEqual([])
    expect(task.store.listPackageReleaseCommands(repository.github)).toEqual([])
    expect(task.source.prepare).not.toHaveBeenCalled()
    task.database.close()
  })
  it('offers a checkbox before comment delivery and keeps one comment across restarts', async () => {
    const task = setup()
    await task.run()
    expect(task.source.comment).toHaveBeenCalledWith(24, renderPackageRelease(plan), undefined)
    expect(task.store.listPackageReleases(repository.github)[0]?.body).toContain('- [ ] Release patch')
    expect(task.source.prepare).not.toHaveBeenCalled()
    await task.run()
    expect(task.source.comment).toHaveBeenCalledTimes(1)
    task.database.close()
  })
  it('finishes an authorized release across restarts without preparing twice', async () => {
    const task = setup()
    await task.run()
    expect(task.click()).toBe(true)
    await task.run()
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Prepared')
    task.source.merge = vi.fn<PackageReleaseSource['merge']>(async () => ({ _tag: 'Publishing', tag: 'v1.0.1', sha: 'd'.repeat(40) }))
    await task.run()
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Publishing')
    task.source.publish = vi.fn(async () => 'https://github.com/harlan-zw/example/releases/tag/v1.0.1')
    await task.run()
    await task.run()
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Completed')
    expect(task.source.prepare).toHaveBeenCalledTimes(1)
    expect(task.source.publish).toHaveBeenCalledTimes(1)
    expect(task.source.comment).toHaveBeenLastCalledWith(24, expect.stringContaining('Published [example@1.0.1]'), 99)
    task.database.close()
  })
  it('does not release a changed range or policy', async () => {
    const task = setup()
    await task.run()
    task.click()
    task.source.inspect = async () => ({ ...plan, sourceSha: 'e'.repeat(40) })
    await task.run()
    expect(task.source.prepare).not.toHaveBeenCalled()
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Blocked')
    task.database.close()
  })
  it.each([false, true])('explains a major release when an existing patch offer changes, selected: %s', async (selected) => {
    const task = setup()
    await task.run()
    if (selected)
      task.click()
    task.source.inspect = async () => planPackageReleaseBeforeMerge({
      ...plan,
      title: 'fix: handle input',
      body: '',
      currentVersion: plan.previousVersion,
      commits: ['feat!: require Nuxt 4.6'],
      files: [],
      complete: true,
    })
    await task.run()
    expect(task.source.comment).toHaveBeenLastCalledWith(24, expect.stringContaining('Run a manual major release.'), 99)
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Blocked')
    expect(task.source.prepare).not.toHaveBeenCalled()
    task.database.close()
  })
  it('resumes publication after a lost response with the same version', async () => {
    const task = setup()
    await task.run()
    task.click()
    task.source.merge = async () => ({ _tag: 'Publishing', tag: 'v1.0.1', sha: 'd'.repeat(40) })
    task.source.publish = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValueOnce('https://example.com/release')
    await expect(task.run()).rejects.toThrow('Connection lost')
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Publishing')
    expect(task.source.comment).toHaveBeenLastCalledWith(24, expect.stringContaining('Connection lost'), 99)
    await task.run()
    expect(task.source.prepare).toHaveBeenCalledTimes(1)
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Completed')
    task.database.close()
  })
})

describe('release note drafts', () => {
  const url = 'https://github.com/harlan-zw/example/releases/tag/v1.0.1'
  async function publish(task: ReturnType<typeof setup>) {
    await task.run()
    task.click()
    await task.run()
    task.source.merge = vi.fn<PackageReleaseSource['merge']>(async () => ({ _tag: 'Publishing', tag: 'v1.0.1', sha: 'd'.repeat(40) }))
    await task.run()
    task.source.publish = vi.fn(async () => url)
    await task.run()
  }

  it('queues one draft for the published range', async () => {
    const task = setup()
    await publish(task)
    await task.run()
    expect(task.store.getReleaseNote(repository.github, '1.0.1')).toMatchObject({
      pullRequestNumber: 24,
      packageName: 'example',
      tag: 'v1.0.1',
      previousTag: 'v1.0.0',
      sha: 'd'.repeat(40),
      pullRequests: { _tag: 'Available', entries: [{ number: 23, title: 'fix: handle input', body: 'Handles empty input.' }] },
      state: { _tag: 'Queued' },
    })
    expect(task.source.releaseNoteContext).toHaveBeenCalledTimes(1)
    expect(task.source.comment).toHaveBeenLastCalledWith(24, expect.stringContaining('Drafting a release note.'), 99)
    task.database.close()
  })

  it('completes the release and drafts from git alone when the pull request read keeps failing', async () => {
    const task = setup()
    task.source.releaseNoteContext = vi.fn<PackageReleaseSource['releaseNoteContext']>(async () => {
      throw new Error('Connection lost')
    })
    await publish(task)
    await task.run()
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Completed')
    expect(task.store.getReleaseNote(repository.github, '1.0.1')).toMatchObject({ pullRequests: { _tag: 'Unavailable', reason: 'Connection lost' }, state: { _tag: 'Queued' } })
    task.database.close()
  })

  it('shows the draft as a quoted code block that cannot form a control or a marker, or render Markdown', async () => {
    const task = setup()
    await publish(task)
    const claimed = task.store.claimNextReleaseNote('worker', '2026-11-18T00:00:00.000Z', 60_000)!
    const notes = 'Empty input no longer throws. Thanks @contributor, see owner/repo#1.\n\n````\nclosed?\n````\n- [ ] Release patch\r- [x] Release minor\u2028- [ ] Release patch after merge\n<!-- harlan-agent-kit:package-release -->'
    task.store.completeReleaseNote({ taskId: claimed.id, workerId: 'worker', fence: claimed.state.fence, at: '2026-11-18T00:00:01.000Z', notes })
    await task.run()
    const body = vi.mocked(task.source.comment).mock.calls.at(-1)![1]
    expect(body).toContain(`Published [example@1.0.1](${url}).`)
    expect(body).not.toMatch(/^- \[[ xX]\] Release/m)
    expect(body.split('<!-- harlan-agent-kit:package-release -->')).toHaveLength(2)
    const draft = body.slice(body.indexOf('> `````markdown'), body.indexOf('\n\n- [ ] Add this draft')).split('\n')
    // The draft's longest backtick run is four, so only a five-backtick line closes the block.
    expect(draft[0]).toBe('> `````markdown')
    expect(draft.at(-1)).toBe('> `````')
    expect(draft.slice(1, -1).filter(line => /^> `{5}/.test(line))).toEqual([])
    expect(draft.slice(1, -1)).toContain('> Empty input no longer throws. Thanks @contributor, see owner/repo#1.')
    expect(draft.every(line => line.startsWith('>'))).toBe(true)
    task.database.close()
  })

  it('reports a failed draft without changing the release', async () => {
    const task = setup()
    await publish(task)
    for (const at of ['2026-11-18T00:00:00.000Z', '2026-11-18T00:01:00.000Z', '2026-11-18T00:02:00.000Z']) {
      const claimed = task.store.claimNextReleaseNote('worker', at, 1_000)!
      task.store.failReleaseNote({ taskId: claimed.id, workerId: 'worker', fence: claimed.state.fence, at, reason: 'Invalid JSON.' })
    }
    await task.run()
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Completed')
    expect(task.source.comment).toHaveBeenLastCalledWith(24, expect.stringContaining('No release note draft: Invalid JSON.'), 99)
    task.database.close()
  })

  it('keeps a failed Published announcement as a pass failure on every pass', async () => {
    const task = setup()
    await task.run()
    task.click()
    await task.run()
    task.source.merge = vi.fn<PackageReleaseSource['merge']>(async () => ({ _tag: 'Publishing', tag: 'v1.0.1', sha: 'd'.repeat(40) }))
    await task.run()
    task.source.publish = vi.fn(async () => url)
    task.source.comment = vi.fn(async () => {
      throw new Error('The release comment no longer belongs to this Task.')
    })
    await expect(task.run()).rejects.toThrow('no longer belongs to this Task')
    expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Completed')
    await expect(task.run()).rejects.toThrow('no longer belongs to this Task')
    expect(task.logger.error).not.toHaveBeenCalled()
    task.database.close()
  })

  it('keeps offering releases when a published release comment cannot change', async () => {
    const task = setup()
    await publish(task)
    const claimed = task.store.claimNextReleaseNote('worker', '2026-11-18T00:00:00.000Z', 60_000)!
    task.store.completeReleaseNote({ taskId: claimed.id, workerId: 'worker', fence: claimed.state.fence, at: '2026-11-18T00:00:01.000Z', notes: 'Empty input no longer throws.' })
    task.source.comment = vi.fn(async (number: number) => {
      if (number === 24)
        throw new Error('The release comment no longer belongs to this Task.')
      return 100
    })
    task.source.candidates = async () => [30]
    task.source.inspect = async number => ({ ...plan, headSha: number === 30 ? 'e'.repeat(40) : plan.headSha })
    await task.run()
    await task.run()
    expect(task.source.comment).toHaveBeenCalledWith(30, expect.stringContaining('- [ ] Release patch'), undefined)
    expect(task.store.listPackageReleases(repository.github).map(record => record.pullRequestNumber)).toContain(30)
    expect(task.logger.error).toHaveBeenCalledWith(expect.stringContaining('no longer belongs to this Task'))
    task.database.close()
  })

  async function drafted(task: ReturnType<typeof setup>): Promise<string> {
    await publish(task)
    const claimed = task.store.claimNextReleaseNote('worker', '2026-11-18T00:00:00.000Z', 60_000)!
    task.store.completeReleaseNote({ taskId: claimed.id, workerId: 'worker', fence: claimed.state.fence, at: '2026-11-18T00:00:01.000Z', notes: 'Empty input no longer throws.' })
    await task.run()
    return vi.mocked(task.source.comment).mock.calls.at(-1)![1]
  }
  const approval = (before: string, requestId = 'apply') => ({ repository: repository.github, pullRequestNumber: 24, commentId: 99, before, requestedBy: 'harlan-zw', commentAuthor: 'harlan-github-agent[bot]', requestId })

  it('offers one apply control below a drafted note', async () => {
    const task = setup()
    const body = await drafted(task)
    expect(body.match(/^- \[ \] Add this draft to the GitHub release$/gm)).toHaveLength(1)
    expect(releaseNoteApproval('issue_comment', { action: 'edited', repository: { full_name: repository.github }, issue: { number: 24, pull_request: {} }, sender: { login: 'harlan-zw' }, comment: { id: 99, user: { login: 'harlan-github-agent[bot]' }, body: body.replace('- [ ] Add this draft', '- [x] Add this draft') }, changes: { body: { from: body } } })).not.toBeNull()
    task.database.close()
  })

  it('adds the approved draft to the GitHub release once', async () => {
    const task = setup()
    const body = await drafted(task)
    expect(task.store.approveReleaseNote(approval(body))).toBe(true)
    expect(task.store.approveReleaseNote(approval(body))).toBe(false)
    await task.run()
    expect(task.source.applyReleaseNote).toHaveBeenCalledWith({ tag: 'v1.0.1', text: 'Empty input no longer throws.' })
    expect(task.store.getReleaseNote(repository.github, '1.0.1')?.state).toEqual({ _tag: 'Applied', text: 'Empty input no longer throws.', url })
    expect(task.source.comment).toHaveBeenLastCalledWith(24, expect.stringContaining(`Added this draft to the [GitHub release](${url}).`), 99)
    expect(vi.mocked(task.source.comment).mock.calls.at(-1)![1]).not.toMatch(/^- \[[ xX]\] Add this draft/m)
    await task.run()
    expect(task.source.applyReleaseNote).toHaveBeenCalledTimes(1)
    task.database.close()
  })

  it('refuses an approval of a comment that no longer shows this draft', async () => {
    const task = setup()
    const body = await drafted(task)
    expect(task.store.approveReleaseNote(approval(body.replace('Empty input', 'Other input'), 'stale'))).toBe(false)
    await task.run()
    expect(task.source.applyReleaseNote).not.toHaveBeenCalled()
    expect(task.store.getReleaseNote(repository.github, '1.0.1')?.state._tag).toBe('Drafted')
    task.database.close()
  })

  it.each([[404, 'Not Found'], [403, 'Resource not accessible by integration'], [422, 'Validation Failed']])('stops applying after GitHub refuses the edit: %s', async (status, message) => {
    const task = setup()
    const body = await drafted(task)
    task.store.approveReleaseNote(approval(body))
    task.source.applyReleaseNote = vi.fn<PackageReleaseSource['applyReleaseNote']>(async () => {
      throw Object.assign(new Error(message), { status })
    })
    await task.run()
    await task.run()
    expect(task.source.applyReleaseNote).toHaveBeenCalledTimes(1)
    expect(task.store.getReleaseNote(repository.github, '1.0.1')?.state).toEqual({ _tag: 'ApplyFailed', text: 'Empty input no longer throws.', reason: message })
    expect(task.source.comment).toHaveBeenLastCalledWith(24, expect.stringContaining(`Could not add this draft to the GitHub release: ${message}`), 99)
    task.database.close()
  })

  const requestFailure = (status: number, message: string, headers: Record<string, string>) => new RequestError(message, status, {
    request: { method: 'PATCH', url: 'https://api.github.com/repos/harlan-zw/example/releases/7', headers: {} },
    response: { status, url: 'https://api.github.com/repos/harlan-zw/example/releases/7', headers, data: { message } },
  })
  it.each([
    ['a 429', requestFailure(429, 'Too Many Requests', {})],
    ['a primary limit sent as 403', requestFailure(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794952322' })],
    ['a secondary limit sent as 403', requestFailure(403, 'You have exceeded a secondary rate limit', { 'retry-after': '60' })],
    ['an expired credential', requestFailure(401, 'Bad credentials', {})],
  ])('keeps retrying an apply after %s', async (_name, failure) => {
    const task = setup()
    const body = await drafted(task)
    task.store.approveReleaseNote(approval(body))
    task.source.applyReleaseNote = vi.fn<PackageReleaseSource['applyReleaseNote']>(async () => {
      throw failure
    })
    await task.run()
    await task.run()
    expect(task.source.applyReleaseNote).toHaveBeenCalledTimes(2)
    expect(task.store.getReleaseNote(repository.github, '1.0.1')?.state._tag).toBe('Approved')
    task.database.close()
  })

  it('retries a failed apply without stopping release offers', async () => {
    const task = setup()
    const body = await drafted(task)
    task.store.approveReleaseNote(approval(body))
    task.source.applyReleaseNote = vi.fn<PackageReleaseSource['applyReleaseNote']>().mockRejectedValueOnce(new Error('Resource not accessible by integration')).mockResolvedValueOnce(url)
    task.source.candidates = async () => [30]
    task.source.inspect = async number => ({ ...plan, headSha: number === 30 ? 'e'.repeat(40) : plan.headSha })
    await task.run()
    expect(task.store.getReleaseNote(repository.github, '1.0.1')?.state._tag).toBe('Approved')
    expect(task.logger.error).toHaveBeenCalledWith(expect.stringContaining('Resource not accessible by integration'))
    expect(task.store.listPackageReleases(repository.github).map(record => record.pullRequestNumber)).toContain(30)
    await task.run()
    expect(task.store.getReleaseNote(repository.github, '1.0.1')?.state._tag).toBe('Applied')
    task.database.close()
  })

  it.each(['valid', 'other-sender', 'foreign-comment'])('authenticates an apply click: %s', async (mode) => {
    const task = setup()
    const before = await drafted(task)
    const body = JSON.stringify({ action: 'edited', repository: { full_name: repository.github }, issue: { number: 24, pull_request: {} }, sender: { login: mode === 'other-sender' ? 'contributor' : 'harlan-zw' }, comment: { id: 99, user: { login: mode === 'foreign-comment' ? 'contributor' : 'harlan-github-agent[bot]' }, body: before.replace('- [ ] Add this draft', '- [x] Add this draft') }, changes: { body: { from: before } } })
    const app = createWebhookApp({ secret: 'secret', allowedOwners: ['harlan-zw'], onHint: () => {}, logger: { info: () => {} }, packageRelease: { allowedAuthor: 'harlan-zw', actorLogin: () => 'harlan-github-agent[bot]', apply: () => {}, approveNote: (request) => {
      task.store.approveReleaseNote(request)
    } } })
    const response = await app.fetch(new Request('http://localhost/webhook', { method: 'POST', body, headers: {
      'x-github-event': 'issue_comment',
      'x-github-delivery': 'apply-click',
      'x-hub-signature-256': `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`,
    } }))
    expect(response.status).toBe(204)
    expect(task.store.getReleaseNote(repository.github, '1.0.1')?.state._tag).toBe(mode === 'valid' ? 'Approved' : 'Drafted')
    task.database.close()
  })
})

it.each(['valid', 'other-sender', 'foreign-comment', 'bad-signature'])('authenticates a merged pull request release click: %s', async (mode) => {
  const task = setup()
  await task.run()
  const before = renderPackageRelease(plan)
  const body = JSON.stringify({ action: 'edited', repository: { full_name: repository.github }, issue: { number: 24, pull_request: {} }, sender: { login: mode === 'other-sender' ? 'contributor' : 'harlan-zw' }, comment: { id: 99, user: { login: mode === 'foreign-comment' ? 'contributor' : 'harlan-github-agent[bot]' }, body: before.replace('[ ]', '[x]') }, changes: { body: { from: before } } })
  const app = createWebhookApp({ secret: 'secret', allowedOwners: ['harlan-zw'], onHint: () => {}, logger: { info: () => {} }, packageRelease: { allowedAuthor: 'harlan-zw', actorLogin: () => 'harlan-github-agent[bot]', apply: (request) => {
    task.store.requestPackageRelease(request)
  } } })
  const response = await app.fetch(new Request('http://localhost/webhook', { method: 'POST', body, headers: {
    'x-github-event': 'issue_comment',
    'x-github-delivery': 'release-click',
    'x-hub-signature-256': `sha256=${createHmac('sha256', mode === 'bad-signature' ? 'wrong' : 'secret').update(body).digest('hex')}`,
  } }))
  expect(response.status).toBe(mode === 'bad-signature' ? 401 : 204)
  expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe(mode === 'valid' ? 'Queued' : 'Available')
  task.database.close()
})

it('keeps a text command that arrives before the offer exists', async () => {
  const task = setup()
  task.store.queuePackageReleaseCommand({ repository: repository.github, pullRequestNumber: 24, commentId: 101, requestedBy: 'harlan-zw', bump: 'auto' })
  await task.run()
  expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Queued')
  await task.run()
  expect(task.source.prepare).toHaveBeenCalledTimes(1)
  task.store.queuePackageReleaseCommand({ repository: repository.github, pullRequestNumber: 24, commentId: 101, requestedBy: 'harlan-zw', bump: 'auto' })
  expect(task.store.listPackageReleaseCommands(repository.github)).toEqual([])
  task.database.close()
})

it.each(['harlan-zw', 'contributor'])('accepts pre-merge signed text requests only from Harlan: %s', async (author) => {
  const task = setup()
  task.source.inspect = async () => ({ ...plan, _tag: 'BeforeMerge' })
  await task.run()
  const app = createWebhookApp({
    secret: 'secret',
    allowedOwners: ['harlan-zw'],
    onHint: () => {},
    logger: { info: () => {} },
    packageRelease: {
      allowedAuthor: 'harlan-zw',
      actorLogin: () => 'harlan-github-agent[bot]',
      apply: () => {},
      command: command => task.store.queuePackageReleaseCommand(command),
    },
  })
  const body = JSON.stringify({ action: 'created', repository: { full_name: repository.github }, issue: { number: 24, pull_request: {} }, sender: { login: author }, comment: { id: 101, user: { login: author }, body: 'do release patch' } })
  await app.fetch(new Request('http://localhost/webhook', {
    method: 'POST',
    body,
    headers: {
      'x-github-event': 'issue_comment',
      'x-github-delivery': `text-${author}`,
      'x-hub-signature-256': `sha256=${createHmac('sha256', 'secret').update(body).digest('hex')}`,
    },
  }))
  await task.run()
  await task.run()
  expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe(author === 'harlan-zw' ? 'AwaitingMerge' : 'Available')
  expect(task.source.prepare).not.toHaveBeenCalled()
  if (author === 'harlan-zw') {
    expect(task.source.comment).toHaveBeenLastCalledWith(24, expect.stringContaining('- [x] Release patch after merge'), 99)
    task.source.inspect = async () => plan
    await task.run()
    expect(task.source.prepare).toHaveBeenCalledTimes(1)
  }
  task.database.close()
})

it.each([
  ['User', 1],
  ['Repository', 0],
] as const)('offers a maintained repository release only with the %s credential opt in', async (credential, offers) => {
  const task = setup()
  const maintained = { ...repository, github: 'nuxt-modules/example', ownership: 'maintained' as const, release: { ...repository.release, credential: { _tag: credential } } }
  await reconcilePackageReleases({ logger: { error: () => undefined }, webhookReady: true, repository: maintained, mayPublish: () => true, store: task.store, source: () => task.source, now: () => 1000, signal: new AbortController().signal })
  expect(task.source.comment).toHaveBeenCalledTimes(offers)
  task.database.close()
})

it('does not offer or publish releases while the webhook listener is unavailable', async () => {
  const task = setup()
  await task.run(false)
  expect(task.source.comment).not.toHaveBeenCalled()
  expect(task.store.listPackageReleases(repository.github)).toEqual([])
  task.database.close()
})

it('saves a selection before merge and resumes after restart', async () => {
  const task = setup()
  const preview = { _tag: 'BeforeMerge' as const, bump: plan.bump, packageName: plan.packageName, version: plan.version, previousVersion: plan.previousVersion, previousTag: plan.previousTag, headSha: 'f'.repeat(40) }
  task.source.inspect = async () => preview
  await task.run()
  const offer = task.store.listPackageReleases(repository.github)[0]!
  expect(offer.body).toContain('- [ ] Release patch after merge')
  expect(task.store.requestPackageRelease({ repository: repository.github, pullRequestNumber: 24, commentId: 99, before: offer.body, requestId: 'select', selected: true, requestedBy: 'harlan-zw', commentAuthor: 'bot' })).toBe(true)
  await task.run()
  await task.run()
  expect(task.source.prepare).not.toHaveBeenCalled()
  expect(task.source.comment).toHaveBeenLastCalledWith(24, expect.stringContaining('- [x] Release patch after merge'), 99)
  expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('AwaitingMerge')
  task.source.inspect = async () => ({ ...plan, headSha: preview.headSha })
  await task.run()
  expect(task.source.prepare).toHaveBeenCalledTimes(1)
  expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Prepared')
  task.database.close()
})

it.each(['push', 'bump', 'closed'])('revokes a pre-merge selection after %s', async (change) => {
  const task = setup()
  const preview = { _tag: 'BeforeMerge' as const, bump: plan.bump, packageName: plan.packageName, version: plan.version, previousVersion: plan.previousVersion, previousTag: plan.previousTag, headSha: 'f'.repeat(40) }
  task.source.inspect = async () => preview
  await task.run()
  const offer = task.store.listPackageReleases(repository.github)[0]!
  task.store.requestPackageRelease({ repository: repository.github, pullRequestNumber: 24, commentId: 99, before: offer.body, requestId: 'select', selected: true, requestedBy: 'harlan-zw', commentAuthor: 'bot' })
  task.source.inspect = async () => change === 'closed' ? { _tag: 'Unavailable', reason: 'Closed without merge.' } : change === 'push' ? { ...preview, headSha: 'e'.repeat(40) } : { ...plan, headSha: preview.headSha, bump: 'minor', version: '1.1.0' }
  await task.run()
  expect(task.source.prepare).not.toHaveBeenCalled()
  expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).not.toBe('AwaitingMerge')
  expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).not.toBe('Queued')
  task.database.close()
})

it('lets Harlan clear a selection before merge, including before the next reconciliation', async () => {
  const task = setup()
  task.source.inspect = async () => ({ _tag: 'BeforeMerge', bump: plan.bump, packageName: plan.packageName, version: plan.version, previousVersion: plan.previousVersion, previousTag: plan.previousTag, headSha: 'f'.repeat(40) })
  await task.run()
  const offer = task.store.listPackageReleases(repository.github)[0]!
  const request = { repository: repository.github, pullRequestNumber: 24, commentId: 99, before: offer.body, requestId: 'select', selected: true, requestedBy: 'harlan-zw', commentAuthor: 'bot' }
  expect(task.store.requestPackageRelease(request)).toBe(true)
  expect(task.store.requestPackageRelease({ ...request, requestId: 'cancel', selected: false, before: offer.body.replace('[ ]', '[x]') })).toBe(true)
  expect(createPackageReleaseStore(task.database).requestPackageRelease(request)).toBe(false)
  await task.run()
  expect(task.store.listPackageReleases(repository.github)[0]?.state._tag).toBe('Available')
  expect(task.source.prepare).not.toHaveBeenCalled()
  task.database.close()
})
