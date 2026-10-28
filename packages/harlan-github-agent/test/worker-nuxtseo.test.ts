import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveWorkerNuxtseo } from '../src/worker-nuxtseo.ts'

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
