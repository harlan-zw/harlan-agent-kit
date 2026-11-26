#!/usr/bin/env -S node --experimental-strip-types
import { chmod, cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { PULL_REQUEST_SUMMARY_SKILL, refreshWorkerSkills, WORKER_DIRECT_SKILLS, WORKER_SKILL_STORE } from './worker-skills.ts'

const { values } = parseArgs({ options: {
  'source-home': { type: 'string' },
  'worker-home': { type: 'string' },
  'config': { type: 'string' },
  'codex': { type: 'string' },
  'opencode': { type: 'string' },
  'agy': { type: 'string' },
  'tool-dir': { type: 'string', multiple: true, default: [] },
  'read-only': { type: 'string', multiple: true, default: [] },
} })
for (const key of ['source-home', 'worker-home', 'config', 'codex', 'opencode'] as const) {
  if (!values[key] || !isAbsolute(values[key]))
    throw new Error(`Provide an absolute --${key} path.`)
}
if (values.agy !== undefined && !isAbsolute(values.agy))
  throw new Error('Provide an absolute --agy path.')
const source = resolve(values['source-home']!)
const home = resolve(values['worker-home']!)
await mkdir(home, { recursive: true, mode: 0o700 })
await chmod(home, 0o700)
const managedSkills = join(source, WORKER_SKILL_STORE)
const managedSummary = join(managedSkills, PULL_REQUEST_SUMMARY_SKILL)
const directSummary = join(source, WORKER_DIRECT_SKILLS, PULL_REQUEST_SUMMARY_SKILL)
const summarySource = await lstat(managedSummary).catch((error: NodeJS.ErrnoException) => {
  // A source home can be provisioned before portable Skills are installed.
  if (error.code === 'ENOENT')
    return undefined
  throw error
})
if (summarySource !== undefined) {
  const result = await refreshWorkerSkills({ sourceRoot: managedSkills, workerHome: home, skills: [PULL_REQUEST_SUMMARY_SKILL] })
  if (result._tag === 'Err')
    throw new Error(result.error)
}
const paths = [
  '.codex/auth.json',
  '.local/share/opencode/auth.json',
  '.gemini/antigravity-cli/antigravity-oauth-token',
  '.gemini/antigravity-cli/installation_id',
  '.config/antigravity/plugin-secrets.json',
  '.config/antigravity/credential-user-scope',
  '.config/harlan-agent-kit/github-public-token',
  '.config/git/hooks',
  '.local/share/harlan-agent-kit/github-bin',
  '.codex/AGENTS.md',
  WORKER_SKILL_STORE,
  WORKER_DIRECT_SKILLS,
  '.local/share/harlan-agent-kit/hooks',
  '.local/share/harlan-agent-kit/.claude-plugin/plugin.json',
  '.config/opencode/plugins/harlan-hooks.ts',
]
for (const path of paths) {
  const destination = join(home, path)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await cp(join(source, path), destination, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
    filter: path => summarySource === undefined || (path !== managedSummary && path !== directSummary),
  }).catch((error: NodeJS.ErrnoException) => {
    // A host may use only one provider. Its missing login is not copied.
    if (error.code !== 'ENOENT')
      throw error
  })
  if (path.endsWith('/auth.json') || path.endsWith('/github-public-token') || path.endsWith('/antigravity-oauth-token') || path.endsWith('/plugin-secrets.json')) {
    await chmod(destination, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw error
    })
  }
}
// Prefer the trimmed worker AGENTS.md when context sync has installed it.
const workerInstructions = join(source, '.local/share/harlan-agent-kit/worker.md')
await cp(workerInstructions, join(home, '.codex/AGENTS.md'), { dereference: true, preserveTimestamps: true }).catch((error: NodeJS.ErrnoException) => {
  if (error.code !== 'ENOENT')
    throw error
})
// Keep Antigravity worker settings isolated from host workspace trusts and Google One credit fallback.
await mkdir(join(home, '.gemini/antigravity-cli'), { recursive: true, mode: 0o700 })
await writeFile(join(home, '.gemini/antigravity-cli/settings.json'), JSON.stringify({ useG1Credits: false, enableTerminalSandbox: false, toolPermission: 'always-proceed' }), { mode: 0o600 })
// Copy the configured provider login, never host MCP, plugins, or commands.
const providerConfig = await readFile(join(source, '.config/opencode/opencode.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT')
    return '{}'
  throw error
})
const configured = (JSON.parse(providerConfig) as { providers?: Record<string, { settings?: { apiKey?: unknown } }> }).providers
const providers: Record<string, { settings: { apiKey: string } }> = {}
for (const id of ['zai-coding-plan', 'opencode-go']) {
  const apiKey = configured?.[id]?.settings?.apiKey
  if (typeof apiKey === 'string' && apiKey.trim() !== '')
    providers[id] = { settings: { apiKey } }
}
await mkdir(join(home, '.config/opencode'), { recursive: true, mode: 0o700 })
await writeFile(join(home, '.config/opencode/opencode.json'), JSON.stringify({ providers, plugins: ['./plugins/harlan-hooks.ts'] }), { mode: 0o600 })
await writeFile(join(home, '.gitconfig'), '[user]\n name = Harlan Agent Kit\n email = agent@harlanzw.com\n', { mode: 0o600 })
const codex = await realpath(values.codex!)
const opencode = await realpath(values.opencode!)
const agyCandidate = values.agy ?? join(source, '.local/bin/agy')
const agy = await realpath(agyCandidate).catch((error: NodeJS.ErrnoException) => {
  if (values.agy === undefined && error.code === 'ENOENT')
    return undefined
  throw error
})
const tools = [...new Set([...values['tool-dir'], dirname(codex), dirname(opencode), ...(agy === undefined ? [] : [dirname(agy)])])]
const config = values.config!
await mkdir(dirname(config), { recursive: true, mode: 0o700 })
await writeFile(config, JSON.stringify({ home, codex, opencode, ...(agy === undefined ? {} : { agy }), tools, readOnlyPaths: values['read-only'] }, null, 2), { mode: 0o600 })
process.stdout.write(`Agent worker configuration created: ${config}\n`)
process.stdout.write('Run the credential isolation smoke before restarting the Service.\n')
