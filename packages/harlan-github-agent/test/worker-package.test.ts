import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveWorkerPackage } from '../src/worker-package.ts'

const roots: string[] = []
const command = { name: 'dev-browser', package: 'dev-browser', label: 'browser' }
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(tool = command) {
  const home = await mkdtemp(join(tmpdir(), 'worker-package-'))
  roots.push(home)
  const tools = join(home, '.local/bin')
  const root = join(home, 'installed')
  await Promise.all([mkdir(tools, { recursive: true }), mkdir(root)])
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: tool.package, bin: { [tool.name]: './cli.js' } }))
  await writeFile(join(root, 'cli.js'), 'console.log("fixture")')
  await writeFile(join(tools, tool.name), `#!/bin/sh\n# cmd-shim-target=${root}/cli.js\n`, { mode: 0o755 })
  return { home, root, tools }
}

it('keeps an absent optional command unavailable', async () => {
  const { home, tools } = await fixture()
  await rm(join(tools, 'dev-browser'))
  expect(await resolveWorkerPackage(home, command)).toBeUndefined()
})

it.each(['wrong-package', 'different-entry', 'absolute-entry', 'outside-entry', 'symlink-entry'] as const)('refuses a command that disagrees with its package: %s', async (kind) => {
  const { home, root } = await fixture()
  const outside = join(home, 'outside.js')
  await writeFile(outside, 'console.log("outside")')
  await writeFile(join(root, 'other.js'), 'console.log("other")')
  const bin = kind === 'different-entry' ? './other.js' : kind === 'absolute-entry' ? join(root, 'cli.js') : kind === 'outside-entry' ? '../outside.js' : './cli.js'
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: kind === 'wrong-package' ? 'another-package' : 'dev-browser', bin: { 'dev-browser': bin } }))
  if (kind === 'symlink-entry' || kind === 'outside-entry') {
    await rm(join(root, 'cli.js'))
    await symlink(outside, join(root, 'cli.js'))
  }
  await expect(resolveWorkerPackage(home, command)).rejects.toThrow('does not match its package manifest')
})

it('rejects a changed shim target instead of executing another package entry', async () => {
  const { home, root, tools } = await fixture()
  await writeFile(join(root, 'other.js'), 'console.log("other")')
  await writeFile(join(tools, 'dev-browser'), `#!/bin/sh\n# cmd-shim-target=${root}/other.js\n`, { mode: 0o755 })
  await expect(resolveWorkerPackage(home, command)).rejects.toThrow('does not match its package manifest')
})

it('rejects missing required dependencies and skips absent optional packages', async () => {
  const { home, root } = await fixture()
  const manifest = { name: 'dev-browser', bin: { 'dev-browser': './cli.js' }, dependencies: { missing: '1' } }
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
  await expect(resolveWorkerPackage(home, command)).rejects.toThrow('dependency is missing: missing')
  await writeFile(join(root, 'package.json'), JSON.stringify({ ...manifest, optionalDependencies: { missing: '1' } }))
  expect((await resolveWorkerPackage(home, command))?.entry).toBe(join(root, 'cli.js'))
})

it('bounds the installed dependency closure', async () => {
  const { home, root } = await fixture()
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dev-browser', bin: { 'dev-browser': './cli.js' }, dependencies: { 'fixture-0': '1' } }))
  await Promise.all(Array.from({ length: 128 }, async (_, index) => {
    const dependency = join(home, 'node_modules', `fixture-${index}`)
    await mkdir(dependency, { recursive: true })
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: `fixture-${index}`, dependencies: index < 127 ? { [`fixture-${index + 1}`]: '1' } : {} }))
  }))
  await expect(resolveWorkerPackage(home, command)).rejects.toThrow('exceeds 128 packages')
})

it('accepts the trusted npm closure bound and rejects another package beyond it', async () => {
  const npm = { name: 'npm', package: 'npm', label: 'npm', maximumPackages: 256 as const }
  const { home, root } = await fixture(npm)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'npm', bin: { npm: './cli.js' }, dependencies: { 'fixture-0': '1' } }))
  await Promise.all(Array.from({ length: 256 }, async (_, index) => {
    const dependency = join(home, 'node_modules', `fixture-${index}`)
    await mkdir(dependency, { recursive: true })
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ name: `fixture-${index}`, dependencies: index < 254 ? { [`fixture-${index + 1}`]: '1' } : {} }))
  }))
  expect((await resolveWorkerPackage(home, npm))?.entry).toBe(join(root, 'cli.js'))
  await writeFile(join(home, 'node_modules/fixture-254/package.json'), JSON.stringify({ name: 'fixture-254', dependencies: { 'fixture-255': '1' } }))
  await expect(resolveWorkerPackage(home, npm)).rejects.toThrow('exceeds 256 packages')
})
