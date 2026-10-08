#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import process from 'node:process'

// The SDK needs an executable, not a command prefix. This trusted adapter runs
// before any model tool exists, then puts the Codex process inside the boundary.
const value: unknown = JSON.parse(process.env.HARLAN_AGENT_SANDBOX_ARGS ?? 'null')
if (!Array.isArray(value) || !value.every(item => typeof item === 'string'))
  throw new Error('The Codex Agent sandbox arguments are missing.')
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
const binary = process.env.HARLAN_AGENT_SANDBOX_BINARY
if (binary !== '/usr/bin/bwrap' && binary !== '/usr/bin/systemd-run')
  throw new Error('The Codex Agent sandbox executable is invalid.')
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
