import type { AgentProvider, GitHubClient } from '@harlan-zw/octorun'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
  await Promise.all([mkdir(legacy), mkdir(checkout), writeFile(privateKeyPath, 'synthetic-key-not-used-by-injected-client')])
  await writeFile(configurationPath, stringify({ github: { app_id: 123, private_key_path: privateKeyPath, allowed_owners: ['harlan-zw'] }, storage: { path: join(legacy, 'state.sqlite') }, repositories: [{ github: 'harlan-zw/harlan-agent-kit', checkout, enabled: true, ownership: 'owned' }] }))
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
  return { root, legacy, checkout, comments, checks, calls: () => calls, options: { configurationPath, stateDir: join(root, 'octorun'), model: 'test-model', env: {}, client, provider } }
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

it.each(['legacy', 'checkout'] as const)('rejects state symlinks into the existing %s directory', async (target) => {
  const f = await fixture()
  const alias = join(f.root, 'alias')
  await symlink(f[target], alias)
  const result = await createKitHost({ ...f.options, stateDir: alias })
  if (result._tag === 'Ok')
    await result.value.close()
  expect(result).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
})
