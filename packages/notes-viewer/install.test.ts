import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { satisfies } from 'semver'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const run = promisify(execFile)
const packageDir = fileURLToPath(new URL('.', import.meta.url))

function resolvedViteVersions(lock: {
  packages?: Record<string, unknown>
  snapshots?: Record<string, unknown>
}): string[] {
  const versions = new Set<string>()
  for (const section of [lock.packages, lock.snapshots]) {
    for (const key of Object.keys(section ?? {})) {
      const match = key.match(/(?:^|\()vite@(\d+\.\d+\.\d+)/)
      if (match)
        versions.add(match[1])
    }
  }
  return [...versions]
}

it('the staged install dir resolves vite through the workspace override', async () => {
  const staged = mkdtempSync(join(tmpdir(), 'notes-viewer-install-'))
  try {
    await run('node', [join(packageDir, 'stage-install.mjs'), packageDir, staged])
    await run('pnpm', ['install', '--lockfile-only'], { cwd: staged })
    const lock = parse(readFileSync(join(staged, 'pnpm-lock.yaml'), 'utf8'))
    const workspace = parse(readFileSync(join(packageDir, '../../pnpm-workspace.yaml'), 'utf8'))
    const override = workspace.overrides['vitepress>vite']
    const versions = resolvedViteVersions(lock)
    expect(
      versions.length > 0,
      `staged install resolved no vite package: ${JSON.stringify(Object.keys(lock.packages ?? {}))}`,
    ).toBe(true)
    for (const version of versions) {
      expect(
        satisfies(version, override, { includePrerelease: true }),
        `staged install resolved vite ${version}, which does not satisfy the vitepress>vite override ${override}`,
      ).toBe(true)
    }
  }
  finally {
    rmSync(staged, { recursive: true, force: true })
  }
}, 300_000)
