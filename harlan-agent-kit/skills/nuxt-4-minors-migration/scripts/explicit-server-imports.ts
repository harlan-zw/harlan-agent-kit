// Turn Nitro server auto-imports into explicit imports.
//
//   node --experimental-strip-types explicit-server-imports.ts --root <nuxt app> [--server-dir server] [--shared-dir shared] [--write] [--json]
//
// Dry run by default. Read the skill's server-imports reference before running it.
import type * as TS from 'typescript'
import type { AutoImport, FileEdit, ResolveContext } from './server-imports.ts'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { addExplicitImports, findExportSubpath, parseExportNames, parseNitroImports, parseServerAliases, resolveSpecifier } from './server-imports.ts'

export interface RunOptions {
  root: string
  serverDirs: string[]
  sharedDirs: string[]
  write: boolean
}

export interface FileReport {
  file: string
  added: FileEdit['added']
  kept: FileEdit['kept']
  unmapped: FileEdit['unmapped']
  portable: boolean
}

export type RunResult
  = | { _tag: 'Ok', scanned: number, files: FileReport[] }
    | { _tag: 'Err', message: string }

const SOURCE_FILE = /\.(?:ts|mts|cts|js|mjs)$/
const DECLARATION_FILE = /\.d\.[cm]?ts$/

export function run(options: RunOptions, ts: typeof TS): RunResult {
  const buildDir = join(options.root, '.nuxt')
  const dtsPath = join(buildDir, 'types', 'nitro-imports.d.ts')
  const tsconfigPath = join(buildDir, 'tsconfig.server.json')
  if (!existsSync(dtsPath) || !existsSync(tsconfigPath))
    return { _tag: 'Err', message: `${relative(process.cwd(), buildDir)} has no server types. Run \`nuxt prepare\` in ${options.root}, then run this script again.` }

  const dts = readFileSync(dtsPath, 'utf8')
  const entries = parseNitroImports(dts, join(buildDir, 'types'))
  if (!entries.length)
    return { _tag: 'Err', message: 'The server auto-import list is empty. Set `experimental.nitroAutoImports: true` in nuxt.config, run `nuxt prepare`, then run this script again.' }

  const nitroRuntimeExports = readNitroRuntimeExports(dts, join(buildDir, 'types'))
  if (!nitroRuntimeExports && entries.some(entry => entry.from.startsWith('nitropack/')))
    return { _tag: 'Err', message: `${relative(process.cwd(), buildDir)} points at a nitropack install that does not exist. Install dependencies and run \`nuxt prepare\`, then run this script again.` }
  const context: ResolveContext = {
    aliases: parseServerAliases(JSON.parse(readFileSync(tsconfigPath, 'utf8')), buildDir, resolve(options.root)),
    nitroRuntimeExports: nitroRuntimeExports ?? new Set(),
    packageSubpath: packageSubpathReader(),
  }
  const sharedRoots = options.sharedDirs.map(dir => resolve(options.root, dir))
  const sharedEntries = entries.filter(entry => sharedRoots.some(root => entry.from.startsWith(`${root}${sep}`)))

  const files: FileReport[] = []
  let scanned = 0
  const groups: Array<{ dirs: string[], entries: AutoImport[] }> = [
    { dirs: options.serverDirs, entries },
    // Shared code runs in the app too, so it may only import other shared code.
    { dirs: options.sharedDirs, entries: sharedEntries },
  ]
  for (const group of groups) {
    for (const file of group.dirs.flatMap(dir => listSourceFiles(resolve(options.root, dir)))) {
      scanned++
      const code = readFileSync(file, 'utf8')
      const edit = addExplicitImports(ts, code, file, group.entries, entry => resolveSpecifier(entry, file, context))
      if (!edit.added.length && !edit.kept.length && !edit.unmapped.length)
        continue
      if (options.write && edit.code !== code)
        writeFileSync(file, edit.code)
      files.push({ file: relative(options.root, file), added: edit.added, kept: edit.kept, unmapped: edit.unmapped, portable: edit.portable })
    }
  }
  return { _tag: 'Ok', scanned, files }
}

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir))
    return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && SOURCE_FILE.test(entry.name) && !DECLARATION_FILE.test(entry.name))
    .map(entry => join(entry.parentPath, entry.name))
    .filter(path => !path.split(sep).includes('node_modules'))
    .sort()
}

/** Read each package's `exports` once, from the package that owns the file. */
function packageSubpathReader(): ResolveContext['packageSubpath'] {
  const manifests = new Map<string, { name?: string, exports?: unknown } | undefined>()
  return (file) => {
    const at = file.lastIndexOf('/node_modules/')
    const segments = file.slice(at + '/node_modules/'.length).split('/')
    const name = segments[0]?.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
    if (at < 0 || !name)
      return undefined
    const pkgRoot = `${file.slice(0, at)}/node_modules/${name}`
    if (!manifests.has(pkgRoot)) {
      const manifest = join(pkgRoot, 'package.json')
      manifests.set(pkgRoot, existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : undefined)
    }
    const pkg = manifests.get(pkgRoot)
    return pkg && findExportSubpath(pkg, pkgRoot, file)
  }
}

/**
 * Find nitropack's public runtime exports. The declaration file names the
 * installed nitropack directory, so no module resolution is needed.
 */
function readNitroRuntimeExports(dts: string, typesDir: string): Set<string> | undefined {
  const match = dts.match(/typeof import\('([^']*\/node_modules\/nitropack)\/dist\/runtime\//)
  if (!match?.[1])
    return undefined
  const index = join(resolve(typesDir, match[1]), 'dist', 'runtime', 'index.d.ts')
  return existsSync(index) ? parseExportNames(readFileSync(index, 'utf8')) : undefined
}

function summarize(result: Extract<RunResult, { _tag: 'Ok' }>, write: boolean): string {
  const changed = result.files.filter(file => file.added.length)
  const unmapped = result.files.flatMap(file => file.unmapped.map(item => `  ${file.file}: ${item.as} (${item.reason})`))
  const portable = result.files.filter(file => file.portable).map(file => `  ${file.file}`)
  const keptCounts = new Map<string, number>()
  for (const item of result.files.flatMap(file => file.kept))
    keptCounts.set(item.as, (keptCounts.get(item.as) ?? 0) + 1)
  const kept = [...keptCounts].sort((a, b) => b[1] - a[1]).map(([name, count]) => `  ${name} (${count} files)`)
  const bySpecifier = new Map<string, number>()
  for (const file of changed) {
    for (const item of file.added)
      bySpecifier.set(item.specifier, (bySpecifier.get(item.specifier) ?? 0) + 1)
  }
  const lines = [
    `${write ? 'Changed' : 'Would change'} ${changed.length} of ${result.scanned} files.`,
    ...[...bySpecifier].sort((a, b) => b[1] - a[1]).map(([specifier, count]) => `  ${count} from ${specifier}`),
  ]
  if (unmapped.length)
    lines.push('', `Unmapped auto-imports (${unmapped.length}). Import these by hand:`, ...unmapped)
  if (kept.length)
    lines.push('', `Left as auto-imports (${kept.length} names). A module registers these with no public path. Read the server imports reference before you ship them:`, ...kept)
  if (portable.length)
    lines.push('', `Portable to nuxt/server (${portable.length}). Every server helper here behaves the same there:`, ...portable)
  if (!write && changed.length)
    lines.push('', 'Dry run. Pass --write to apply.')
  return lines.join('\n')
}

function main(): void {
  const { values } = parseArgs({
    options: {
      'root': { type: 'string', default: process.cwd() },
      'server-dir': { type: 'string', multiple: true },
      'shared-dir': { type: 'string', multiple: true },
      'write': { type: 'boolean', default: false },
      'json': { type: 'boolean', default: false },
    },
  })
  const root = resolve(values.root)
  const requireFromRoot = createRequire(join(root, 'package.json'))
  // The project's own TypeScript parses its files, so syntax support matches its typecheck.
  const ts = requireFromRoot('typescript') as typeof TS
  const result = run({
    root,
    serverDirs: values['server-dir'] ?? ['server'],
    sharedDirs: values['shared-dir'] ?? ['shared'],
    write: values.write,
  }, ts)
  if (result._tag === 'Err') {
    console.error(result.message)
    process.exit(2)
  }
  console.log(values.json ? JSON.stringify(result, null, 2) : summarize(result, values.write))
  if (result.files.some(file => file.unmapped.length))
    process.exitCode = 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main()
