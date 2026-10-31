import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveWorkerNuxtseo, workerNuxtseoEnvironment } from '../src/worker-nuxtseo.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { name?: string, dependencies?: Record<string, string> } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'worker-nuxtseo-'))
  roots.push(home)
  const tools = join(home, '.local/bin')
  const root = join(home, 'installed')
  await mkdir(tools, { recursive: true })
  await mkdir(join(root, 'skills/nuxtseo-cli'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: options.name ?? '@nuxtseo/cli', bin: { nuxtseo: './cli.js' }, dependencies: options.dependencies }))
  await writeFile(join(root, 'cli.js'), 'console.log("version")')
  await writeFile(join(root, 'skills/nuxtseo-cli/SKILL.md'), 'NuxtSEO Skill.')
  await writeFile(join(tools, 'nuxtseo'), `#!/bin/sh\n# cmd-shim-target=${root}/cli.js\n`, { mode: 0o755 })
  return { home, tools, root }
}

it('rejects a missing command before starting a NuxtSEO Routine', async () => {
  const home = await mkdtemp(join(tmpdir(), 'worker-nuxtseo-'))
  roots.push(home)
  await expect(resolveWorkerNuxtseo(home)).rejects.toThrow('requires the installed NuxtSEO CLI')
})

it('rejects a command without an installed package target', async () => {
  const input = await fixture()
  await writeFile(join(input.tools, 'nuxtseo'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await expect(resolveWorkerNuxtseo(input.home)).rejects.toThrow('must use a pnpm package shim')
})

it('rejects a command pointing to a different package', async () => {
  const input = await fixture({ name: 'other-package' })
  await expect(resolveWorkerNuxtseo(input.home)).rejects.toThrow('does not match its package manifest')
})

it('rejects an incomplete package dependency closure before starting a Routine', async () => {
  const input = await fixture({ dependencies: { missing: '1' } })
  await expect(resolveWorkerNuxtseo(input.home)).rejects.toThrow('dependency is missing: missing')
})

async function credentials() {
  const root = await mkdtemp(join(tmpdir(), 'worker-nuxtseo-auth-'))
  roots.push(root)
  const environmentFile = join(root, 'viewer.env')
  const configurationPath = join(root, 'nuxtseo-worker.json')
  await writeFile(environmentFile, 'NUXTSEO_TOKEN=fixture-viewer\nCLOUDFLARE_API_TOKEN=unrelated\nHOME=/other\n', { mode: 0o600 })
  await writeFile(configurationPath, JSON.stringify({ environmentFile, repositories: ['owner/site'] }), { mode: 0o600 })
  return { root, environmentFile, input: { configurationPath, repository: 'owner/site', taskId: 'owner/site:seo-review:2026-10-31T00:00:00.000Z' } }
}

it.each(['seo-review', 'vitals-review'])('provides only the NuxtSEO token to a selected %s repository', async (routine) => {
  const { input } = await credentials()
  expect(await workerNuxtseoEnvironment({ ...input, taskId: `owner/site:${routine}:2026-10-31T00:00:00.000Z` })).toEqual({ NUXTSEO_TOKEN: 'fixture-viewer' })
})

it('leaves an unselected repository without the shared token', async () => {
  const { input } = await credentials()
  expect(await workerNuxtseoEnvironment({ ...input, repository: 'owner/client', taskId: 'owner/client:seo-review:2026-10-31T00:00:00.000Z' })).toEqual({})
})

it.each([true, false])('matches GitHub repository casing with shared configuration %s', async (configured) => {
  const { input, environmentFile } = await credentials()
  if (configured)
    await writeFile(input.configurationPath, JSON.stringify({ environmentFile, repositories: ['OWNER/SITE'] }), { mode: 0o600 })
  else
    await rm(input.configurationPath)
  expect(await workerNuxtseoEnvironment({ ...input, repository: 'Owner/Site' })).toEqual(configured ? { NUXTSEO_TOKEN: 'fixture-viewer' } : {})
})

it('never opens shared credentials for another role', async () => {
  const { input, environmentFile } = await credentials()
  await rm(environmentFile)
  expect(await workerNuxtseoEnvironment({ ...input, taskId: 'owner/site:dependency-updates:2026-10-31T00:00:00.000Z' })).toEqual({})
})

it('rejects a Routine that names another Worktree repository', async () => {
  const { input } = await credentials()
  await expect(workerNuxtseoEnvironment({ ...input, repository: 'owner/other' })).rejects.toThrow('repository')
})

it('preserves repository authentication when shared configuration is absent', async () => {
  const { input } = await credentials()
  await rm(input.configurationPath)
  expect(await workerNuxtseoEnvironment(input)).toEqual({})
})

it.each(['configuration', 'environment'])('refuses a shared %s file readable by another account', async (kind) => {
  const { input, environmentFile } = await credentials()
  await chmod(kind === 'configuration' ? input.configurationPath : environmentFile, 0o644)
  await expect(workerNuxtseoEnvironment(input)).rejects.toThrow('private')
})

it('refuses an aliased credential source', async () => {
  const { input, root, environmentFile } = await credentials()
  const original = join(root, 'original.env')
  await writeFile(original, 'NUXTSEO_TOKEN=other\n', { mode: 0o600 })
  await rm(environmentFile)
  await symlink(original, environmentFile)
  await expect(workerNuxtseoEnvironment(input)).rejects.toThrow()
})

it.each([
  { environmentFile: 'relative.env', repositories: ['owner/site'] },
  { environmentFile: '/unused', repositories: [] },
  { environmentFile: '/unused', repositories: ['owner/site:seo-review'] },
])('refuses invalid shared credential configuration %#', async (value) => {
  const { input } = await credentials()
  await writeFile(input.configurationPath, JSON.stringify(value), { mode: 0o600 })
  await expect(workerNuxtseoEnvironment(input)).rejects.toThrow('absolute NuxtSEO environment file and explicit repositories')
})

it('reports a missing token instead of silently falling back to another identity', async () => {
  const { input, environmentFile } = await credentials()
  await writeFile(environmentFile, 'CLOUDFLARE_API_TOKEN=unrelated\n', { mode: 0o600 })
  await expect(workerNuxtseoEnvironment(input)).rejects.toThrow('no token')
})
