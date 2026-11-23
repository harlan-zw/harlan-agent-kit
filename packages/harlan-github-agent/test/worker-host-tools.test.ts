import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolvePnpmRuntimePackages, resolveWorkerHostTools } from '../src/worker-host-tools.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'host-tools-'))
  roots.push(home)
  await mkdir(join(home, '.local/bin'), { recursive: true })
  return home
}

it('prefers the synced release and follows changed installation symlinks', async () => {
  const home = await fixture()
  const installed = join(home, '.local/bin/gh')
  await writeFile(installed, 'old', { mode: 0o755 })
  const managed = join(home, '.local/share/harlan-agent-kit/tools/bin/gh')
  await mkdir(dirname(managed), { recursive: true })
  const first = join(home, 'first')
  const second = join(home, 'second')
  await writeFile(first, 'first', { mode: 0o755 })
  await writeFile(second, 'second', { mode: 0o755 })
  await symlink(first, managed)
  expect((await resolveWorkerHostTools(home, [])).gh).toBe(first)
  await rm(managed)
  await symlink(second, managed)
  expect((await resolveWorkerHostTools(home, [])).gh).toBe(second)
})

it('resolves the current pnpm Codex package rather than a stored provider version', async () => {
  const home = await fixture()
  const packageRoot = join(home, 'packages/codex')
  const binary = join(packageRoot, 'vendor', `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`, 'bin/codex')
  await mkdir(dirname(binary), { recursive: true })
  await writeFile(binary, 'native', { mode: 0o755 })
  const host = join(dirname(binary), 'codex-code-mode-host')
  await writeFile(host, 'native host', { mode: 0o755 })
  await writeFile(join(home, '.local/bin/codex'), `#!/bin/sh\n# cmd-shim-target=${packageRoot}/bin/codex.js\n`, { mode: 0o755 })
  expect((await resolveWorkerHostTools(home, ['/usr/bin'])).codex).toBe(binary)
  expect((await resolveWorkerHostTools(home, ['/usr/bin']))['codex-code-mode-host']).toBe(host)
})

it('refuses Codex without its matching command host before an Agent starts', async () => {
  const home = await fixture()
  const binary = join(home, '.local/bin/codex')
  await writeFile(binary, 'native', { mode: 0o755 })
  await expect(resolveWorkerHostTools(home, [])).rejects.toThrow('Codex command host is missing')
})

/** A pnpm global install entry behind a hashed alias, with a native shim target file in `bin`. */
async function pnpmGlobalInstall(home: string, input: { name: string, manifest: object, target: string }) {
  const pnpmHome = join(home, '.local/share/pnpm')
  const install = join(pnpmHome, `global/v11/${input.name}-install`)
  const installed = join(pnpmHome, `store/v11/links/@/${input.name}/1.0.0/fixture/node_modules/${input.name}`)
  await mkdir(join(installed, 'bin'), { recursive: true })
  await mkdir(join(install, 'node_modules'), { recursive: true })
  await mkdir(join(pnpmHome, 'bin'), { recursive: true })
  await writeFile(join(install, 'package.json'), JSON.stringify(input.manifest))
  await writeFile(join(installed, 'bin', input.name), '#!/bin/sh\n', { mode: 0o755 })
  await symlink(installed, join(install, 'node_modules', input.name))
  await symlink(`${input.name}-install`, join(pnpmHome, `global/v11/${input.name}-alias`))
  await writeFile(join(pnpmHome, 'bin', `.pnpm-shim-v1-${input.name}-target`), input.target)
  return { shims: join(pnpmHome, 'bin'), alias: join(pnpmHome, `global/v11/${input.name}-alias`), installed }
}

it('finds the runtime package a pnpm native shim runs, at the path the shim names', async () => {
  const home = await fixture()
  const alias = join(home, '.local/share/pnpm/global/v11/node-alias')
  const { shims } = await pnpmGlobalInstall(home, { name: 'node', manifest: { engines: { runtime: { name: 'node', version: '1.0.0' } } }, target: join(alias, 'node_modules/node/bin/node') })

  expect(await resolvePnpmRuntimePackages([shims, join(home, '.local/bin')])).toEqual([join(alias, 'node_modules/node')])
})

it('ignores pnpm shim targets that are not an installed pnpm runtime', async () => {
  const home = await fixture()
  const pnpmHome = join(home, '.local/share/pnpm')
  // An ordinary global package, not a runtime install.
  const { shims } = await pnpmGlobalInstall(home, { name: 'npm', manifest: { dependencies: { npm: '1.0.0' } }, target: join(pnpmHome, 'global/v11/npm-alias/node_modules/npm/bin/npm-cli.js') })
  // A runtime install that pnpm has since removed.
  const removed = await pnpmGlobalInstall(home, { name: 'bun', manifest: { engines: { runtime: { name: 'bun', version: '1.0.0' } } }, target: join(pnpmHome, 'global/v11/bun-alias/node_modules/bun/bin/bun') })
  await rm(removed.installed, { recursive: true })
  // A target outside pnpm's global directory.
  await writeFile(join(shims, '.pnpm-shim-v1-node-target'), '/usr/bin/node')
  // A directory without shim targets, as on a host with an older pnpm.
  await writeFile(join(home, '.local/bin/pnpm'), '#!/bin/sh\n', { mode: 0o755 })

  expect(await resolvePnpmRuntimePackages([shims, join(home, '.local/bin'), join(home, 'missing')])).toEqual([])
})
