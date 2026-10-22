import type { EventEnvelope, PullRequestSnapshot } from '@harlan-zw/octorun'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { err, ok } from '@harlan-zw/octorun'
import { afterEach, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { createKitRunAuthorizer, loadKitServiceSettings } from '../src/authority.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'octorun-authority-'))
  roots.push(root)
  const configurationPath = join(root, 'config.yml')
  const input = {
    github: { app_id: 123, private_key_path: '/private/key.pem', allowed_owners: ['harlan-zw'] },
    storage: { path: '/private/legacy/state.sqlite' },
    repositories: [{ github: 'harlan-zw/harlan-agent-kit', checkout: '/repos/harlan-agent-kit', enabled: true, ownership: 'owned', writable_pr_authors: ['maintainer', 'trusted[bot]'] }],
  }
  const write = () => writeFile(configurationPath, stringify(input), { mode: 0o600 })
  await write()
  const settings = await loadKitServiceSettings(configurationPath)
  if (settings._tag === 'Err')
    throw new Error(settings.error.message)
  const repository = { fullName: 'harlan-zw/harlan-agent-kit', id: 7, installationId: 9 }
  const snapshot: PullRequestSnapshot = { repository, number: 11, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), title: 'Change', body: '', author: { login: 'maintainer', kind: 'User', id: 6 }, draft: false, state: 'open', changedFiles: 1, updatedAt: new Date().toISOString(), labels: [], headRepository: 'outside/fork' }
  const event: EventEnvelope = { repository, id: 'poll:11', source: 'poll', name: 'pull_request', action: 'observed', actor: null, target: { _tag: 'PullRequest', number: 11, headSha: snapshot.headSha, baseSha: snapshot.baseSha }, occurredAt: snapshot.updatedAt, receivedAt: snapshot.updatedAt, semanticKey: 'pr:11', data: {} }
  let reads = 0
  const authorize = createKitRunAuthorizer({ configurationPath, settings: settings.value, repository, client: { snapshot: async () => {
    reads++
    return ok(snapshot)
  } } })
  return { input, write, configurationPath, snapshot, event, authorize, reads: () => reads }
}

it.each([
  ['maintainer', 'User', 'Ok'],
  ['MAINTAINER', 'User', 'Ok'],
  ['outside', 'User', 'Err'],
  ['random[bot]', 'Bot', 'Err'],
  ['trusted[bot]', 'Bot', 'Ok'],
] as const)('uses explicit Service trust for automatic author %s', async (login, kind, expected) => {
  const f = await fixture()
  f.snapshot.author = { id: 6, login, kind }
  expect(await f.authorize({ event: f.event })).toMatchObject({ _tag: expected })
  expect(f.reads()).toBe(1)
})

it('uses the current pull request author instead of event text or the webhook sender', async () => {
  const f = await fixture()
  f.event.actor = { id: 6, login: 'maintainer', kind: 'User' }
  f.event.data = { author: 'maintainer' }
  f.snapshot.author.login = 'outside'
  expect(await f.authorize({ event: f.event })).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
})

it.each(['manual', 'command', 'conversation', 'free response'] as const)('preserves explicit %s authority after Core authorizes the actor', async (authority) => {
  const f = await fixture()
  f.snapshot.author.login = 'outside'
  if (authority === 'manual')
    f.event.source = 'manual'
  if (authority === 'command')
    f.event.action = 'command'
  if (authority === 'conversation')
    f.event.name = 'octorun.conversation'
  if (authority === 'free response')
    f.event.name = 'octorun.command'
  expect(await f.authorize({ event: f.event })).toEqual(ok(undefined))
  expect(f.reads()).toBe(0)
})

it.each(['owner', 'repository', 'ownership', 'authentication', 'app', 'key', 'checkout', 'storage', 'trust'] as const)('honors %s revocation without restarting the controller', async (change) => {
  const f = await fixture()
  expect(await f.authorize({ event: f.event })).toEqual(ok(undefined))
  const mapping = f.input.repositories[0]!
  if (change === 'owner')
    f.input.github.allowed_owners = ['another-owner']
  if (change === 'repository')
    mapping.enabled = false
  if (change === 'ownership')
    mapping.ownership = 'maintained'
  if (change === 'authentication')
    Object.assign(mapping, { authentication: 'user' })
  if (change === 'app')
    f.input.github.app_id++
  if (change === 'key')
    f.input.github.private_key_path = '/private/replaced.pem'
  if (change === 'checkout')
    mapping.checkout = '/repos/replaced'
  if (change === 'storage')
    f.input.storage.path = '/other/state.sqlite'
  if (change === 'trust')
    mapping.writable_pr_authors = []
  await f.write()
  expect(await f.authorize({ event: f.event })).toMatchObject({ _tag: 'Err' })
})

it('rejects current authority with unsafe file permissions even for an explicit operator run', async () => {
  const f = await fixture()
  f.event.source = 'manual'
  await chmod(f.configurationPath, 0o644)
  expect(await f.authorize({ event: f.event })).toMatchObject({ _tag: 'Err', error: { _tag: 'Configuration' } })
})

it.each(['head', 'base', 'repository', 'installation'] as const)('rejects a changed %s identity', async (change) => {
  const f = await fixture()
  if (change === 'head')
    f.snapshot.headSha = 'c'.repeat(40)
  if (change === 'base')
    f.snapshot.baseSha = 'c'.repeat(40)
  if (change === 'repository')
    f.snapshot.repository = { ...f.snapshot.repository, id: 99 }
  if (change === 'installation')
    f.snapshot.repository = { ...f.snapshot.repository, installationId: 99 }
  expect(await f.authorize({ event: f.event })).toMatchObject({ _tag: 'Err', error: { _tag: 'Authorization' } })
})

it('propagates an unavailable current snapshot without granting trust', async () => {
  const f = await fixture()
  const settings = await loadKitServiceSettings(f.configurationPath)
  if (settings._tag === 'Err')
    throw new Error(settings.error.message)
  const denied = err({ _tag: 'Transient', message: 'Snapshot unavailable.' })
  const authorize = createKitRunAuthorizer({ configurationPath: f.configurationPath, settings: settings.value, repository: f.event.repository, client: { snapshot: async () => denied } })
  expect(await authorize({ event: f.event })).toEqual(denied)
})
