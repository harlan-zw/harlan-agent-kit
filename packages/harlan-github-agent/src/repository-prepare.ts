import type { Result } from './result.ts'
import type { RepositoryMapping } from './types.ts'
import { spawn } from 'node:child_process'
import { delimiter, join } from 'node:path'
import process from 'node:process'
import { err, ok } from './result.ts'

/**
 * The repository's own prepare step, run once per task worktree.
 *
 * The Worktrunk pre-start hook installs `node_modules` and seeds ignored files,
 * but it disables lifecycle scripts and knows nothing about a repository's own
 * generated output. Every Repair and conflict session on a Nuxt workspace spent
 * its first minute on `nuxt prepare` and a dist build, and one spent 22 minutes
 * finding the script. The controller runs the mapped commands instead, before
 * any mutating Agent starts, so the Agent's first check already passes.
 */

export interface PrepareCommandRequest {
  /** One plain command, split on whitespace. Never a shell line. */
  argv: string[]
  cwd: string
  timeoutMilliseconds: number
  signal: AbortSignal
}

export type PrepareCommandOutcome
  = | { _tag: 'Exited', exitCode: number, outputTail: string[] }
    | { _tag: 'TimedOut', outputTail: string[] }
    /** The process never started, or died on a signal. */
    | { _tag: 'Failed', reason: string, outputTail: string[] }

export type PrepareCommandRunner = (request: PrepareCommandRequest) => Promise<PrepareCommandOutcome>

/** How many final output lines a failure keeps, oldest first. */
const OUTPUT_TAIL_LINES = 40

/** How long the runner waits after exit for the last buffered output. */
const OUTPUT_GRACE_MILLISECONDS = 500

export function repositoryPrepareCommands(mapping: RepositoryMapping): readonly string[] {
  return mapping.prepare.commands
}

/** One prompt line naming what already ran, or nothing when the repository lists no command. */
export function preparedCommandsLine(commands: readonly string[]): string {
  return commands.length === 0
    ? ''
    : `The repository prepare commands already ran in this worktree: ${commands.map(command => `\`${command}\``).join(', ')}. Do not run them again.\n`
}

function outputTailText(outputTail: string[]): string {
  return outputTail.length === 0 ? '' : `\n${outputTail.join('\n')}`
}

/**
 * Runs every mapped prepare command in order inside one task worktree.
 *
 * The first failure stops the run and names the command with its output tail,
 * so the Incident says what to fix without a person re-running it.
 */
export async function runRepositoryPrepare(
  mapping: RepositoryMapping,
  worktree: string,
  runner: PrepareCommandRunner,
  signal: AbortSignal,
): Promise<Result<void, string>> {
  const timeoutMilliseconds = mapping.prepare.timeoutSeconds * 1000
  for (const command of repositoryPrepareCommands(mapping)) {
    const outcome = await runner({ argv: command.split(/\s+/u), cwd: worktree, timeoutMilliseconds, signal })
    switch (outcome._tag) {
      case 'Exited':
        if (outcome.exitCode !== 0)
          return err(`Repository prepare command \`${command}\` exited with code ${outcome.exitCode}.${outputTailText(outcome.outputTail)}`)
        break
      case 'TimedOut':
        return err(`Repository prepare command \`${command}\` timed out after ${mapping.prepare.timeoutSeconds} seconds.${outputTailText(outcome.outputTail)}`)
      case 'Failed':
        return err(`Repository prepare command \`${command}\` failed: ${outcome.reason}${outputTailText(outcome.outputTail)}`)
    }
  }
  return ok(undefined)
}

/**
 * Runs one command the way `pnpm exec` would: the worktree's `node_modules/.bin`
 * leads PATH, lifecycle scripts stay enabled, and the Agent's own environment
 * carries through so a prepare step sees the same tokens the Agent will.
 */
export function createPrepareCommandRunner(environment: NodeJS.ProcessEnv = process.env): PrepareCommandRunner {
  return request => new Promise((resolve) => {
    const [command, ...args] = request.argv
    if (command === undefined) {
      resolve({ _tag: 'Failed', reason: 'The command is empty.', outputTail: [] })
      return
    }
    const binDirectory = join(request.cwd, 'node_modules', '.bin')
    const path = environment.PATH === undefined ? binDirectory : `${binDirectory}${delimiter}${environment.PATH}`
    const lines: string[] = []
    let pending = ''
    const collect = (chunk: Buffer) => {
      const text = pending + chunk.toString('utf8')
      const parts = text.split(/\r?\n/u)
      pending = parts.pop() ?? ''
      for (const part of parts) {
        if (part.trim().length > 0)
          lines.push(part)
      }
      if (lines.length > OUTPUT_TAIL_LINES)
        lines.splice(0, lines.length - OUTPUT_TAIL_LINES)
    }
    const outputTail = () => {
      if (pending.trim().length > 0)
        lines.push(pending)
      pending = ''
      return lines.slice(-OUTPUT_TAIL_LINES)
    }
    let timedOut = false
    let spawnError: string | null = null
    // The command leads its own process group. pnpm and nuxt wrappers spawn
    // worker processes, and killing only the direct child left those running
    // and writing into a worktree the controller had already given up on.
    const child = spawn(command, args, {
      cwd: request.cwd,
      detached: true,
      env: { ...environment, PATH: path },
      signal: request.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const killTree = () => {
      if (child.pid === undefined)
        return
      try {
        process.kill(-child.pid, 'SIGKILL')
      }
      catch {
        // The group is already gone. Nothing is left to kill.
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, request.timeoutMilliseconds)
    request.signal.addEventListener('abort', killTree, { once: true })
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    let settled = false
    let graceTimer: NodeJS.Timeout | null = null
    const settle = (code: number | null, killSignal: NodeJS.Signals | null) => {
      if (settled)
        return
      settled = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', killTree)
      if (graceTimer !== null)
        clearTimeout(graceTimer)
      // A pipe a grandchild still holds would otherwise stay open in the service.
      child.stdout.destroy()
      child.stderr.destroy()
      if (timedOut) {
        resolve({ _tag: 'TimedOut', outputTail: outputTail() })
        return
      }
      if (spawnError !== null) {
        resolve({ _tag: 'Failed', reason: spawnError, outputTail: outputTail() })
        return
      }
      if (code !== null) {
        resolve({ _tag: 'Exited', exitCode: code, outputTail: outputTail() })
        return
      }
      resolve({ _tag: 'Failed', reason: `The process died on ${killSignal ?? 'an unknown signal'}.`, outputTail: outputTail() })
    }
    // `close` waits for both pipes to end. A prepare step that leaves a daemon
    // behind, or a sandbox that holds the pipe, would then never settle, so
    // `exit` starts a short grace for the last buffered output instead.
    child.on('exit', (code, killSignal) => {
      graceTimer = setTimeout(settle, OUTPUT_GRACE_MILLISECONDS, code, killSignal)
    })
    child.on('close', settle)
    child.on('error', (error: Error) => {
      spawnError = error.message
      // A process that never started emits no exit, so settle here.
      if (child.pid === undefined)
        settle(null, null)
    })
  })
}
