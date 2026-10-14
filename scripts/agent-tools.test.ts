import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentToolRelease, managedTools, syncAgentTool } from './agent-tools.ts'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agent-tools-test-'))
  roots.push(home)
  const directory = join(home, 'archive/bin')
  mkdirSync(directory, { recursive: true })
  copyFileSync('/usr/bin/true', join(directory, 'gh'))
  const archive = join(home, 'gh.tar.gz')
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', join(home, 'archive'), 'bin/gh'])
  const bytes = readFileSync(archive)
  const asset = {
    name: 'gh_2.102.0_linux_amd64.tar.gz',
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    browser_download_url: 'https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_linux_amd64.tar.gz',
  }
  const release = { tag_name: 'v2.102.0', prerelease: false, draft: false, assets: [asset] }
  return { home, bytes, asset, release, tool: managedTools[0], arch: 'x64', download: async () => bytes }
}

it('installs a verified executable and skips its unchanged release', async () => {
  const f = fixture()
  expect(await syncAgentTool(f)).toBe('Updated')
  const binary = join(f.home, '.local/share/wolfstar-agent-kit/tools/bin/gh')
  expect(execFileSync(binary, ['--version'], { encoding: 'utf8' })).toContain('GNU coreutils')
  expect(
    await syncAgentTool({
      ...f,
      download: async () => {
        throw new Error('Unexpected download')
      },
    }),
  ).toBe('Current')
})

it('preserves the installed executable when an archive checksum differs', async () => {
  const f = fixture()
  await syncAgentTool(f)
  const binary = join(f.home, '.local/share/wolfstar-agent-kit/tools/bin/gh')
  const release = { ...f.release, assets: [{ ...f.asset, digest: `sha256:${'a'.repeat(64)}` }] }
  await expect(syncAgentTool({ ...f, release })).rejects.toThrow('checksum differs')
  expect(execFileSync(binary, ['--version'], { encoding: 'utf8' })).toContain('GNU coreutils')
})

it.each([
  { prerelease: true },
  { draft: true },
  { tag_name: '../unsafe' },
  { assets: [{ name: 'gh_2.102.0_linux_amd64.tar.gz', digest: null }] },
])('refuses unsafe release metadata: %j', (change) => {
  const f = fixture()
  expect(() => agentToolRelease({ ...f.release, ...change }, f.tool, 'x64')).toThrow()
})

it('refuses downloads outside the official repository', () => {
  const f = fixture()
  expect(() =>
    agentToolRelease(
      { ...f.release, assets: [{ ...f.asset, browser_download_url: 'https://example.com/archive' }] },
      f.tool,
      'x64',
    ),
  ).toThrow()
})

it('refuses script installers inside an otherwise verified archive', async () => {
  const f = fixture()
  writeFileSync(join(f.home, 'archive/bin/gh'), '#!/bin/sh\nexit 0\n')
  execFileSync('/usr/bin/tar', ['-czf', join(f.home, 'gh.tar.gz'), '-C', join(f.home, 'archive'), 'bin/gh'])
  const bytes = readFileSync(join(f.home, 'gh.tar.gz'))
  const release = {
    ...f.release,
    assets: [{ ...f.asset, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }],
  }
  await expect(syncAgentTool({ ...f, release, download: async () => bytes })).rejects.toThrow('native executable')
})

it('installs Codex and its command host from one verified package', async () => {
  const f = fixture()
  const name = 'codex-package-x86_64-unknown-linux-musl'
  copyFileSync('/usr/bin/true', join(f.home, 'archive/bin/codex'))
  copyFileSync('/usr/bin/true', join(f.home, 'archive/bin/codex-code-mode-host'))
  execFileSync('/usr/bin/tar', ['-czf', join(f.home, 'codex.tar.gz'), '-C', join(f.home, 'archive'), 'bin'])
  const bytes = readFileSync(join(f.home, 'codex.tar.gz'))
  const release = {
    tag_name: 'rust-v0.162.1',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: `${name}.tar.gz`,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        browser_download_url: `https://github.com/openai/codex/releases/download/rust-v0.162.1/${name}.tar.gz`,
      },
    ],
  }
  expect(await syncAgentTool({ ...f, tool: managedTools[1], release, download: async () => bytes })).toBe('Updated')
  expect(
    execFileSync(join(f.home, '.local/share/wolfstar-agent-kit/tools/bin/codex'), ['--version'], { encoding: 'utf8' }),
  ).toContain('GNU coreutils')
  const host = join(f.home, '.local/share/wolfstar-agent-kit/tools/bin/codex-code-mode-host')
  expect(execFileSync(host, ['--version'], { encoding: 'utf8' })).toContain('GNU coreutils')
  const firstBinary = realpathSync(join(f.home, '.local/share/wolfstar-agent-kit/tools/bin/codex'))
  expect(
    await syncAgentTool({
      ...f,
      tool: managedTools[1],
      release,
      download: async () => {
        throw new Error('Unexpected download')
      },
    }),
  ).toBe('Current')
  rmSync(host)
  expect(await syncAgentTool({ ...f, tool: managedTools[1], release, download: async () => bytes })).toBe('Updated')
  expect(execFileSync(host, ['--version'], { encoding: 'utf8' })).toContain('GNU coreutils')
  expect(execFileSync(firstBinary, ['--version'], { encoding: 'utf8' })).toContain('GNU coreutils')
  rmSync(host)
  expect(await syncAgentTool({ ...f, tool: managedTools[1], release, download: async () => bytes })).toBe('Updated')
  expect(() => statSync(firstBinary)).toThrow(expect.objectContaining({ code: 'ENOENT' }))
  writeFileSync(join(f.home, 'archive/bin/codex-code-mode-host'), '#!/bin/sh\nexit 0\n')
  execFileSync('/usr/bin/tar', ['-czf', join(f.home, 'codex.tar.gz'), '-C', join(f.home, 'archive'), 'bin'])
  const unsafeBytes = readFileSync(join(f.home, 'codex.tar.gz'))
  const unsafeRelease = {
    ...release,
    assets: [{ ...release.assets[0], digest: `sha256:${createHash('sha256').update(unsafeBytes).digest('hex')}` }],
  }
  await expect(
    syncAgentTool({ ...f, tool: managedTools[1], release: unsafeRelease, download: async () => unsafeBytes }),
  ).rejects.toThrow('native executable')
  expect(execFileSync(host, ['--version'], { encoding: 'utf8' })).toContain('GNU coreutils')
})

it('installs OpenCode V2 from its integrity checked npm archive', async () => {
  const f = fixture()
  copyFileSync('/usr/bin/true', join(f.home, 'archive/bin/opencode'))
  execFileSync('/usr/bin/tar', ['-czf', join(f.home, 'opencode.tgz'), '-C', join(f.home, 'archive'), 'bin/opencode'])
  const bytes = readFileSync(join(f.home, 'opencode.tgz'))
  const release = {
    name: '@opencode/cli-linux-x64-baseline',
    version: '2.0.27',
    dist: {
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      tarball: 'https://registry.npmjs.org/@opencode/cli-linux-x64-baseline/-/cli-linux-x64-baseline-2.0.27.tgz',
    },
  }
  expect(await syncAgentTool({ ...f, tool: managedTools[2], release, download: async () => bytes })).toBe('Updated')
  expect(
    execFileSync(join(f.home, '.local/share/wolfstar-agent-kit/tools/bin/opencode'), ['--version'], {
      encoding: 'utf8',
    }),
  ).toContain('GNU coreutils')
  await expect(
    syncAgentTool({
      ...f,
      tool: managedTools[2],
      release: { ...release, version: '1.19.0' },
      download: async () => bytes,
    }),
  ).rejects.toThrow('V2')
  await expect(
    syncAgentTool({
      ...f,
      tool: managedTools[2],
      release: { ...release, dist: { ...release.dist, integrity: `sha512-${Buffer.alloc(64).toString('base64')}` } },
      download: async () => bytes,
    }),
  ).rejects.toThrow('checksum differs')
})
