import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface WorkerPackage {
  root: string
  entry: string
  packages: string[]
  links: Array<{ path: string, target: string }>
}

const packageName = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i
const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`)

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch((cause: NodeJS.ErrnoException) => {
    // Optional packages and host installation locations may be absent.
    if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
      return false
    throw cause
  })
}

/** Resolve an installed pnpm command without mounting its store or global directory. */
export async function resolveWorkerPackage(home: string, command: { name: string, package: string, label: string }): Promise<WorkerPackage | undefined> {
  let target: string | undefined
  for (const directory of ['.local/bin', '.local/share/pnpm/bin', '.local/share/pnpm']) {
    const binary = join(home, directory, command.name)
    if (!await exists(binary))
      continue
    await access(binary, constants.X_OK)
    const shim = await readFile(binary, 'utf8')
    target = /^# cmd-shim-target=(\/[^\r\n]+)$/m.exec(shim)?.[1]
    if (target === undefined)
      throw new Error(`The installed ${command.label} command must use a pnpm package shim.`)
    break
  }
  if (target === undefined)
    return undefined
  let packageRoot = dirname(target)
  while (!await exists(join(packageRoot, 'package.json'))) {
    const parent = dirname(packageRoot)
    if (parent === packageRoot)
      throw new Error(`The installed ${command.label} package manifest is missing.`)
    packageRoot = parent
  }
  packageRoot = await realpath(packageRoot)
  const rootManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name?: string, bin?: Record<string, string> }
  const entry = await realpath(target)
  const bin = rootManifest.bin?.[command.name]
  if (rootManifest.name !== command.package || typeof bin !== 'string'
    || isAbsolute(bin) || !within(entry, packageRoot)
    || await realpath(resolve(packageRoot, bin)) !== entry) {
    throw new Error(`The installed ${command.label} command does not match its package manifest.`)
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
      throw new Error(`The ${command.label} dependency closure exceeds 128 packages.`)
    packages.add(canonical)
    const manifest = JSON.parse(await readFile(join(canonical, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>, optionalDependencies?: Record<string, string> }
    for (const name of new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {})])) {
      if (!packageName.test(name))
        throw new Error(`The ${command.label} dependency name is invalid.`)
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
        throw new Error(`The installed ${command.label} dependency is missing: ${name}`)
    }
  }
  await visit(packageRoot)
  return { root: packageRoot, entry, packages: [...packages], links: [...links].filter(([path]) => ![...packages].some(root => within(path, root))).map(([path, target]) => ({ path, target })) }
}
