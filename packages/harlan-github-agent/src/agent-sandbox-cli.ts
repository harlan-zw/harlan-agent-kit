#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// The SDK needs an executable, not a command prefix. This trusted adapter runs
// before any model tool exists, then puts the Codex process inside the boundary.
// The private sibling file avoids Linux's per-environment-entry size limit.
// It contains command paths and arguments. Guest credentials never enter it.
const descriptor = openSync(`${fileURLToPath(import.meta.url)}.json`, constants.O_RDONLY | constants.O_NOFOLLOW)
let plan: unknown
try {
  const metadata = fstatSync(descriptor)
  if (!metadata.isFile() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077) !== 0 || metadata.size > 1024 * 1024)
    throw new Error('The Codex Agent sandbox launch plan must be a bounded private file.')
  plan = JSON.parse(readFileSync(descriptor, 'utf8'))
}
finally {
  closeSync(descriptor)
}
if (plan === null || typeof plan !== 'object' || !('binary' in plan) || !('args' in plan))
  throw new Error('The Codex Agent sandbox launch plan is invalid.')
const binary = plan.binary
const value = plan.args
if ((binary !== '/usr/bin/bwrap' && binary !== '/usr/bin/systemd-run') || !Array.isArray(value) || !value.every(item => typeof item === 'string' && !item.includes('\0')))
  throw new Error('The Codex Agent sandbox launch plan is invalid.')
const environment: NodeJS.ProcessEnv = JSON.parse(process.env.HARLAN_AGENT_SANDBOX_ENV ?? 'null')
if (environment === null || typeof environment !== 'object')
  throw new Error('The Codex Agent sandbox environment is missing.')
const commandArguments = process.argv.slice(2)
const schemaIndex = commandArguments.indexOf('--output-schema')
if (schemaIndex !== -1) {
  const schemaPath = commandArguments[schemaIndex + 1]
  if (!schemaPath || !statSync(schemaPath).isFile())
    throw new Error('The Codex output schema must be a regular file.')
  const separator = value.indexOf('--')
  if (separator === -1)
    throw new Error('The Codex sandbox command separator is missing.')
  value.splice(separator, 0, '--ro-bind', realpathSync(schemaPath), schemaPath)
}
const child = spawn(binary, [...value, ...commandArguments], { env: environment, stdio: 'inherit' })
child.once('error', (error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', (code) => {
  process.exitCode = code ?? 1
})
process.once('SIGTERM', () => child.kill('SIGTERM'))
process.once('SIGINT', () => child.kill('SIGINT'))
