import type { ReviewProofLaunch, ReviewProofOutcome } from './review-proof.ts'
import { spawn } from 'node:child_process'
import process from 'node:process'

export interface ReviewProofProcess {
  binary: string
  arguments: string[]
  environment: NodeJS.ProcessEnv
  extraFileDescriptors?: readonly number[]
  release: () => Promise<void>
}

/** The preparation dependency supplies an isolated, read-only Node runtime. */
export function createReviewProofLauncher(prepare: (input: ReviewProofLaunch) => Promise<ReviewProofProcess>): (input: ReviewProofLaunch) => Promise<ReviewProofOutcome> {
  return async (input) => {
    const runtime = await prepare(input)
    let outcome: ReviewProofOutcome | undefined
    try {
      outcome = await new Promise<ReviewProofOutcome>((resolve, reject) => {
        const child = spawn(runtime.binary, runtime.arguments, { detached: true, cwd: input.workspace, env: runtime.environment, stdio: ['ignore', 'pipe', 'pipe', ...(runtime.extraFileDescriptors ?? [])] })
        let output = ''
        let timedOut = false
        const append = (chunk: string) => {
          output = `${output}${chunk}`.slice(-12_000)
        }
        child.stdout!.setEncoding('utf8')
        child.stderr!.setEncoding('utf8')
        child.stdout!.on('data', append)
        child.stderr!.on('data', append)
        const timer = setTimeout(() => {
          timedOut = true
          try {
            if (child.pid !== undefined)
              process.kill(-child.pid, 'SIGKILL')
          }
          catch (error) {
            // A completed process can disappear between the deadline and the signal.
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
              reject(error)
          }
        }, input.timeoutMilliseconds)
        child.once('error', (error) => {
          clearTimeout(timer)
          resolve({ _tag: 'LaunchFailed', reason: error.message })
        })
        child.once('close', (exitCode, signal) => {
          clearTimeout(timer)
          if (timedOut)
            resolve({ _tag: 'TimedOut', output })
          else if (signal !== null)
            resolve({ _tag: 'Signaled', signal, output })
          else
            resolve({ _tag: 'Exited', exitCode: exitCode ?? 1, output })
        })
      })
    }
    finally {
      await runtime.release().catch((error: unknown) => {
        if (outcome === undefined)
          throw error
        const warning = `\nReview proof cleanup failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1000)
        outcome = outcome._tag === 'LaunchFailed'
          ? { ...outcome, reason: `${outcome.reason}${warning}`.slice(-500) }
          : { ...outcome, output: `${outcome.output}${warning}`.slice(-12_000) }
      })
    }
    return outcome
  }
}
