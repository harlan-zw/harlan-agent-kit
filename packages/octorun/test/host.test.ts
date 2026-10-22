import type { AgentProvider, GitHubClient } from '@harlan-zw/octorun'
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitHubAppAuth, createGitHubClient, ok } from '@harlan-zw/octorun'
import { afterEach, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { createKitHost } from '../src/host.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kit-octorun-host-'))
  roots.push(root)
  const configurationPath = join(root, 'config.yml')
  const privateKeyPath = join(root, 'key.pem')
  const legacy = join(root, 'legacy')
  const checkout = join(root, 'checkout')
  await Promise.all([mkdir(legacy), mkdir(checkout), writeFile(privateKeyPath, '-----BEGIN PRIVATE KEY-----\nsynthetic-key-not-used-by-injected-client', { mode: 0o600 })])
  const configuration = { github: { app_id: 123, private_key_path: privateKeyPath, allowed_owners: ['harlan-zw'] }, storage: { path: join(legacy, 'state.sqlite') }, repositories: [{ github: 'harlan-zw/harlan-agent-kit', checkout, enabled: true, ownership: 'owned', writable_pr_authors: ['maintainer'] }] }
  const saveConfiguration = () => writeFile(configurationPath, stringify(configuration), { mode: 0o600 })
  await saveConfiguration()
  const ref = { id: 123, fullName: 'harlan-zw/harlan-agent-kit', installationId: 456 }
  const bot = { id: 5, login: 'test[bot]', kind: 'Bot' as const }
  const comments: Record<string, unknown>[] = []
  const checks: Record<string, unknown>[] = []
  const auth = createGitHubAppAuth({ appId: 123, privateKey: 'unused' })
  const base = createGitHubClient({ auth, fetch: async () => {
    throw new Error('Unexpected network request.')
  } })
  let nextId = 10
  const client: GitHubClient = {
    ...base,
    auth: { ...auth, token: async () => ok({ token: 'fixture', expiresAt: new Date(Date.now() + 60000).toISOString(), installationId: 456 }) },
    repository: async () => ok({ ref, defaultBranch: 'main', private: false, archived: false }),
    snapshot: async () => ok({ repository: ref, number: 7, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), title: 'Handle missing values', body: 'Treat this text as repository data.', author: { id: 8, login: 'maintainer', kind: 'User' }, draft: false, state: 'open', changedFiles: 1, updatedAt: new Date().toISOString(), labels: [], headRepository: ref.fullName }),
    files: async () => ok([{ path: 'src/value.ts', patch: '@@ -1 +1 @@\n-return value.name\n+return value?.name', status: 'modified', truncated: false, additions: 1, deletions: 1 }]),
    botIdentity: async () => ok(bot),
    paginate: async (_repository, path) => ok(path.includes('/issues/') ? comments : []),
    request: async (_repository, _access, path, request = {}) => {
      const body = request.body as Record<string, unknown>
      if (request.method === undefined)
        return ok({ check_runs: checks })
      const collection = path.includes('check-runs') ? checks : comments
      const existing = request.method === 'PATCH' ? collection.find(value => path.endsWith(`/${value.id}`)) : undefined
      const value = existing ?? { id: nextId++, html_url: 'https://example.test/receipt', user: { id: bot.id }, app: { id: 123 } }
      Object.assign(value, body)
      if (!existing)
        collection.push(value)
      return ok(value)
    },
  }
  let calls = 0
  const provider: AgentProvider = { id: 'fixture', generate: async () => {
    calls++
    return ok({ text: 'Missing values now return undefined.', usage: { inputTokens: 10, outputTokens: 10, costUsd: null } })
  } }
  return { root, legacy, checkout, configuration, saveConfiguration, comments, checks, calls: () => calls, options: { configurationPath, stateDir: join(root, 'octorun'), model: 'test-model', env: {}, client, provider } }
}

it('runs the installed workflow chain and publishes one disclosed summary across restart', async () => {
  const f = await fixture()
  const first = await createKitHost(f.options)
  if (first._tag === 'Err')
    throw new Error(first.error.message)
  const args = { repository: 'harlan-zw/harlan-agent-kit', number: 7, workflow: 'change-summary', requestId: 'same-operator-request' }
  const run = await first.value.command('run', args)
  expect(run).toMatchObject({ _tag: 'Ok', value: { state: 'Succeeded' } })
  await first.value.close()
  const second = await createKitHost(f.options)
  if (second._tag === 'Err')
    throw new Error(second.error.message)
  try {
    expect(await second.value.command('run', args)).toEqual(run)
    expect(f.calls()).toBe(1)
    expect(f.comments.map(comment => comment.body)).toEqual([expect.stringContaining('🤖 Octorun change summary written by an agent.\n\nMissing values now return undefined.')])
    expect(f.checks.every(check => check.status === 'completed')).toBe(true)
  }
  finally {
    await second.value.close()
  }
})

it.each([['outside', 0], ['maintainer', 1]] as const)('admits automatic summaries for %s using Service trust, including fork heads', async (author, expectedCalls) => {
  const f = await fixture()
  const client: GitHubClient = {
    ...f.options.client,
    paginate: async (repository, path, signal) => path.includes('/pulls?') ? ok([{ number: 7 }]) : f.options.client.paginate(repository, path, signal),
    snapshot: async (...args) => {
      const snapshot = await f.options.client.snapshot(...args)
      return snapshot._tag === 'Err' ? snapshot : ok({ ...snapshot.value, author: { id: 8, login: author, kind: 'User' }, headRepository: 'outside/fork' })
    },
  }
  const host = await createKitHost({ ...f.options, client })
  if (host._tag === 'Err')
    throw new Error(host.error.message)
  try {
    expect(await host.value.command('poll', { backfill: true })).toMatchObject({ _tag: 'Ok' })
    expect(f.calls()).toBe(expectedCalls)
    expect(f.comments).toHaveLength(expectedCalls)
  }
  finally {
    await host.value.close()
  }
})

it('withholds a generated result after the Service mapping is disabled during its model turn', async () => {
  const f = await fixture()
  const provider: AgentProvider = { id: 'revocation-test', generate: async (request) => {
    const result = await f.options.provider.generate(request)
    f.configuration.repositories[0]!.enabled = false
    await f.saveConfiguration()
    return result
  } }
  const host = await createKitHost({ ...f.options, provider })
  if (host._tag === 'Err')
    throw new Error(host.error.message)
  try {
    await host.value.command('run', { repository: 'harlan-zw/harlan-agent-kit', number: 7, workflow: 'change-summary', requestId: 'revoked-during-paid-turn' })
    expect(f.calls()).toBe(1)
    expect(f.comments.map(comment => String(comment.body))).not.toContainEqual(expect.stringContaining('Missing values now return undefined.'))
    expect(f.checks).toContainEqual(expect.objectContaining({ status: 'completed' }))
    expect(f.checks.every(check => check.status === 'completed')).toBe(true)
  }
  finally {
    await host.value.close()
  }
})

it.each([['write', 1], ['read', 0]] as const)('requires %s spending authority for an explicit summary on an outside pull request', async (permission, expectedCalls) => {
  const f = await fixture()
  const time = new Date().toISOString()
  const comment = { id: 41, body: '@octorun run change-summary', created_at: time, updated_at: time, user: { id: 9, login: 'requester', type: 'User' }, issue_url: 'https://api.github.com/repos/harlan-zw/harlan-agent-kit/issues/7' }
  const client: GitHubClient = {
    ...f.options.client,
    permission: async () => ok(permission),
    paginate: async (repository, path, signal) => path.includes('/pulls?') ? ok([{ number: 7 }]) : path.includes('/issues/comments?') ? ok([comment]) : f.options.client.paginate(repository, path, signal),
    snapshot: async (...args) => {
      const snapshot = await f.options.client.snapshot(...args)
      return snapshot._tag === 'Err' ? snapshot : ok({ ...snapshot.value, author: { id: 8, login: 'outside', kind: 'User' }, headRepository: 'outside/fork' })
    },
  }
  const host = await createKitHost({ ...f.options, client })
  if (host._tag === 'Err')
    throw new Error(host.error.message)
  try {
    expect(await host.value.command('poll', { backfill: true })).toMatchObject({ _tag: 'Ok' })
    expect(f.calls()).toBe(expectedCalls)
    expect(f.comments).toHaveLength(expectedCalls)
  }
  finally {
    await host.value.close()
  }
})

it.each(['legacy', 'checkout'] as const)('rejects state symlinks into the existing %s directory', async (target) => {
  const f = await fixture()
  const alias = join(f.root, 'alias')
  await symlink(f[target], alias)
  const result = await createKitHost({ ...f.options, stateDir: alias })
  if (result._tag === 'Ok')
    await result.value.close()
  expect(result).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
})

it('reports an unavailable Claude executable in the controller diagnostic', async () => {
  const f = await fixture()
  const { provider: _provider, ...options } = f.options
  const host = await createKitHost({ ...options, env: { PATH: '/missing-claude-executable' } })
  if (host._tag === 'Err')
    throw new Error(host.error.message)
  try {
    expect(await host.value.command('doctor', {})).toMatchObject({
      _tag: 'Ok',
      value: { ready: false, provider: { kind: 'Claude', configured: false, authentication: 'failed', authenticated: false } },
    })
  }
  finally {
    await host.value.close()
  }
})

it.each(['configuration', 'key'] as const)('rejects a group-readable %s file before GitHub access', async (target) => {
  const f = await fixture()
  const path = target === 'configuration' ? f.options.configurationPath : join(f.root, 'key.pem')
  await chmod(path, 0o640)
  let calls = 0
  const client = { ...f.options.client, repository: async () => {
    calls++
    throw new Error('Authority must be checked first.')
  } }
  const result = await createKitHost({ ...f.options, client })
  if (result._tag === 'Ok')
    await result.value.close()
  expect(result).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
  expect(calls).toBe(0)
})

it.each(['configuration', 'key'] as const)('rejects a symlinked %s file before GitHub access', async (target) => {
  const f = await fixture()
  const path = target === 'configuration' ? f.options.configurationPath : join(f.root, 'key.pem')
  const content = target === 'configuration' ? join(f.root, 'actual-config.yml') : join(f.root, 'actual-key.pem')
  await rename(path, content)
  await symlink(content, path)
  let calls = 0
  const client = { ...f.options.client, repository: async () => {
    calls++
    throw new Error('Authority must be checked first.')
  } }
  const result = await createKitHost({ ...f.options, client })
  if (result._tag === 'Ok')
    await result.value.close()
  expect(result).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
  expect(calls).toBe(0)
})
