import type { OperatorConfig } from '../src/config.ts'
import type { GitHubClient, PullRequestSnapshot } from '../src/github.ts'
import type { OctorunService } from '../src/service.ts'
import type { AgentProvider } from '../src/types.ts'
import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { changeSummaryPreset } from '../src/review.ts'
import { createOctorun, parseRepositoryWorkflows } from '../src/service.ts'
import { ok } from '../src/types.ts'

const head = 'a'.repeat(40)
const base = 'b'.repeat(40)
const secret = 'a-long-webhook-secret-for-tests'
const now = new Date('2026-10-21T00:00:00Z')
const repo = { id: 10, fullName: 'acme/project', installationId: 20 }
const actor = { id: 30, login: 'alice', kind: 'User' as const }
const bot = { id: 90, login: 'octorun[bot]', kind: 'Bot' as const }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).reverse().map(close => close()))
})

async function setup(options: { failProvider?: boolean, sourceText?: string } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'octorun-service-'))
  const config: OperatorConfig = { version: 1, stateDir, host: '127.0.0.1', port: 0, handle: 'octorun', github: { appId: '7', privateKeyEnv: 'APP_KEY', webhookSecretEnv: 'WEBHOOK_SECRET', apiUrl: 'https://api.github.com' }, provider: { baseUrl: 'https://provider.example/v1', model: 'test-model', apiKeyEnv: 'API_KEY', timeoutMs: 1000, maxResponseBytes: 1024, maxInputCharacters: 100000 }, repositories: [{ ...repo, policy: { enabled: true, capabilities: ['repository:read', 'agent:invoke', 'github:comment', 'github:review', 'github:check'], maxConcurrency: 2 }, workflowSource: options.sourceText ? { _tag: 'Repository', path: '.github/octorun.yml' } : { _tag: 'Presets', presets: ['adversarial-review'] } }], pollIntervalMs: 0, limits: { bodyBytes: 1024 * 1024, requestsPerMinute: 100, concurrency: 2 } }
  let currentHead = head
  let reads = 0
  let providerCalls = 0
  let nextId = 100
  let permission: 'read' | 'write' = 'write'
  let permissionChecks = 0
  const comments: Record<string, unknown>[] = []
  const reviews: Record<string, unknown>[] = []
  const checkRuns: Record<string, unknown>[] = []
  const inputComments: Record<string, unknown>[] = []
  const snapshot = (): PullRequestSnapshot => ({ repository: repo, number: 1, headSha: currentHead, baseSha: base, title: 'Change input parser', body: '', author: actor, draft: false, state: 'open', changedFiles: 1, updatedAt: now.toISOString(), labels: [], headRepository: 'outside/fork' })
  const client: GitHubClient = {
    auth: { appId: 7, token: async () => ok({ token: 'fixture', expiresAt: new Date(now.getTime() + 3600000).toISOString(), installationId: 20 }), identity: async () => ok({ id: 7, slug: 'octorun' }), invalidate: () => {} },
    repository: async () => {
      reads++
      return ok({ ref: repo, defaultBranch: 'main', private: false, archived: false })
    },
    snapshot: async () => {
      reads++
      return ok(snapshot())
    },
    files: async () => ok([{ path: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new', status: 'modified', truncated: false, additions: 1, deletions: 1 }]),
    permission: async () => {
      permissionChecks++
      return ok(permission)
    },
    readFile: async () => ok(null),
    readWorkflow: async () => ok({ sha: base, text: options.sourceText ?? null }),
    botIdentity: async () => ok(bot),
    async paginate(_repository, path) {
      if (path.includes('/pulls?'))
        return ok([{ number: 1 }])
      if (path.includes('/issues/comments?'))
        return ok(inputComments)
      if (path.includes('/issues/1/comments'))
        return ok(comments)
      if (path.includes('/pulls/1/reviews'))
        return ok(reviews)
      return ok([])
    },
    async request(_repository, pathAccess, path, request = {}) {
      const body = request.body as Record<string, unknown>
      if (path.includes('/check-runs?'))
        return ok({ check_runs: checkRuns })
      if (path.endsWith('/check-runs') && request.method === 'POST') {
        const value = { ...body, id: nextId++, app: { id: 7 } }
        checkRuns.push(value)
        return ok(value)
      }
      if (path.includes('/check-runs/') && request.method === 'PATCH') {
        const value = checkRuns.find(check => check.id === Number(path.split('/').at(-1)))!
        Object.assign(value, body)
        return ok(value)
      }
      if (path.endsWith('/issues/1/comments') && request.method === 'POST') {
        const value = { id: nextId++, user: { id: bot.id }, body: body.body }
        comments.push(value)
        return ok(value)
      }
      if (path.includes('/issues/comments/') && request.method === 'PATCH') {
        const value = comments.find(comment => comment.id === Number(path.split('/').at(-1)))!
        Object.assign(value, body)
        return ok(value)
      }
      if (path.endsWith('/pulls/1/reviews') && request.method === 'POST') {
        const value = { ...body, id: nextId++, user: { id: bot.id } }
        reviews.push(value)
        return ok(value)
      }
      return { _tag: 'Err', error: { _tag: 'Permanent', message: `Unexpected fixture route: ${pathAccess} ${path}.` } }
    },
  }
  const provider: AgentProvider = { id: 'test-provider', async generate(request) {
    providerCalls++
    if (options.failProvider)
      return { _tag: 'Err', error: { _tag: 'Permanent', message: 'The provider rejected this request.' } }
    return ok({ text: request.messages[0]!.content.includes('release') ? 'Update the input parser.' : '{"findings":[]}', usage: { inputTokens: 5, outputTokens: 5, costUsd: null } })
  } }
  const create = async (): Promise<OctorunService> => {
    const created = await createOctorun({ config, env: { APP_KEY: 'fixture-private-key', API_KEY: 'fixture-api-key', WEBHOOK_SECRET: secret }, now: () => now, client, provider })
    if (created._tag === 'Err')
      throw new Error(created.error.message)
    return created.value
  }
  let service = await create()
  cleanup.push(async () => {
    await service.close()
    await rm(stateDir, { recursive: true, force: true })
  })
  const webhook = async (event: string, payload: unknown, deliveryId = 'delivery-1') => {
    const body = JSON.stringify(payload)
    return service.handleWebhook({ deliveryId, event, body, signature: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` })
  }
  return { config, client, comments, reviews, checkRuns, inputComments, snapshot, webhook, service: () => service, reads: () => reads, providerCalls: () => providerCalls, permissionChecks: () => permissionChecks, moveHead: (sha: string) => {
    currentHead = sha
  }, setPermission: (value: 'read' | 'write') => {
    permission = value
  }, restart: async () => {
    await service.close()
    service = await create()
  } }
}

const issueComment = (body: string, id = 1) => ({ action: 'created', repository: { id: 10, full_name: 'acme/project' }, installation: { id: 20 }, sender: { ...actor, type: 'User' }, issue: { number: 1, pull_request: {} }, comment: { id, body, user: { ...actor, type: 'User' }, created_at: now.toISOString(), updated_at: now.toISOString() } })

const checkAction = (check: Record<string, unknown>, identifier: string) => ({ action: 'requested_action', repository: { id: 10, full_name: 'acme/project' }, installation: { id: 20 }, sender: { ...actor, type: 'User' }, check_run: check, requested_action: { identifier } })

describe('trusted repository workflows', () => {
  it('rejects aliases and duplicate workflow IDs before admission', () => {
    expect(parseRepositoryWorkflows('version: 1\nworkflows: &tasks []\nother: *tasks')).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
    const workflow = { version: 1, id: 'custom', name: 'Custom', on: [], tasks: [{ id: 'one', uses: 'changes.classify', with: {} }], concurrency: { mode: 'replace', group: 'target' }, limits: { maxAttempts: 1, timeoutMs: 1000, maxTokens: 100, maxCostUsd: null, maxDurationMs: 1000 } }
    expect(parseRepositoryWorkflows(JSON.stringify({ version: 1, workflows: [workflow, workflow] }))).toMatchObject({ _tag: 'Err', error: { message: 'Repository workflow ID is repeated: custom.' } })
  })
})

describe('reactive service composition', () => {
  it('previews a selected workflow against its live pinned target without executing tasks or publishing', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Presets', presets: ['adversarial-review', 'change-summary'] }
    const planned = await test.service().command('plan', { repository: repo.fullName, number: 1, workflow: 'change-summary' })
    expect(planned).toMatchObject({ _tag: 'Ok', value: {
      target: { _tag: 'PullRequest', number: 1, headSha: head, baseSha: base },
      workflow: { id: 'change-summary' },
      tasks: [{ id: 'classify', uses: 'changes.classify' }, { id: 'summarize', uses: 'changes.summarize' }, { id: 'comment', uses: 'changes.comment' }],
      selection: { _tag: 'Manual' },
      policy: { enabled: true },
      limits: { maxCostUsd: null },
    } })
    expect(test.service().runner.runs()).toEqual([])
    expect(test.providerCalls()).toBe(0)
    expect(test.comments).toEqual([])
    expect(test.reviews).toEqual([])
    expect(test.checkRuns).toEqual([])
  })

  it('rejects an unavailable workflow, missing pull request, or denied task capability during preview', async () => {
    const test = await setup()
    expect(await test.service().command('plan', { repository: repo.fullName, number: 1, workflow: 'missing' })).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
    test.config.repositories[0]!.policy.capabilities = ['repository:read']
    expect(await test.service().command('plan', { repository: repo.fullName, number: 1 })).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
    test.client.snapshot = async () => ({ _tag: 'Err', error: { _tag: 'Permanent', message: 'The pull request does not exist.' } })
    expect(await test.service().command('plan', { repository: repo.fullName, number: 404 })).toMatchObject({ _tag: 'Err', error: { message: 'The pull request does not exist.' } })
    expect(test.providerCalls()).toBe(0)
    expect(test.service().runner.runs()).toEqual([])
  })

  it('resumes queued work after a drain persists through restart', async () => {
    const test = await setup()
    expect(await test.service().command('drain', {})).toMatchObject({ _tag: 'Ok' })
    const queued = await test.service().run({ repository: repo.fullName, number: 1, requestId: 'paused-run' })
    expect(queued).toMatchObject({ _tag: 'Ok', value: { state: 'Queued' } })
    await test.restart()
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.service().store.operatorPaused()).toBe(true)
    await test.service().command('resume', { repository: repo.fullName })
    expect(test.service().store.operatorPaused()).toBe(true)
    expect(test.providerCalls()).toBe(0)
    expect(await test.service().command('resume', {})).toMatchObject({ _tag: 'Ok', value: { scope: 'controller', paused: false } })
    expect(test.service().store.operatorPaused()).toBe(false)
    expect(test.service().runner.runs().find(run => run.definition.id === 'adversarial-review')?.state._tag).toBe('Succeeded')
    expect(test.providerCalls()).toBe(2)
  })

  it('persists a signed webhook before network reads and resumes it after restart', async () => {
    const test = await setup()
    expect(await test.webhook('issue_comment', issueComment('@octorun status'))).toMatchObject({ _tag: 'Ok', value: { accepted: true } })
    expect(test.reads()).toBe(0)
    await test.restart()
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.service().runner.runs().map(run => run.state)).toEqual([{ _tag: 'Succeeded' }])
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('No workflow run exists')])
    expect(test.service().store.pendingDeliveries()).toEqual([])
  })

  it('runs the full review and closes its native check after manual ingress', async () => {
    const test = await setup()
    const result = await test.service().command('run', { repository: repo.fullName, number: 1, requestId: 'manual-one' })
    expect(result).toMatchObject({ _tag: 'Ok', value: { state: 'Succeeded', targetKey: '10:pull_request:1' } })
    expect(test.providerCalls()).toBe(2)
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('No actionable findings')])
    expect(test.checkRuns.map(check => ({ status: check.status, conclusion: check.conclusion }))).toEqual([{ status: 'completed', conclusion: 'success' }])
  })

  it('binds a manual request ID to its first accepted head', async () => {
    const test = await setup()
    const first = await test.service().command('run', { repository: repo.fullName, number: 1, requestId: 'manual-one' })
    test.moveHead('c'.repeat(40))
    const repeated = await test.service().command('run', { repository: repo.fullName, number: 1, requestId: 'manual-one' })
    expect(repeated).toEqual(first)
    expect(test.providerCalls()).toBe(2)
  })

  it('refuses a changed provider configuration when recovering accepted work', async () => {
    const test = await setup()
    expect(await test.service().run({ repository: repo.fullName, number: 1, requestId: 'pinned-provider' })).toMatchObject({ _tag: 'Ok', value: { state: 'Queued' } })
    test.config.provider.model = 'different-model'
    await test.restart()
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.service().runner.runs()).toMatchObject([{ state: { _tag: 'Failed', error: { _tag: 'Configuration' } } }])
  })

  it('keeps provider failure separate from a clean review', async () => {
    const test = await setup({ failProvider: true })
    expect(await test.service().command('run', { repository: repo.fullName, number: 1 })).toMatchObject({ _tag: 'Ok', value: { state: 'Failed' } })
    expect(test.comments.some(comment => String(comment.body).includes('No actionable findings'))).toBe(false)
    expect(test.checkRuns.map(check => check.conclusion)).toEqual(['failure'])
  })

  it('runs the change-summary chain without a review task', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Presets', presets: ['change-summary'] }
    expect(await test.service().command('run', { repository: repo.fullName, number: 1, workflow: 'change-summary' })).toMatchObject({ _tag: 'Ok', value: { state: 'Succeeded' } })
    expect(test.providerCalls()).toBe(1)
    expect(test.reviews).toEqual([])
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('Update the input parser.')])
  })

  it('routes help and unknown commands without an agent turn', async () => {
    const test = await setup()
    await test.webhook('issue_comment', issueComment('@octorun help'), 'help-one')
    await test.webhook('issue_comment', issueComment('@octorun repair everything now', 2), 'unknown-two')
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.comments.map(comment => comment.body)).toEqual(expect.arrayContaining([expect.stringContaining('Use @octorun help'), expect.stringContaining('Unknown command')]))
  })

  it('denies model spending by a reader and allows information commands', async () => {
    const test = await setup()
    test.setPermission('read')
    await test.webhook('issue_comment', issueComment('@octorun review'), 'denied-review')
    await test.webhook('issue_comment', issueComment('@octorun status', 2), 'allowed-status')
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('No workflow run exists')])
  })

  it('acknowledges pause and still runs an explicit review request', async () => {
    const test = await setup()
    await test.webhook('issue_comment', issueComment('@octorun pause'), 'pause-one')
    await test.service().settle()
    expect(test.comments.map(comment => comment.body)).toEqual([expect.stringContaining('Automatic workflow runs are paused')])
    await test.webhook('issue_comment', issueComment('@octorun review', 2), 'review-two')
    await test.service().settle()
    expect(test.providerCalls()).toBe(2)
    expect(test.service().runner.runs().filter(run => run.definition.id === 'adversarial-review').map(run => run.state._tag)).toEqual(['Succeeded'])
  })

  it('revokes paid execution when the command actor loses write access', async () => {
    const test = await setup()
    await test.webhook('issue_comment', issueComment('@octorun review'), 'revoked-one')
    await test.service().tick()
    test.setPermission('read')
    await test.service().settle()
    expect(test.providerCalls()).toBe(0)
    expect(test.service().runner.runs().map(run => run.state)).toEqual([{ _tag: 'Failed', error: { _tag: 'Authorization', message: 'Repository policy does not permit this user to start paid work.' } }])
    expect(test.checkRuns.map(check => check.conclusion)).toEqual(['action_required'])
  })

  it('processes explicit poll backfill and never repeats the same observed head', async () => {
    const test = await setup()
    expect(await test.service().command('poll', { backfill: true })).toMatchObject({ _tag: 'Ok', value: { accepted: 1 } })
    expect(test.providerCalls()).toBe(2)
    expect(await test.service().command('poll', { backfill: true })).toMatchObject({ _tag: 'Ok', value: { accepted: 0 } })
    expect(test.providerCalls()).toBe(2)
  })

  it('reruns the recorded custom workflow once for one native action delivery', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Inline', definitions: [{ ...changeSummaryPreset(), id: 'custom-summary', name: 'Custom summary' }] }
    expect(await test.service().command('run', { repository: repo.fullName, number: 1, workflow: 'custom-summary' })).toMatchObject({ _tag: 'Ok', value: { state: 'Succeeded' } })
    const payload = checkAction(test.checkRuns[0]!, 'rerun')
    await test.webhook('check_run', payload, 'rerun-one')
    await test.webhook('check_run', payload, 'rerun-one')
    await test.service().settle()
    expect(test.service().runner.runs().map(run => ({ workflow: run.definition.id, state: run.state._tag }))).toEqual([{ workflow: 'custom-summary', state: 'Succeeded' }, { workflow: 'custom-summary', state: 'Succeeded' }])
    expect(test.providerCalls()).toBe(2)
  })

  it('cancels only the workflow run recorded by the native check', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Presets', presets: ['adversarial-review', 'change-summary'] }
    const review = await test.service().run({ repository: repo.fullName, number: 1, workflow: 'adversarial-review' })
    const summary = await test.service().run({ repository: repo.fullName, number: 1, workflow: 'change-summary' })
    if (review._tag !== 'Ok' || summary._tag !== 'Ok')
      throw new Error('Expected both workflows to be accepted.')
    await test.service().tick()
    const runId = (review.value as { runId: string }).runId
    const check = test.checkRuns.find(value => value.external_id === `octorun:${runId}`)!
    await test.webhook('check_run', checkAction(check, 'cancel'), 'cancel-one')
    await test.service().settle()
    expect(test.service().runner.inspect(runId)?.state._tag).toBe('Cancelled')
    expect(test.service().runner.inspect((summary.value as { runId: string }).runId)?.state._tag).toBe('Succeeded')
    expect(test.providerCalls()).toBe(1)
  })

  it('denies native actions after the actor loses repository write access', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Presets', presets: ['change-summary'] }
    await test.service().command('run', { repository: repo.fullName, number: 1, workflow: 'change-summary' })
    test.setPermission('read')
    await test.webhook('check_run', checkAction(test.checkRuns[0]!, 'rerun'), 'denied-rerun')
    await test.service().settle()
    expect(test.providerCalls()).toBe(1)
    expect(test.service().runner.runs().map(run => run.definition.id)).toEqual(['change-summary'])
    expect(test.permissionChecks()).toBe(1)
  })

  it('ignores foreign App checks and rejects an unrecorded check ID', async () => {
    const test = await setup()
    test.config.repositories[0]!.workflowSource = { _tag: 'Presets', presets: ['change-summary'] }
    await test.service().command('run', { repository: repo.fullName, number: 1, workflow: 'change-summary' })
    const check = test.checkRuns[0]!
    await test.webhook('check_run', checkAction({ ...check, app: { id: 8 } }, 'rerun'), 'foreign-app')
    await test.webhook('check_run', checkAction({ ...check, id: 999999 }, 'rerun'), 'unrecorded-id')
    await test.service().settle()
    expect(test.providerCalls()).toBe(1)
    expect(test.service().runner.runs().map(run => run.definition.id)).toEqual(['change-summary'])
    expect(test.permissionChecks()).toBe(0)
  })
})
