import type { Result } from '../src/types.ts'
import { execFile } from 'node:child_process'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse, stringify } from 'yaml'
import { err, ok } from '../src/types.ts'

const execute = promisify(execFile)
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const invalid = (message: string): Result<never> => err({ _tag: 'Configuration', message })
const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const
const standaloneVersion = /^(?:\^|~)?\d+\.\d+\.\d+(?:-[\w.-]+)?$/

export function normalizeExportManifest(input: unknown, versions: Record<string, string>, packageManager: string): Result<Record<string, unknown>> {
  const source = object(input)
  if (!source || typeof source.name !== 'string' || typeof source.version !== 'string' || !/^pnpm@\d+\.\d+\.\d+$/.test(packageManager))
    return invalid('Export requires a named package, a version, and an exact pnpm package manager version.')
  const manifest = { ...source }
  for (const section of dependencySections) {
    const input = object(source[section]) ?? {}
    const output: Record<string, string> = {}
    for (const [name, value] of Object.entries(input)) {
      if (typeof value !== 'string' || /^(?:workspace|link|file):/.test(value))
        return invalid(`The standalone package cannot use a local dependency: ${name}.`)
      const version = value.startsWith('catalog:') ? versions[name] : value
      if (typeof version !== 'string' || !standaloneVersion.test(version))
        return invalid(`Export requires an explicit resolved version for ${name}.`)
      output[name] = version
    }
    if (Object.keys(output).length)
      manifest[section] = output
  }
  const devDependencies = { ...object(manifest.devDependencies) }
  for (const name of ['eslint', '@antfu/eslint-config']) {
    const version = versions[name] ?? devDependencies[name]
    if (typeof version !== 'string' || !standaloneVersion.test(version))
      return invalid(`Export requires an explicit resolved version for ${name}.`)
    devDependencies[name] = version
  }
  manifest.devDependencies = devDependencies
  manifest.packageManager = packageManager
  manifest.scripts = { ...object(source.scripts), check: 'pnpm lint && pnpm typecheck && pnpm test:run && pnpm build', export: 'node --experimental-strip-types scripts/export.ts' }
  manifest.repository = { type: 'git', url: 'git+https://github.com/harlan-zw/octorun.git' }
  manifest.publishConfig = { access: 'public', provenance: true }
  delete manifest.private
  delete manifest.pnpm
  return ok(manifest)
}

export function resolveExportDestination(workspace: string, source: string, destination: string): Result<string> {
  const target = resolve(destination)
  const inside = (root: string) => {
    const path = relative(resolve(root), target)
    return path === '' || (!path.startsWith('..') && !isAbsolute(path))
  }
  return inside(workspace) || inside(source)
    ? invalid('Export requires a new destination outside the source workspace.')
    : ok(target)
}

export function pruneExportLock(input: unknown, importer: Record<string, unknown>): Result<Record<string, unknown>> {
  const lock = object(input)
  const packages = object(lock?.packages) ?? {}
  const snapshots = object(lock?.snapshots) ?? {}
  const selectedPackages: Record<string, unknown> = {}
  const selectedSnapshots: Record<string, unknown> = {}
  const pending: [string, string][] = []
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, value] of Object.entries(object(importer[section]) ?? {})) {
      const version = object(value)?.version
      if (typeof version !== 'string')
        return invalid(`The source lockfile does not resolve ${name}.`)
      pending.push([name, version])
    }
  }
  while (pending.length) {
    const [name, version] = pending.pop()!
    const key = version.startsWith('npm:') ? version.slice(4) : `${name}@${version}`
    if (selectedSnapshots[key] !== undefined)
      continue
    const snapshot = object(snapshots[key])
    const packageKey = key.split('(')[0]!
    if (!snapshot || packages[packageKey] === undefined)
      return invalid(`The source lockfile has no standalone dependency graph for ${name}.`)
    selectedSnapshots[key] = snapshot
    selectedPackages[packageKey] = packages[packageKey]
    for (const section of ['dependencies', 'optionalDependencies']) {
      for (const [dependency, resolution] of Object.entries(object(snapshot[section]) ?? {})) {
        if (typeof resolution !== 'string' || /^(?:workspace|link|file):/.test(resolution))
          return invalid(`The standalone lockfile cannot use a local dependency: ${dependency}.`)
        pending.push([dependency, resolution])
      }
    }
  }
  return ok({ lockfileVersion: lock?.lockfileVersion ?? '9.0', settings: lock?.settings, importers: { '.': importer }, packages: selectedPackages, snapshots: selectedSnapshots })
}

async function optionalFile(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return null
    throw error
  })
}

async function workspaceRoot(source: string): Promise<string> {
  let root = source
  for (;;) {
    if (await optionalFile(join(root, 'pnpm-workspace.yaml')) !== null)
      return root
    const parent = dirname(root)
    if (parent === root)
      return source
    root = parent
  }
}

const ciWorkflow = `name: Check
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
jobs:
  changes:
    runs-on: ubuntu-24.04
    outputs:
      code: \${{ steps.changes.outputs.code }}
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: 24
      - id: changes
        run: node --experimental-strip-types scripts/ci-changes.ts >> "$GITHUB_OUTPUT"
  check:
    needs: changes
    if: needs.changes.outputs.code == 'true'
    runs-on: ubuntu-24.04
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
`

const releaseWorkflow = `name: Publish
on:
  push:
    tags: ['v*']
permissions:
  contents: read
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-24.04
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org
          package-manager-cache: false
      - run: npm install --global npm@12.0.2
      - run: pnpm install --frozen-lockfile
      - run: node --experimental-strip-types scripts/check-release.ts
      - run: pnpm check
      - run: pnpm pack --out octorun.tgz
      - run: npm publish octorun.tgz --provenance --access public
`

export async function exportOctorun(options: { destination: string, sourceDirectory?: string }): Promise<Result<{ destination: string, files: number, manifest: Record<string, unknown> }>> {
  const source = await realpath(options.sourceDirectory ?? fileURLToPath(new URL('../', import.meta.url)))
  const workspace = await workspaceRoot(source)
  const target = resolveExportDestination(workspace, source, options.destination)
  if (target._tag === 'Err')
    return target
  const existing = await lstat(target.value).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return false
    throw error
  })
  if (existing)
    return invalid('The export destination already exists. Choose a new directory.')
  const sourceManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as unknown
  const rootManifest = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8')) as Record<string, unknown>
  const lockText = await optionalFile(join(workspace, 'pnpm-lock.yaml'))
  if (lockText === null)
    return invalid('Export requires the source lockfile to resolve dependency versions.')
  const lock = object(parse(lockText))
  const importers = object(lock?.importers)
  const importerKey = relative(workspace, source).replaceAll('\\', '/') || '.'
  const importer = object(importers?.[importerKey])
  const rootImporter = object(importers?.['.'])
  const versions: Record<string, string> = {}
  const resolvedDependencies: Record<string, unknown> = {}
  for (const current of [rootImporter, importer]) {
    for (const section of dependencySections) {
      for (const [name, dependency] of Object.entries(object(current?.[section]) ?? {})) {
        const value = object(dependency)
        if (typeof value?.version === 'string') {
          versions[name] = value.version.split('(')[0]!
          resolvedDependencies[name] = value
        }
      }
    }
  }
  const packageManager = typeof rootManifest.packageManager === 'string' ? rootManifest.packageManager : 'pnpm@11.22.0'
  const manifest = normalizeExportManifest(sourceManifest, versions, packageManager)
  if (manifest._tag === 'Err')
    return manifest
  let existingParent = dirname(target.value)
  const missingParts = [basename(target.value)]
  let parent: string | null = null
  while (parent === null) {
    parent = await realpath(existingParent).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        return null
      throw error
    })
    if (parent === null) {
      missingParts.unshift(basename(existingParent))
      existingParent = dirname(existingParent)
    }
  }
  const canonical = resolveExportDestination(workspace, source, join(parent, ...missingParts))
  if (canonical._tag === 'Err')
    return canonical
  await mkdir(dirname(canonical.value), { recursive: true, mode: 0o700 })
  await mkdir(canonical.value, { mode: 0o700 })
  const copy = async (from: string, to: string): Promise<void> => {
    const stat = await lstat(from)
    if (stat.isSymbolicLink())
      throw new Error('Source export refuses symbolic links.')
    if (stat.isDirectory()) {
      await mkdir(to, { recursive: true })
      for (const entry of await readdir(from)) {
        if (!['node_modules', 'dist', '.git', '.data', 'coverage'].includes(entry))
          await copy(join(from, entry), join(to, entry))
      }
    }
    else if (stat.isFile()) {
      await copyFile(from, to)
    }
  }
  const allowed = new Set(['src', 'test', 'examples', 'docs', 'scripts', 'README.md', 'LICENSE.md', 'GLOSSARY.md', 'COPY.md', 'build.config.ts', 'tsconfig.json', 'vitest.config.ts'])
  for (const entry of await readdir(source)) {
    if (allowed.has(entry))
      await copy(join(source, entry), join(canonical.value, entry))
  }
  const outputImport: Record<string, unknown> = {}
  for (const section of dependencySections) {
    if (section === 'peerDependencies')
      continue
    const dependencies = object(manifest.value[section])
    if (!dependencies)
      continue
    outputImport[section] = Object.fromEntries(Object.entries(dependencies).map(([name, version]) => [name, { ...object(resolvedDependencies[name]), specifier: version }]))
  }
  const standaloneLock = pruneExportLock(lock, outputImport)
  if (standaloneLock._tag === 'Err')
    return standaloneLock
  await writeFile(join(canonical.value, 'package.json'), `${JSON.stringify(manifest.value, null, 2)}\n`, { flag: 'wx' })
  await writeFile(join(canonical.value, 'pnpm-lock.yaml'), stringify(standaloneLock.value), { flag: 'wx' })
  await writeFile(join(canonical.value, 'eslint.config.ts'), 'import antfu from \'@antfu/eslint-config\'\n\nexport default antfu({ typescript: true, ignores: [\'dist/**\', \'coverage/**\'] }, { rules: { \'node/prefer-global/process\': \'off\', \'node/prefer-global/buffer\': \'off\', \'ts/no-use-before-define\': \'off\', \'jsonc/sort-keys\': \'off\' } })\n', { flag: 'wx' })
  await writeFile(join(canonical.value, '.gitignore'), 'node_modules\ndist\ncoverage\n*.tgz\n.env\n.data\n', { flag: 'wx' })
  await writeFile(join(canonical.value, 'pnpm-workspace.yaml'), 'minimumReleaseAgeExcludePrune: true\ntrustPolicy: no-downgrade\nshellEmulator: true\n\nallowBuilds:\n  esbuild: false\n', { flag: 'wx' })
  await mkdir(join(canonical.value, '.github', 'workflows'), { recursive: true })
  await mkdir(join(canonical.value, 'scripts'), { recursive: true })
  await copyFile(fileURLToPath(import.meta.url), join(canonical.value, 'scripts', 'export.ts'))
  await writeFile(join(canonical.value, '.github', 'workflows', 'check.yml'), ciWorkflow, { flag: 'wx' })
  await writeFile(join(canonical.value, '.github', 'workflows', 'publish.yml'), releaseWorkflow, { flag: 'wx' })
  await copyFile(fileURLToPath(new URL('./ci-changes.ts', import.meta.url)), join(canonical.value, 'scripts', 'ci-changes.ts'))
  await writeFile(join(canonical.value, 'scripts', 'check-release.ts'), 'import { readFileSync } from \'node:fs\'\n\nconst manifest = JSON.parse(readFileSync(new URL(\'../package.json\', import.meta.url), \'utf8\')) as { version: string }\nif (process.env.GITHUB_REF_NAME !== \'v\'.concat(manifest.version))\n  throw new Error(\'The release tag must match the package version.\')\n')
  const tsconfigText = await optionalFile(join(canonical.value, 'tsconfig.json'))
  if (tsconfigText !== null) {
    const tsconfig = JSON.parse(tsconfigText) as Record<string, unknown>
    tsconfig.include = [...new Set([...(Array.isArray(tsconfig.include) ? tsconfig.include : []), 'scripts'])]
    await writeFile(join(canonical.value, 'tsconfig.json'), `${JSON.stringify(tsconfig, null, 2)}\n`)
  }
  const readme = await optionalFile(join(canonical.value, 'README.md'))
  if (readme !== null)
    await writeFile(join(canonical.value, 'README.md'), readme.replaceAll('pnpm --filter octorun ', 'pnpm ').replaceAll(`pnpm --filter ${String(manifest.value.name)} `, 'pnpm '))
  const glossary = await optionalFile(join(canonical.value, 'GLOSSARY.md'))
  if (glossary !== null)
    await writeFile(join(canonical.value, 'GLOSSARY.md'), glossary.replaceAll('](../harlan-github-agent/GLOSSARY.md)', '](https://github.com/harlan-zw/harlan-agent-kit/blob/main/packages/harlan-github-agent/GLOSSARY.md)'))
  await execute('pnpm', ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--prefer-offline'], { cwd: canonical.value, timeout: 180000, maxBuffer: 1024 * 1024 })
  const countFiles = async (path: string): Promise<number> => {
    const entries = await readdir(path, { withFileTypes: true })
    const counts = await Promise.all(entries.filter(entry => entry.name !== 'node_modules').map(entry => entry.isDirectory() ? countFiles(join(path, entry.name)) : Promise.resolve(1)))
    return counts.reduce((sum, count) => sum + count, 0)
  }
  return ok({ destination: canonical.value, files: await countFiles(canonical.value), manifest: manifest.value })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2]
  const sourceDirectory = process.argv[3]
  if (!destination) {
    process.stderr.write('Usage: node scripts/export.ts <new-directory> [source-directory]\n')
    process.exitCode = 1
  }
  else {
    const result = await exportOctorun({ destination, ...(sourceDirectory ? { sourceDirectory } : {}) })
    process.stdout.write(`${JSON.stringify(result)}\n`)
    if (result._tag === 'Err')
      process.exitCode = 1
  }
}
