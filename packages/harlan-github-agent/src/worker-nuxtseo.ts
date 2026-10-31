import { constants } from 'node:fs'
import { access, open, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseEnvironmentFile } from './workspace-environment.ts'

export interface WorkerNuxtseo {
  entry: string
  packages: string[]
  links: Array<{ path: string, target: string }>
  skills: string
}

const packageName = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

async function privateText(path: string): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((cause: NodeJS.ErrnoException) => {
    // A host without shared NuxtSEO configuration keeps repository credentials.
    if (cause.code === 'ENOENT')
      return undefined
    throw cause
  })
  if (file === undefined)
    return undefined
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.size > 64 * 1024 || (metadata.mode & 0o077) !== 0
      || metadata.uid !== process.getuid?.() || await realpath(`/proc/self/fd/${file.fd}`) !== path) {
      throw new Error('The NuxtSEO credential source must be private, bounded, and owned by this account.')
    }
    return await file.readFile('utf8')
  }
  finally {
    await file.close()
  }
}

/** Share only the configured NuxtSEO token with explicitly selected repository scans. */
export async function workerNuxtseoEnvironment(input: { configurationPath: string, repository: string | undefined, taskId: string | undefined }): Promise<Record<string, string>> {
  const task = /^([^:]+):(seo-review|vitals-review):/.exec(input.taskId ?? '')
  if (task === null)
    return {}
  if (task[1] !== input.repository)
    throw new Error('The NuxtSEO Routine repository does not match its Worktree origin.')
  const text = await privateText(input.configurationPath)
  if (text === undefined)
    return {}
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Write a NuxtSEO worker configuration object.')
  const source = value as Record<string, unknown>
  if (typeof source.environmentFile !== 'string' || !isAbsolute(source.environmentFile)
    || !Array.isArray(source.repositories) || source.repositories.length === 0
    || !source.repositories.every(repository => typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository))) {
    throw new Error('Configure an absolute NuxtSEO environment file and explicit repositories.')
  }
  if (!source.repositories.includes(input.repository))
    return {}
  const environment = await privateText(source.environmentFile)
  if (environment === undefined)
    throw new Error('The configured NuxtSEO environment file is missing.')
  const token = parseEnvironmentFile(environment).NUXTSEO_TOKEN
  if (!token)
    throw new Error('The configured NuxtSEO environment file has no token.')
  return { NUXTSEO_TOKEN: token }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch((cause: NodeJS.ErrnoException) => {
    // Optional packages and host installation locations may be absent.
    if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
      return false
    throw cause
  })
}

/** Resolve only the installed NuxtSEO package and its declared dependency closure. */
export async function resolveWorkerNuxtseo(home: string): Promise<WorkerNuxtseo> {
  let target: string | undefined
  for (const directory of ['.local/bin', '.local/share/pnpm/bin', '.local/share/pnpm']) {
    const binary = join(home, directory, 'nuxtseo')
    if (!await exists(binary))
      continue
    await access(binary, constants.X_OK)
    const shim = await readFile(binary, 'utf8')
    target = /^# cmd-shim-target=(\/[^\r\n]+)$/m.exec(shim)?.[1]
    if (target === undefined)
      throw new Error('The installed NuxtSEO command must use a pnpm package shim.')
    break
  }
  if (target === undefined)
    throw new Error('The NuxtSEO Routine requires the installed NuxtSEO CLI.')
  let packageRoot = dirname(target)
  while (!await exists(join(packageRoot, 'package.json'))) {
    const parent = dirname(packageRoot)
    if (parent === packageRoot)
      throw new Error('The installed NuxtSEO package manifest is missing.')
    packageRoot = parent
  }
  packageRoot = await realpath(packageRoot)
  const rootManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name?: string, bin?: { nuxtseo?: string } }
  const entry = await realpath(target)
  if (rootManifest.name !== '@nuxtseo/cli' || typeof rootManifest.bin?.nuxtseo !== 'string'
    || isAbsolute(rootManifest.bin.nuxtseo) || !within(entry, packageRoot)
    || await realpath(resolve(packageRoot, rootManifest.bin.nuxtseo)) !== entry) {
    throw new Error('The installed NuxtSEO command does not match its package manifest.')
  }
  const packages = new Set<string>()
  const links = new Map<string, string>()
  async function visit(path: string): Promise<void> {
    const canonical = await realpath(path)
    if (path !== canonical)
      links.set(path, canonical)
    if (packages.has(canonical))
      return
    if (packages.size >= 128)
      throw new Error('The NuxtSEO dependency closure exceeds 128 packages.')
    packages.add(canonical)
    const manifest = JSON.parse(await readFile(join(canonical, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>, optionalDependencies?: Record<string, string> }
    for (const name of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})])) {
      if (!packageName.test(name))
        throw new Error('The NuxtSEO dependency name is invalid.')
      let ancestor = canonical
      let dependency: string | undefined
      while (true) {
        const candidate = join(ancestor, 'node_modules', name)
        if (await exists(join(candidate, 'package.json'))) {
          dependency = candidate
          break
        }
        const parent = dirname(ancestor)
        if (parent === ancestor)
          break
        ancestor = parent
      }
      if (dependency !== undefined)
        await visit(dependency)
      else if (manifest.optionalDependencies?.[name] === undefined)
        throw new Error(`The installed NuxtSEO dependency is missing: ${name}`)
    }
  }
  await visit(packageRoot)
  const skills = join(packageRoot, 'skills')
  await access(join(skills, 'nuxtseo-cli/SKILL.md'), constants.R_OK)
  return { entry, packages: [...packages], links: [...links].filter(([path]) => ![...packages].some(root => within(path, root))).map(([path, target]) => ({ path, target })), skills }
}
