#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export type CheckArgv = [string, ...string[]]
export interface CheckPlan {
  prerequisites: CheckArgv[]
  check: CheckArgv
  logDirectory: string
}
export type CheckOutcome = { _tag: 'Exited', exitCode: number } | { _tag: 'Signaled', signal: NodeJS.Signals }
export interface CheckCommandResult {
  argv: CheckArgv
  log: string
  outcome: CheckOutcome
}

function isArgv(input: unknown): input is CheckArgv {
  return Array.isArray(input) && input.length > 0
    && input.every(value => typeof value === 'string' && !value.includes('\0'))
    && input[0] !== ''
}

export function parseCheckPlan(input: unknown): { _tag: 'Ok', value: CheckPlan } | { _tag: 'Err', reason: string } {
  if (typeof input !== 'object' || input === null
    || !('prerequisites' in input) || !Array.isArray(input.prerequisites) || !input.prerequisites.every(isArgv)
    || !('check' in input) || !isArgv(input.check)
    || !('logDirectory' in input) || typeof input.logDirectory !== 'string' || input.logDirectory === '' || input.logDirectory.includes('\0')) {
    return { _tag: 'Err', reason: 'Set prerequisites, check argv, and logDirectory in the JSON plan.' }
  }
  return { _tag: 'Ok', value: { prerequisites: input.prerequisites, check: input.check, logDirectory: input.logDirectory } }
}

export async function runCheckPlan(plan: CheckPlan, cwd: string): Promise<{ commands: CheckCommandResult[], outcome: CheckOutcome }> {
  const base = resolve(cwd, plan.logDirectory)
  await mkdir(base, { recursive: true })
  const directory = await mkdtemp(join(base, 'check-'))
  const commands: CheckCommandResult[] = []
  for (const argv of [...plan.prerequisites, plan.check]) {
    const log = join(directory, `${commands.length + 1}.log`)
    const file = await open(log, 'wx', 0o600)
    const outcome = await new Promise<CheckOutcome>((resolveOutcome, reject) => {
      const child = spawn(argv[0], argv.slice(1), { cwd, shell: false, stdio: ['ignore', file.fd, file.fd] })
      child.once('error', reject)
      child.once('exit', (exitCode, signal) => {
        if (signal !== null)
          resolveOutcome({ _tag: 'Signaled', signal })
        else if (exitCode !== null)
          resolveOutcome({ _tag: 'Exited', exitCode })
        else
          reject(new Error('The check ended without an exit code or signal.'))
      })
    }).finally(() => file.close())
    commands.push({ argv, log, outcome })
    if (outcome._tag === 'Signaled' || outcome.exitCode !== 0)
      return { commands, outcome }
  }
  return { commands, outcome: { _tag: 'Exited', exitCode: 0 } }
}

async function main(): Promise<void> {
  const planPath = process.argv[2]
  if (planPath === undefined || process.argv.length !== 3)
    throw new Error('Usage: agent-check.ts <plan.json>')
  const parsed = parseCheckPlan(JSON.parse(await readFile(planPath, 'utf8')) as unknown)
  if (parsed._tag === 'Err')
    throw new Error(parsed.reason)
  const result = await runCheckPlan(parsed.value, process.cwd())
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.outcome._tag === 'Exited' ? result.outcome.exitCode : 1
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
