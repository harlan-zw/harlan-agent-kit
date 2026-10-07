#!/usr/bin/env -S node --experimental-strip-types
import { chmod, cp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  'source-home': { type: 'string' },
  'worker-home': { type: 'string' },
  'config': { type: 'string' },
  'codex': { type: 'string' },
  'opencode': { type: 'string' },
  'tool-dir': { type: 'string', multiple: true, default: [] },
  'read-only': { type: 'string', multiple: true, default: [] },
} })
for (const key of ['source-home', 'worker-home', 'config', 'codex', 'opencode'] as const) {
  if (!values[key] || !isAbsolute(values[key]))
    throw new Error(`Provide an absolute --${key} path.`)
}
const source = values['source-home']!
const home = values['worker-home']!
await mkdir(home, { recursive: true, mode: 0o700 })
const paths = [
  '.codex/auth.json',
  '.local/share/opencode/auth.json',
  '.config/harlan-agent-kit/github-public-token',
  '.config/git/hooks',
  '.local/share/harlan-agent-kit/github-bin',
  '.codex/AGENTS.md',
  '.local/share/harlan-agent-kit/skilld/skills',
  '.agents/skills',
  '.local/share/harlan-agent-kit/hooks',
  '.local/share/harlan-agent-kit/.claude-plugin/plugin.json',
  '.config/opencode/plugins/harlan-hooks.ts',
]
for (const path of paths) {
  const destination = join(home, path)
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await cp(join(source, path), destination, { recursive: true, dereference: true, preserveTimestamps: true }).catch((error: NodeJS.ErrnoException) => {
    // A host may use only one provider. Its missing login is not copied.
    if (error.code !== 'ENOENT')
      throw error
  })
  if (path.endsWith('/auth.json') || path.endsWith('/github-public-token')) {
    await chmod(destination, 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw error
    })
  }
}
// Copy the configured provider login, never host MCP, plugins, or commands.
const providerConfig = await readFile(join(source, '.config/opencode/opencode.json'), 'utf8').catch((error: NodeJS.ErrnoException) => {
  if (error.code === 'ENOENT')
    return '{}'
  throw error
})
const provider = (JSON.parse(providerConfig) as { provider?: Record<string, { options?: { apiKey?: unknown } }> }).provider
const apiKey = provider?.['zai-coding-plan']?.options?.apiKey
if (typeof apiKey === 'string' && apiKey.trim() !== '') {
  await mkdir(join(home, '.config/opencode'), { recursive: true, mode: 0o700 })
  await writeFile(join(home, '.config/opencode/opencode.json'), JSON.stringify({ provider: { 'zai-coding-plan': { options: { apiKey } } } }), { mode: 0o600 })
}
await writeFile(join(home, '.gitconfig'), '[user]\n name = Harlan Agent Kit\n email = agent@harlanzw.com\n', { mode: 0o600 })
const codex = await realpath(values.codex!)
const opencode = await realpath(values.opencode!)
const tools = [...new Set([...values['tool-dir'], dirname(codex), dirname(opencode)])]
const config = values.config!
await mkdir(dirname(config), { recursive: true, mode: 0o700 })
await writeFile(config, JSON.stringify({ home, codex, opencode, tools, readOnlyPaths: values['read-only'] }, null, 2), { mode: 0o600 })
process.stdout.write(`Agent worker configuration created: ${config}\n`)
process.stdout.write('Run the credential isolation smoke before restarting the Service.\n')
