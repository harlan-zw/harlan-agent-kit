import { readFileSync } from 'node:fs'
import { satisfies } from 'semver'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const lock = parse(readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')) as {
  importers: Record<string, Record<string, Record<string, { version: string }>>>
  packages: Record<string, { peerDependencies?: Record<string, string> } | undefined>
  snapshots: Record<string, Record<string, Record<string, string>> | undefined>
}
const workspace = parse(readFileSync(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8')) as {
  overrides?: Record<string, string>
}

function bareVersion(version: string): string {
  return version.split('(')[0]
}

function snapshotKey(name: string, version: string): string | null {
  if (version.startsWith('link:') || version.startsWith('file:'))
    return null
  return /^\d/.test(version) ? `${name}@${version}` : version
}

function resolvedViteVersions(importerName: string): string[] {
  const queue: Array<[name: string, version: string]> = []
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, dep] of Object.entries(lock.importers[importerName][group] ?? {}))
      queue.push([name, dep.version])
  }
  const seen = new Set<string>()
  const viteVersions = new Set<string>()
  while (queue.length > 0) {
    const [name, version] = queue.pop()!
    if (name === 'vite')
      viteVersions.add(bareVersion(version))
    const key = snapshotKey(name, version)
    if (!key || seen.has(key))
      continue
    seen.add(key)
    const snapshot = lock.snapshots[key]
    expect(snapshot, `pnpm-lock.yaml has no snapshot for ${key}`).toBeTruthy()
    for (const group of ['dependencies', 'optionalDependencies']) {
      for (const [depName, depVersion] of Object.entries(snapshot![group] ?? {}))
        queue.push([depName, depVersion])
    }
  }
  return [...viteVersions]
}

function viteMajors(versions: string[]): Set<string> {
  return new Set(versions.map(version => version.split('.')[0]))
}

it('harlan-github-agent resolves a single vite major', () => {
  const versions = resolvedViteVersions('packages/harlan-github-agent')
  expect(viteMajors(versions), `harlan-github-agent resolves vite ${versions.join(', ')}`).toHaveLength(1)
})

it('every recorded vite peer instance satisfies its recorded peer range', () => {
  const violations: string[] = []
  for (const [key] of Object.entries(lock.snapshots)) {
    const resolved = key.match(/\(vite@(\d+\.\d+\.\d+)/)
    if (!resolved)
      continue
    const withoutPeers = key.indexOf('(')
    const entry = lock.packages[withoutPeers === -1 ? key : key.slice(0, withoutPeers)]
    const range = entry?.peerDependencies?.vite
    if (!range)
      continue
    if (!satisfies(resolved[1], range, { includePrerelease: true }))
      violations.push(`${key}: peer vite ${resolved[1]} does not satisfy recorded range ${range}`)
  }
  expect(violations, `${violations.length} unsatisfied vite peers`).toEqual([])
})

it('notes-viewer resolves one vite major that satisfies the declared vitepress range', () => {
  const declared = workspace.overrides?.['vitepress>vite']
  const versions = resolvedViteVersions('packages/notes-viewer')
  expect(
    viteMajors(versions),
    `notes-viewer resolves vite ${versions.join(', ')}`,
  ).toHaveLength(1)
  expect(
    declared,
    'vitepress declares vite ^5.4.14, which has no patched release, so pnpm-workspace.yaml must declare the forced vitepress>vite range',
  ).toBeTypeOf('string')
  for (const version of versions)
    expect(satisfies(version, declared!, { includePrerelease: true }), `vite ${version} does not satisfy declared ${declared}`).toBe(true)
})
