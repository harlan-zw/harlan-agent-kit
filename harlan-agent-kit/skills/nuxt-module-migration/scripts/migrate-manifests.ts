import { execFileSync } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const nuxtRange = '^4.6.0 || ^5.0.0'
export const nodeRange = '^22.22.3 || ^24.15.0 || >=26.0.0'

type JsonObject = Record<string, unknown>

function object(value: unknown, name: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be a JSON object.`)
  return value as JsonObject
}

function section(manifest: JsonObject, name: string): JsonObject {
  return manifest[name] === undefined ? {} : object(manifest[name], name)
}

/** Update a published Nuxt module's support contract without selecting its release version. */
export function migrateManifest(input: unknown): { manifest: JsonObject, warnings: string[] } {
  const source = object(input, 'Manifest')
  const manifest = structuredClone(source)
  const peers = section(manifest, 'peerDependencies')
  if (manifest.private === true || typeof peers.nuxt !== 'string')
    throw new Error('Select a published module with an existing Nuxt peer dependency.')
  peers.nuxt = nuxtRange
  if (peers['@nuxt/schema'] !== undefined)
    peers['@nuxt/schema'] = nuxtRange
  manifest.peerDependencies = peers
  manifest.engines = { ...section(manifest, 'engines'), node: nodeRange }

  const dependencies = section(manifest, 'dependencies')
  const devDependencies = section(manifest, 'devDependencies')
  const currentKit = dependencies['@nuxt/kit'] ?? devDependencies['@nuxt/kit']
  const warnings: string[] = []
  if (typeof currentKit === 'string' && currentKit.startsWith('catalog:')) {
    dependencies['@nuxt/kit'] = currentKit
    warnings.push('Set the referenced Kit catalog to ^4.6.0 before installing.')
  }
  else {
    dependencies['@nuxt/kit'] = '^4.6.0'
  }
  delete devDependencies['@nuxt/kit']
  manifest.dependencies = dependencies
  if (manifest.devDependencies !== undefined)
    manifest.devDependencies = devDependencies
  return { manifest, warnings }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { apply: { type: 'boolean', default: false } },
  })
  if (positionals.length !== 1)
    throw new Error('Pass one package.json path. Add --apply to write the reviewed change.')
  const file = resolve(positionals[0]!)
  const previous = await readFile(file, 'utf8')
  const { manifest, warnings } = migrateManifest(JSON.parse(previous))
  const next = `${JSON.stringify(manifest, null, 2)}\n`
  for (const warning of warnings)
    process.stderr.write(`${warning}\n`)
  if (!values.apply) {
    process.stdout.write(next)
    return
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(file), encoding: 'utf8' }).trim()
  const common = resolve(dirname(file), execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: dirname(file), encoding: 'utf8' }).trim())
  if (dirname(common) === root)
    throw new Error('Create a task-owned Worktree before applying the change.')
  if (next === previous)
    return
  const temporary = `${file}.nuxt-migration-${process.pid}`
  await writeFile(temporary, next, { flag: 'wx' })
  await rename(temporary, file)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main()
