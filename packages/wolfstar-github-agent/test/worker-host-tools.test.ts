import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { resolveWorkerHostTools } from '../src/worker-host-tools.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
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
  const managed = join(home, '.local/share/wolfstar-agent-kit/tools/bin/gh')
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
  const binary = join(
    packageRoot,
    'vendor',
    `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`,
    'bin/codex',
  )
  await mkdir(dirname(binary), { recursive: true })
  await writeFile(binary, 'native', { mode: 0o755 })
  await writeFile(join(home, '.local/bin/codex'), `#!/bin/sh\n# cmd-shim-target=${packageRoot}/bin/codex.js\n`, {
    mode: 0o755,
  })
  expect((await resolveWorkerHostTools(home, ['/usr/bin'])).codex).toBe(binary)
})
