#!/usr/bin/env -S node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { planAgentCli } from './agent-cli-plan.ts'

const home = homedir()
const checkout = process.env.WOLFSTAR_GITHUB_AGENT_CHECKOUT ?? join(home, '.local/share/wolfstar-github-agent/service')
const pinnedRuntime = join(home, '.local/lib/wolfstar-github-agent/node')
const runtime = existsSync(pinnedRuntime) ? pinnedRuntime : process.execPath
const urlFile = join(home, '.config/wolfstar-github-agent/control-url')
const url =
  process.env.WOLFSTAR_GITHUB_AGENT_URL ?? (existsSync(urlFile) ? readFileSync(urlFile, 'utf8').trim() : undefined)
const plan = planAgentCli({
  home,
  hostname: hostname(),
  executable: process.argv[1] ?? 'wolfstar-github-agent',
  runtime,
  checkout,
  args: process.argv.slice(2),
  cwd: process.cwd(),
  url,
})
const child = spawn(plan.file, plan.args, { cwd: plan.cwd, stdio: 'inherit' })
child.on('error', (error) => {
  console.error(`Agent command failed: ${error.message}`)
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})
process.on('SIGINT', () => child.kill('SIGINT'))
process.on('SIGTERM', () => child.kill('SIGTERM'))
