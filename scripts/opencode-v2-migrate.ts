#!/usr/bin/env -S node --experimental-strip-types
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Convert the host configuration fields used by desktop and Hogwild. */
export function migrateOpencodeConfiguration(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new Error('The OpenCode configuration must contain an object.')
  const result: Record<string, unknown> = { ...value }
  delete result.$schema
  if (value.provider !== undefined) {
    if (!record(value.provider)) throw new Error('The OpenCode providers must contain an object.')
    result.providers = Object.fromEntries(
      Object.entries(value.provider).map(([id, entry]) => {
        if (!record(entry) || !record(entry.options) || Object.keys(entry).some((key) => key !== 'options'))
          throw new Error('Convert custom OpenCode providers before migrating this host.')
        return [id, { settings: entry.options }]
      }),
    )
    delete result.provider
  }
  if (value.small_model !== undefined) {
    if (typeof value.small_model !== 'string') throw new Error('The OpenCode title model must contain a string.')
    result.agents = { ...(record(value.agents) ? value.agents : {}), title: { model: value.small_model } }
    delete result.small_model
  }
  if (value.mcp !== undefined) {
    if (!record(value.mcp)) throw new Error('The OpenCode MCP configuration must contain an object.')
    if (!('servers' in value.mcp)) {
      result.mcp = {
        servers: Object.fromEntries(
          Object.entries(value.mcp).map(([id, entry]) => {
            if (!record(entry) || (entry.type !== 'local' && entry.type !== 'remote'))
              throw new Error('The OpenCode MCP server requires its type.')
            const server = { ...entry }
            if (entry.enabled !== undefined) {
              server.disabled = !entry.enabled
              delete server.enabled
            }
            if (typeof entry.timeout === 'number') server.timeout = { catalog: entry.timeout, execution: entry.timeout }
            return [id, server]
          }),
        ),
      }
    }
  }
  return result
}

async function main() {
  const workerOnly = process.argv[2] === '--worker'
  const home = resolve(workerOnly ? process.env.HOME! : (process.argv[2] ?? process.env.HOME!))
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const configuration = join(home, '.config/opencode')
  if (workerOnly) {
    const profile = await readFile(join(home, '.config/wolfstar-github-agent/worker.json'), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      },
    )
    if (profile === undefined) return
    const { home: worker } = JSON.parse(profile) as { home: string }
    const configured = JSON.parse(await readFile(join(configuration, 'opencode.json'), 'utf8')) as Record<
      string,
      unknown
    >
    if (!record(configured.providers))
      throw new Error('Migrate the host OpenCode configuration before updating its workers.')
    const providers: Record<string, unknown> = {}
    for (const id of ['zai-coding-plan', 'opencode-go']) {
      const entry = configured.providers[id]
      if (record(entry) && record(entry.settings) && typeof entry.settings.apiKey === 'string')
        providers[id] = { settings: { apiKey: entry.settings.apiKey } }
    }
    await mkdir(join(worker, '.config/opencode/plugins'), { recursive: true, mode: 0o700 })
    await copyFile(
      join(root, 'wolfstar-agent-kit/plugins/opencode/wolfstar-hooks.ts'),
      join(worker, '.config/opencode/plugins/wolfstar-hooks.ts'),
    )
    const workerConfiguration = join(worker, '.config/opencode/opencode.json')
    await writeFile(workerConfiguration, JSON.stringify({ providers, plugins: ['./plugins/wolfstar-hooks.ts'] }), {
      mode: 0o600,
    })
    await chmod(workerConfiguration, 0o600)
    process.stdout.write('OpenCode V2 worker configuration refreshed.\n')
    return
  }
  const backup = join(home, 'scratch/opencode-v2', `backup-${Date.now()}`)
  await mkdir(backup, { recursive: true, mode: 0o700 })
  const staged: Array<{ path: string; contents: string }> = []
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const path = join(configuration, name)
    const contents = await readFile(path, 'utf8')
    staged.push({ path, contents: `${JSON.stringify(migrateOpencodeConfiguration(JSON.parse(contents)), null, 2)}\n` })
    await writeFile(join(backup, name), contents, { mode: 0o600 })
  }
  // Explicit settings keep named API keys available in every fresh isolated Task database.
  const auth = JSON.parse(await readFile(join(home, '.local/share/opencode/auth.json'), 'utf8')) as Record<
    string,
    { type?: string; key?: string }
  >
  const primary = staged[0]!
  const parsed = JSON.parse(primary.contents) as { providers?: Record<string, unknown> }
  const go = auth['opencode-go']
  if (go?.type === 'api' && typeof go.key === 'string')
    parsed.providers = { ...parsed.providers, 'opencode-go': { settings: { apiKey: go.key } } }
  primary.contents = `${JSON.stringify(parsed, null, 2)}\n`
  const plugins = join(configuration, 'plugins')
  for (const name of ['wolfstar-hooks.ts', 'worktrunk.ts']) {
    await copyFile(join(plugins, name), join(backup, name))
    await copyFile(join(root, 'wolfstar-agent-kit/plugins/opencode', name), join(plugins, name))
  }
  const configured = JSON.parse(primary.contents) as Record<string, unknown>
  configured.plugins = [
    ...new Set([
      ...(Array.isArray(configured.plugins) ? configured.plugins : []),
      join(plugins, 'wolfstar-hooks.ts'),
      join(plugins, 'worktrunk.ts'),
    ]),
  ]
  primary.contents = `${JSON.stringify(configured, null, 2)}\n`
  for (const entry of staged) {
    await writeFile(entry.path, entry.contents, { mode: 0o600 })
    await chmod(entry.path, 0o600)
  }
  const instructions = join(configuration, 'AGENTS.md')
  const exists = await stat(instructions)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
  if (!exists) await copyFile(join(home, '.codex/AGENTS.md'), instructions)
  process.stdout.write(`OpenCode V2 configuration backup: ${backup}\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
